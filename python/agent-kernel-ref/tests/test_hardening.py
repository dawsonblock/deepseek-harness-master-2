from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_kernel import (
    AgentKernel,
    CompactionConfig,
    ContextController,
    EventLedger,
    GoalStore,
    RetryPolicy,
    RuleVerifier,
    SurfaceProjector,
    TokenMeter,
    ToolRegistry,
    ToolScheduler,
    TransientModelError,
    derive_session_metrics,
    find_incomplete_tool_calls,
)
from agent_kernel.types import (
    Goal,
    Message,
    ModelRequest,
    ModelResponse,
    ModelUsage,
    RequestHeader,
    ToolCall,
    ToolDefinition,
    ToolResult,
)


class ScriptedModel:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests: list[ModelRequest] = []

    async def generate(self, request: ModelRequest) -> ModelResponse:
        self.requests.append(request)
        if not self.responses:
            return ModelResponse(content="done")
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        if callable(item):
            return item(request)
        return item


def test_goal_store_rehydrates_from_ledger(tmp_path: Path):
    db = tmp_path / "events.sqlite"
    ledger = EventLedger(db)
    store = GoalStore(ledger)
    goal = Goal(
        id="g1",
        objective="ship it",
        acceptance_criteria=("tests pass",),
        max_rounds=3,
        rounds_started=2,
        evidence=["pytest passed"],
    )
    store.create("s", goal)
    ledger.close()

    reopened = EventLedger(db)
    restored = GoalStore(reopened).get("s", "g1")
    assert restored.objective == "ship it"
    assert restored.rounds_started == 2
    assert restored.acceptance_criteria == ("tests pass",)
    assert restored.evidence == ["pytest passed"]


def test_recovery_distinguishes_not_started_and_unknown():
    ledger = EventLedger()
    base = {
        "turn": 1,
        "step": 1,
        "name": "write",
        "arguments": {"x": 1},
        "idempotency_key": "k",
        "idempotent": False,
    }
    ledger.append("s", "tool/planned", {**base, "call_id": "planned", "state": "PLANNED"})
    ledger.append("s", "tool/planned", {**base, "call_id": "sent", "state": "PLANNED"})
    ledger.append("s", "tool/call", {**base, "call_id": "sent", "state": "DISPATCHED"})

    items = {item.call_id: item for item in find_incomplete_tool_calls(ledger, "s")}
    assert items["planned"].state == "NOT_STARTED"
    assert items["planned"].safe_to_retry is True
    assert items["sent"].state == "OUTCOME_UNKNOWN"
    assert items["sent"].safe_to_retry is False


@pytest.mark.asyncio
async def test_idempotent_tool_reuses_completed_result():
    ledger = EventLedger()
    registry = ToolRegistry()
    executions = 0

    async def handler(args, ctx):
        nonlocal executions
        executions += 1
        return ToolResult(ctx.call_id, "readish", "same-result")

    registry.register(
        ToolDefinition(
            "readish",
            "safe read",
            {"type": "object"},
            handler,
            "parallel",
            True,
        )
    )
    scheduler = ToolScheduler(ledger, registry)
    call = ToolCall("c1", "readish", {})

    first = await scheduler.execute("s", 1, 1, (call,))
    second = await scheduler.execute("s", 1, 1, (call,))

    assert first[0].result.content == "same-result"
    assert second[0].result.content == "same-result"
    assert executions == 1
    assert any(event.type == "tool/reused" for event in ledger.events("s"))


@pytest.mark.asyncio
async def test_compaction_boundary_does_not_leave_orphan_tool_result():
    ledger = EventLedger()
    projector = SurfaceProjector()
    model = ScriptedModel([ModelResponse(content="checkpoint")])
    controller = ContextController(
        ledger,
        projector,
        model,
        CompactionConfig(context_window=80, threshold_ratio=0.5, retain_ratio=0.2),
        TokenMeter(),
    )

    ledger.append("s", "user/message", {"content": "old " * 30})
    ledger.append(
        "s",
        "assistant/message",
        {
            "content": "",
            "tool_calls": [{"id": "tc", "name": "read", "arguments": {}}],
        },
    )
    ledger.append("s", "tool/result", {"call_id": "tc", "name": "read", "content": "result " * 20})
    ledger.append("s", "user/message", {"content": "newest"})

    ok = await controller.compact(
        "s",
        RequestHeader(provider="p", model="m", system="sys", tools=()),
    )
    assert ok
    visible = controller.visible_messages("s", prune=False)

    # A visible tool result must have its assistant tool-call message visible before it.
    seen_calls: set[str] = set()
    for message in visible:
        for call in message.tool_calls:
            seen_calls.add(call.id)
        if message.role == "tool":
            assert message.tool_call_id in seen_calls


