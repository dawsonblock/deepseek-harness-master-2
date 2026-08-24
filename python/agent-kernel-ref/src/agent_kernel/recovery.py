from __future__ import annotations

from dataclasses import dataclass

from .events import EventLedger, SessionEvent
from .types import ToolCall


@dataclass(frozen=True)
class IncompleteToolCall:
    call_id: str
    name: str
    arguments: dict
    idempotency_key: str
    state: str
    safe_to_retry: bool
    seq: int


def find_incomplete_tool_calls(
    ledger: EventLedger, session_id: str
) -> tuple[IncompleteToolCall, ...]:
    planned: dict[str, SessionEvent] = {}
    dispatched: dict[str, SessionEvent] = {}
    completed: set[str] = set()

    for event in ledger.events(session_id):
        if event.type == "tool/planned":
            planned[str(event.data["call_id"])] = event
        elif event.type == "tool/call":
            dispatched[str(event.data["call_id"])] = event
        elif event.type == "tool/result":
            completed.add(str(event.data["call_id"]))

    # Backward compatibility with v0.1 ledgers that only recorded tool/call.
    all_ids = set(planned) | set(dispatched)
    output: list[IncompleteToolCall] = []

    for call_id in all_ids:
        if call_id in completed:
            continue

        plan = planned.get(call_id)
        dispatch = dispatched.get(call_id)
        source = dispatch or plan
        assert source is not None

        if dispatch is None:
            state = "NOT_STARTED"
        else:
            state = "OUTCOME_UNKNOWN"

        idempotent = bool(source.data.get("idempotent", False))
        safe_to_retry = state == "NOT_STARTED" or idempotent

        output.append(
            IncompleteToolCall(
                call_id=call_id,
                name=str(source.data["name"]),
                arguments=dict(source.data.get("arguments", {})),
                idempotency_key=str(source.data.get("idempotency_key", call_id)),
                state=state,
                safe_to_retry=safe_to_retry,
                seq=source.seq,
            )
        )

    return tuple(sorted(output, key=lambda item: item.seq))


def retryable_tool_calls(ledger: EventLedger, session_id: str) -> tuple[ToolCall, ...]:
    return tuple(
        ToolCall(item.call_id, item.name, dict(item.arguments))
        for item in find_incomplete_tool_calls(ledger, session_id)
        if item.safe_to_retry
    )


def record_recovery_scan(
    ledger: EventLedger, session_id: str
) -> tuple[IncompleteToolCall, ...]:
    items = find_incomplete_tool_calls(ledger, session_id)
    for item in items:
        ledger.append(
            session_id,
            "tool/recovery",
            {
                "call_id": item.call_id,
                "name": item.name,
                "arguments": item.arguments,
                "idempotency_key": item.idempotency_key,
                "state": item.state,
                "safe_to_retry": item.safe_to_retry,
            },
        )
    return items
