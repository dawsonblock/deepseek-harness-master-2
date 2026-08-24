from __future__ import annotations

from dataclasses import dataclass, asdict

from .events import EventLedger


@dataclass(frozen=True)
class SessionMetrics:
    turns: int = 0
    steps: int = 0
    model_attempts: int = 0
    model_responses: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    tool_planned: int = 0
    tool_dispatched: int = 0
    tool_results: int = 0
    tool_errors: int = 0
    tool_reused: int = 0
    retries: int = 0
    compactions: int = 0
    compaction_shadowed_events: int = 0
    goal_verifications: int = 0
    goal_passes: int = 0
    request_header_changes: int = 0
    unique_request_headers: int = 0
    elapsed_ms: float = 0.0

    @property
    def cache_ratio(self) -> float:
        if self.input_tokens <= 0:
            return 0.0
        return min(1.0, max(0.0, self.cached_input_tokens / self.input_tokens))

    @property
    def tool_error_rate(self) -> float:
        if self.tool_results <= 0:
            return 0.0
        return self.tool_errors / self.tool_results

    def to_dict(self) -> dict:
        data = asdict(self)
        data["cache_ratio"] = self.cache_ratio
        data["tool_error_rate"] = self.tool_error_rate
        return data


def derive_session_metrics(ledger: EventLedger, session_id: str) -> SessionMetrics:
    events = ledger.events(session_id)
    if not events:
        return SessionMetrics()

    counters = {
        "turns": 0,
        "steps": 0,
        "model_attempts": 0,
        "model_responses": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cached_input_tokens": 0,
        "tool_planned": 0,
        "tool_dispatched": 0,
        "tool_results": 0,
        "tool_errors": 0,
        "tool_reused": 0,
        "retries": 0,
        "compactions": 0,
        "compaction_shadowed_events": 0,
        "goal_verifications": 0,
        "goal_passes": 0,
        "request_header_changes": 0,
    }
    header_hashes: set[str] = set()

    for event in events:
        t = event.type
        if t == "turn/start":
            counters["turns"] += 1
        elif t == "step/start":
            counters["steps"] += 1
        elif t == "model/request":
            counters["model_attempts"] += 1
        elif t == "model/response":
            counters["model_responses"] += 1
        elif t == "assistant/message":
            usage = dict(event.data.get("usage", {}))
            counters["input_tokens"] += int(usage.get("input_tokens", 0) or 0)
            counters["output_tokens"] += int(usage.get("output_tokens", 0) or 0)
            counters["cached_input_tokens"] += int(usage.get("cached_input_tokens", 0) or 0)
        elif t == "tool/planned":
            counters["tool_planned"] += 1
        elif t == "tool/call":
            counters["tool_dispatched"] += 1
        elif t == "tool/result":
            counters["tool_results"] += 1
            if bool(event.data.get("is_error", False)):
                counters["tool_errors"] += 1
        elif t == "tool/reused":
            counters["tool_reused"] += 1
        elif t == "retry":
            counters["retries"] += 1
        elif t == "compaction/end":
            counters["compactions"] += 1
            counters["compaction_shadowed_events"] += int(event.data.get("shadowed_count", 0) or 0)
        elif t == "goal/verification":
            counters["goal_verifications"] += 1
            if bool(event.data.get("passed", False)):
                counters["goal_passes"] += 1
        elif t == "request/header":
            counters["request_header_changes"] += 1
            value = str(event.data.get("hash", ""))
            if value:
                header_hashes.add(value)

    elapsed_ms = max(0.0, (events[-1].ts_ns - events[0].ts_ns) / 1_000_000.0)
    return SessionMetrics(
        **counters,
        unique_request_headers=len(header_hashes),
        elapsed_ms=elapsed_ms,
    )