@pytest.mark.asyncio
async def test_kernel_records_model_retry_and_metrics():
    ledger = EventLedger()
    registry = ToolRegistry()
    model = ScriptedModel(
        [
            TransientModelError("temporary"),
            ModelResponse(
                content="ok",
                usage=ModelUsage(input_tokens=100, output_tokens=20, cached_input_tokens=60),
            ),
        ]
    )
    kernel = AgentKernel(
        model=model,
        ledger=ledger,
        registry=registry,
        provider="p",
        model_name="m",
        system_prompt="sys",
        context_window=1000,
        retry_policy=RetryPolicy(max_attempts=2, base_delay_s=0.0, max_delay_s=0.0, jitter_ratio=0.0),
    )

    assert await kernel.run_turn("s", "hello") == "ok"
    metrics = kernel.metrics("s")
    assert metrics.turns == 1
    assert metrics.model_attempts == 2
    assert metrics.model_responses == 1
    assert metrics.retries == 1
    assert metrics.input_tokens == 100
    assert metrics.cached_input_tokens == 60
    assert metrics.cache_ratio == pytest.approx(0.6)
    assert metrics.request_header_changes == 1


@pytest.mark.asyncio
async def test_resume_goal_from_fresh_kernel(tmp_path: Path):
    db = tmp_path / "goal.sqlite"
    ledger1 = EventLedger(db)
    registry1 = ToolRegistry()
    model1 = ScriptedModel([ModelResponse(content="attempt")])
    kernel1 = AgentKernel(
        model=model1,
        ledger=ledger1,
        registry=registry1,
        provider="p",
        model_name="m",
        system_prompt="sys",
        context_window=1000,
    )
    never = RuleVerifier(lambda goal, messages: False)
    blocked = await kernel1.run_goal(
        "s",
        objective="finish",
        acceptance_criteria=("verified",),
        verifier=never,
        max_rounds=1,
        goal_id="g",
    )
    assert blocked.phase == "blocked"
    ledger1.close()

    ledger2 = EventLedger(db)
    model2 = ScriptedModel([ModelResponse(content="fixed")])
    kernel2 = AgentKernel(
        model=model2,
        ledger=ledger2,
        registry=ToolRegistry(),
        provider="p",
        model_name="m",
        system_prompt="sys",
        context_window=1000,
    )
    always = RuleVerifier(lambda goal, messages: True)
    resumed = await kernel2.resume_goal("s", "g", verifier=always, additional_rounds=2)
    assert resumed.phase == "complete"
    assert resumed.rounds_started == 2
    assert any(event.type == "goal/resumed" for event in ledger2.events("s"))


def test_telemetry_counts_tool_lifecycle():
    ledger = EventLedger()
    ledger.append("s", "turn/start", {"turn": 1})
    ledger.append("s", "step/start", {"turn": 1, "step": 1})
    ledger.append("s", "tool/planned", {})
    ledger.append("s", "tool/call", {})
    ledger.append("s", "tool/reused", {})
    ledger.append("s", "tool/result", {"is_error": True})
    ledger.append("s", "compaction/end", {"shadowed_count": 4})
    ledger.append("s", "goal/verification", {"passed": True})
    metrics = derive_session_metrics(ledger, "s")
    assert metrics.tool_planned == 1
    assert metrics.tool_dispatched == 1
    assert metrics.tool_reused == 1
    assert metrics.tool_results == 1
    assert metrics.tool_errors == 1
    assert metrics.tool_error_rate == 1.0
    assert metrics.compactions == 1
    assert metrics.compaction_shadowed_events == 4
    assert metrics.goal_verifications == 1
    assert metrics.goal_passes == 1
