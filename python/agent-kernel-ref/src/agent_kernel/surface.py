from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .events import SessionEvent
from .types import Message, ToolCall

PROJECTABLE = {
    "user/message",
    "assistant/message",
    "tool/result",
    "request/context",
    "compaction/summary",
}


@dataclass(frozen=True)
class SurfaceItem:
    seq: int
    message: Message


class SurfaceProjector:
    """Derives the model-visible surface while preserving immutable underlying history."""

    def derive(self, events: Iterable[SessionEvent]) -> tuple[SurfaceItem, ...]:
        by_seq: dict[int, SessionEvent] = {}
        visible: list[int] = []
        replacements: list[tuple[list[int], int]] = []

        for event in events:
            by_seq[event.seq] = event
            if event.type in PROJECTABLE:
                visible.append(event.seq)
            elif event.type == "surface/replace":
                replacements.append(
                    ([int(x) for x in event.data["shadowed_seqs"]], int(event.data["replacement_seq"]))
                )

        for shadowed, replacement in replacements:
            shadow_set = set(shadowed)
            positions = [i for i, seq in enumerate(visible) if seq in shadow_set]
            visible = [seq for seq in visible if seq not in shadow_set and seq != replacement]
            insert_at = min(positions) if positions else len(visible)
            visible.insert(min(insert_at, len(visible)), replacement)

        output: list[SurfaceItem] = []
        for seq in visible:
            event = by_seq.get(seq)
            if event is None:
                continue
            message = self._event_to_message(event)
            if message is not None:
                output.append(SurfaceItem(seq, message))
        return tuple(output)

    def messages(self, events: Iterable[SessionEvent]) -> tuple[Message, ...]:
        return tuple(item.message for item in self.derive(events))

    @staticmethod
    def _event_to_message(event: SessionEvent) -> Message | None:
        data = event.data
        if event.type == "user/message":
            return Message("user", str(data["content"]))
        if event.type == "request/context":
            return Message("user", f"<runtime-context>\n{data['content']}\n</runtime-context>")
        if event.type == "compaction/summary":
            return Message("user", f"<compacted-summary>\n{data['content']}\n</compacted-summary>")
        if event.type == "assistant/message":
            calls = tuple(
                ToolCall(c["id"], c["name"], dict(c.get("arguments", {})))
                for c in data.get("tool_calls", [])
            )
            return Message("assistant", str(data.get("content", "")), tool_calls=calls)
        if event.type == "tool/result":
            return Message(
                "tool",
                str(data.get("content", "")),
                name=str(data.get("name", "")),
                tool_call_id=str(data.get("call_id", "")),
            )
        return None
