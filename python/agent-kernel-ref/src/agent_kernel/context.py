from __future__ import annotations

from dataclasses import dataclass

from .events import EventLedger
from .surface import SurfaceItem, SurfaceProjector
from .types import Message, ModelClient, ModelRequest, RequestHeader


@dataclass(frozen=True)
class CompactionConfig:
    context_window: int
    threshold_ratio: float = 0.80
    retain_ratio: float = 0.16
    max_summary_tokens: int = 8192
    tool_prune_threshold_chars: int = 8192
    tool_prune_head_chars: int = 4096
    tool_prune_tail_chars: int = 1024

    def __post_init__(self) -> None:
        if self.context_window <= 0:
            raise ValueError("context_window must be positive")
        if not 0 < self.retain_ratio < self.threshold_ratio < 1:
            raise ValueError("require 0 < retain_ratio < threshold_ratio < 1")

    @property
    def threshold_tokens(self) -> int:
        return int(self.context_window * self.threshold_ratio)

    @property
    def retain_tokens(self) -> int:
        return int(self.context_window * self.retain_ratio)


class TokenMeter:
    """Fallback estimator; replace with the provider tokenizer in production."""

    @staticmethod
    def text_tokens(text: str) -> int:
        return max(1, (len(text) + 3) // 4)

    def message_tokens(self, message: Message) -> int:
        total = 4 + self.text_tokens(message.content)
        if message.name:
            total += self.text_tokens(message.name)
        if message.tool_call_id:
            total += self.text_tokens(message.tool_call_id)
        for call in message.tool_calls:
            total += self.text_tokens(call.name) + self.text_tokens(str(call.arguments)) + 8
        return total

    def messages_tokens(self, messages: tuple[Message, ...]) -> int:
        return sum(self.message_tokens(message) for message in messages)


class ToolOutputPruner:
    def __init__(self, config: CompactionConfig) -> None:
        self.config = config

    def prune(self, message: Message) -> Message:
        if message.role != "tool" or len(message.content) <= self.config.tool_prune_threshold_chars:
            return message
        text = message.content
        pruned = (
            text[: self.config.tool_prune_head_chars]
            + "\n\n[... tool result middle pruned ...]\n\n"
            + text[-self.config.tool_prune_tail_chars :]
        )
        return Message(
            message.role,
            pruned,
            name=message.name,
            tool_call_id=message.tool_call_id,
            tool_calls=message.tool_calls,
        )

    def apply(self, items: tuple[SurfaceItem, ...]) -> tuple[SurfaceItem, ...]:
        return tuple(SurfaceItem(item.seq, self.prune(item.message)) for item in items)


SUMMARY_INSTRUCTION = """
Create a precise continuation checkpoint for the conversation above.
Preserve exact technical facts needed to continue the work. Do not add new conclusions.
Use these headings:
Primary Objective
Current State
Decisions / Invariants
Evidence
Files / Artifacts
Tool Results
Errors / Failed Approaches
Memory References
Active Hypotheses
Pending Work
Current Execution Point
Next Action
Verification Required
Critical Constraints
Preserve exact paths, commands, identifiers, numerical values, signatures, error messages,
and acceptance criteria when they matter. Prefer compact factual bullets over narrative.
""".strip()


class ContextController:
    def __init__(
        self,
        ledger: EventLedger,
        projector: SurfaceProjector,
        model: ModelClient,
        config: CompactionConfig,
        token_meter: TokenMeter | None = None,
    ) -> None:
        self.ledger = ledger
        self.projector = projector
        self.model = model
        self.config = config
        self.meter = token_meter or TokenMeter()
        self.pruner = ToolOutputPruner(config)

    def visible_items(self, session_id: str, prune: bool = True) -> tuple[SurfaceItem, ...]:
        items = self.projector.derive(self.ledger.events(session_id))
        return self.pruner.apply(items) if prune else items

    def visible_messages(self, session_id: str, prune: bool = True) -> tuple[Message, ...]:
        return tuple(item.message for item in self.visible_items(session_id, prune=prune))

    def pressure(self, session_id: str) -> int:
        return self.meter.messages_tokens(self.visible_messages(session_id, prune=True))

    async def compact_if_needed(self, session_id: str, header: RequestHeader) -> bool:
        if self.pressure(session_id) < self.config.threshold_tokens:
            return False
        return await self.compact(session_id, header)

    async def compact(self, session_id: str, header: RequestHeader) -> bool:
        items = self.visible_items(session_id, prune=True)
        if len(items) < 3:
            return False

        retained_tokens = 0
        split = len(items)
        for i in range(len(items) - 1, -1, -1):
            cost = self.meter.message_tokens(items[i].message)
            if retained_tokens + cost > self.config.retain_tokens:
                break
            retained_tokens += cost
            split = i
        split = min(split, len(items) - 1)

        # Never leave a tool result in the retained tail without the assistant
        # message that issued its tool call. This keeps provider transcripts valid.
        while split > 0 and items[split].message.role == "tool":
            split -= 1

        region = items[:split]
        if not region:
            return False

        pressure_before = self.pressure(session_id)
        self.ledger.append(
            session_id,
            "compaction/start",
            {
                "shadowed_seqs": [item.seq for item in region],
                "estimated_tokens": self.meter.messages_tokens(tuple(item.message for item in region)),
                "pressure_tokens": pressure_before,
                "threshold_tokens": self.config.threshold_tokens,
                "retain_tokens": self.config.retain_tokens,
            },
        )

        summary_header = RequestHeader(
            provider=header.provider,
            model=header.model,
            system=header.system,
            tools=header.tools,
            reasoning_effort=header.reasoning_effort,
            max_tokens=min(header.max_tokens or self.config.max_summary_tokens, self.config.max_summary_tokens),
        )
        summary_messages = tuple(item.message for item in region) + (
            Message("user", SUMMARY_INSTRUCTION),
        )
        response = await self.model.generate(ModelRequest(summary_header, summary_messages))
        summary = response.content.strip()
        if not summary:
            self.ledger.append(session_id, "compaction/error", {"message": "empty summary"})
            return False

        summary_event = self.ledger.append(session_id, "compaction/summary", {"content": summary})
        self.ledger.append(
            session_id,
            "surface/replace",
            {
                "shadowed_seqs": [item.seq for item in region],
                "replacement_seq": summary_event.seq,
            },
        )
        pressure_after = self.pressure(session_id)
        self.ledger.append(
            session_id,
            "compaction/end",
            {
                "replacement_seq": summary_event.seq,
                "shadowed_count": len(region),
                "before_tokens": pressure_before,
                "after_tokens": pressure_after,
                "tokens_saved": max(0, pressure_before - pressure_after),
            },
        )
        return True
