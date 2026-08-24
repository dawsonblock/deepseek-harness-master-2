from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Iterable

from .events import EventLedger
from .types import ToolCall, ToolContext, ToolDefinition, ToolResult


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, tool: ToolDefinition) -> None:
        if tool.name in self._tools:
            raise ValueError(f"tool already registered: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolDefinition:
        try:
            return self._tools[name]
        except KeyError as exc:
            raise KeyError(f"unknown tool: {name}") from exc

    def definitions(self) -> tuple[ToolDefinition, ...]:
        return tuple(sorted(self._tools.values(), key=lambda tool: tool.name))


@dataclass(frozen=True)
class ScheduledResult:
    call: ToolCall
    result: ToolResult


@dataclass(frozen=True)
class _ExecutionOutcome:
    result: ToolResult
    idempotency_key: str
    reused: bool = False


class ToolScheduler:
    """Parallelize only explicit safe calls, barrier mutations, commit in model order.

    v0.2 hardening adds a durable lifecycle:

        PLANNED -> DISPATCHED -> COMPLETED | FAILED

    A crash after PLANNED but before DISPATCHED is safely retryable. A crash after
    DISPATCHED but before a durable result is OUTCOME_UNKNOWN. Idempotent calls can
    also reuse a previously completed result for the same deterministic key.
    """

    def __init__(self, ledger: EventLedger, registry: ToolRegistry, max_parallel: int = 10) -> None:
        if max_parallel < 1:
            raise ValueError("max_parallel must be >= 1")
        self.ledger = ledger
        self.registry = registry
        self.max_parallel = max_parallel

    @staticmethod
    def _idempotency_key(session_id: str, turn: int, step: int, call: ToolCall) -> str:
        return f"{session_id}:{turn}:{step}:{call.id}"

    def _plan(self, session_id: str, turn: int, step: int, call: ToolCall) -> str:
        tool = self.registry.get(call.name)
        key = self._idempotency_key(session_id, turn, step, call)
        self.ledger.append(
            session_id,
            "tool/planned",
            {
                "turn": turn,
                "step": step,
                "call_id": call.id,
                "name": call.name,
                "arguments": call.arguments,
                "state": "PLANNED",
                "idempotency_key": key,
                "idempotent": tool.idempotent,
            },
        )
        return key

    def _completed_for_key(self, session_id: str, key: str) -> ToolResult | None:
        for event in reversed(self.ledger.events(session_id)):
            if event.type != "tool/result":
                continue
            if str(event.data.get("idempotency_key", "")) != key:
                continue
            if bool(event.data.get("is_error", False)):
                continue
            return ToolResult(
                call_id=str(event.data["call_id"]),
                name=str(event.data["name"]),
                content=str(event.data.get("content", "")),
                is_error=False,
                concludes_turn=bool(event.data.get("concludes_turn", False)),
                additional_contexts=tuple(str(x) for x in event.data.get("additional_contexts", [])),
            )
        return None

    async def execute(
        self, session_id: str, turn: int, step: int, calls: Iterable[ToolCall]
    ) -> tuple[ScheduledResult, ...]:
        calls = tuple(calls)
        keys = {call.id: self._plan(session_id, turn, step, call) for call in calls}
        committed: list[ScheduledResult] = []
        i = 0
        while i < len(calls):
            first = calls[i]
            if self.registry.get(first.name).mode_for(first.arguments) == "exclusive":
                outcome = await self._execute_one(session_id, turn, step, first, keys[first.id])
                self._commit_result(session_id, turn, step, first, outcome)
                committed.append(ScheduledResult(first, outcome.result))
                i += 1
                continue

            group: list[ToolCall] = []
            j = i
            while j < len(calls):
                call = calls[j]
                if self.registry.get(call.name).mode_for(call.arguments) != "parallel":
                    break
                group.append(call)
                j += 1

            outcomes = await self._parallel_group(session_id, turn, step, group, keys)
            for call, outcome in zip(group, outcomes, strict=True):
                self._commit_result(session_id, turn, step, call, outcome)
                committed.append(ScheduledResult(call, outcome.result))
            i = j
        return tuple(committed)

    async def _parallel_group(
        self,
        session_id: str,
        turn: int,
        step: int,
        calls: list[ToolCall],
        keys: dict[str, str],
    ) -> list[_ExecutionOutcome]:
        semaphore = asyncio.Semaphore(self.max_parallel)

        async def run(call: ToolCall) -> _ExecutionOutcome:
            async with semaphore:
                return await self._execute_one(session_id, turn, step, call, keys[call.id])

        return list(await asyncio.gather(*(run(call) for call in calls)))

    async def _execute_one(
        self, session_id: str, turn: int, step: int, call: ToolCall, idempotency_key: str
    ) -> _ExecutionOutcome:
        tool = self.registry.get(call.name)

        if tool.idempotent:
            previous = self._completed_for_key(session_id, idempotency_key)
            if previous is not None:
                reused = ToolResult(
                    call_id=call.id,
                    name=call.name,
                    content=previous.content,
                    is_error=False,
                    concludes_turn=previous.concludes_turn,
                    additional_contexts=previous.additional_contexts,
                )
                self.ledger.append(
                    session_id,
                    "tool/reused",
                    {
                        "turn": turn,
                        "step": step,
                        "call_id": call.id,
                        "name": call.name,
                        "idempotency_key": idempotency_key,
                    },
                )
                return _ExecutionOutcome(reused, idempotency_key, reused=True)

        self.ledger.append(
            session_id,
            "tool/call",
            {
                "turn": turn,
                "step": step,
                "call_id": call.id,
                "name": call.name,
                "arguments": call.arguments,
                "state": "DISPATCHED",
                "idempotency_key": idempotency_key,
                "idempotent": tool.idempotent,
            },
        )
        context = ToolContext(session_id, turn, step, call.id)
        try:
            result = await tool.handler(call.arguments, context)
            if result.call_id != call.id or result.name != call.name:
                raise RuntimeError("tool returned mismatched call_id/name")
            return _ExecutionOutcome(result, idempotency_key)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            result = ToolResult(call.id, call.name, f"{type(exc).__name__}: {exc}", is_error=True)
            return _ExecutionOutcome(result, idempotency_key)

    def _commit_result(
        self,
        session_id: str,
        turn: int,
        step: int,
        call: ToolCall,
        outcome: _ExecutionOutcome,
    ) -> None:
        result = outcome.result
        self.ledger.append(
            session_id,
            "tool/result",
            {
                "turn": turn,
                "step": step,
                "call_id": call.id,
                "name": call.name,
                "content": result.content,
                "is_error": result.is_error,
                "concludes_turn": result.concludes_turn,
                "additional_contexts": list(result.additional_contexts),
                "state": "FAILED" if result.is_error else "COMPLETED",
                "idempotency_key": outcome.idempotency_key,
                "reused": outcome.reused,
            },
        )
        for context in result.additional_contexts:
            self.ledger.append(
                session_id,
                "request/context",
                {"content": context, "source": f"tool:{call.name}"},
            )
