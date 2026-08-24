from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_kernel import (
    AgentKernel,
    CodeModeRunner,
    EventLedger,
    FileObservationGuard,
    StaleFileVersion,
    SurfaceProjector,
    ToolRegistry,
    ToolScheduler,
    make_run_code_tool,
)
from agent_kernel.types import ModelRequest, ModelResponse, ToolCall, ToolContext, ToolDefinition, ToolResult


class ScriptedModel:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests: list[ModelRequest] = []

    async def generate(self, request: ModelRequest) -> ModelResponse:
        self.requests.append(request)
        if not self.responses:
            return ModelResponse(content="done")
        item = self.responses.pop(0)
        return item(request) if callable(item) else item


@pytest.mark.asyncio
async def test_kernel_tool_loop_and_order():
    ledger = EventLedger()
    registry = ToolRegistry()

    async def echo(args, ctx):
        await asyncio.sleep(float(args.get("delay", 0)))
        return ToolResult(ctx.call_id, "echo", str(args["value"]))

    registry.register(ToolDefinition("echo", "echo", {"type": "object"}, echo, "parallel", True))
    model = ScriptedModel(
        [
            ModelResponse(
                tool_calls=(
                    ToolCall("a", "echo", {"value": "A", "delay": 0.03}),
                    ToolCall("b", "echo", {"value": "B", "delay": 0.0}),
                )
            ),
            ModelResponse(content="final"),
        ]
    )
    kernel = AgentKernel(
        model=model,
        ledger=ledger,
        registry=registry,
        provider="test",
        model_name="fake",
        system_prompt="system",
        context_window=10000,
    )
    assert await kernel.run_turn("s", "go") == "final"
    result_ids = [
        event.data["call_id"]
        for event in ledger.events("s")
        if event.type == "tool/result"
    ]
    assert result_ids == ["a", "b"]


@pytest.mark.asyncio
async def test_exclusive_barrier():
    ledger = EventLedger()
    registry = ToolRegistry()
    timeline = []

    def tool(name, mode, delay):
        async def handler(args, ctx):
            timeline.append((name, "start"))
            await asyncio.sleep(delay)
            timeline.append((name, "end"))
            return ToolResult(ctx.call_id, name, name)

        return ToolDefinition(name, name, {"type": "object"}, handler, mode)

    registry.register(tool("p1", "parallel", 0.02))
    registry.register(tool("p2", "parallel", 0.02))
    registry.register(tool("x", "exclusive", 0.001))
    registry.register(tool("p3", "parallel", 0.001))
    scheduler = ToolScheduler(ledger, registry, max_parallel=10)
    await scheduler.execute(
        "s",
        1,
        1,
        [
            ToolCall("1", "p1", {}),
            ToolCall("2", "p2", {}),
            ToolCall("3", "x", {}),
            ToolCall("4", "p3", {}),
        ],
    )
    assert timeline.index(("x", "start")) > timeline.index(("p1", "end"))
    assert timeline.index(("x", "start")) > timeline.index(("p2", "end"))
    assert timeline.index(("p3", "start")) > timeline.index(("x", "end"))


def test_surface_replace_is_replayable():
    ledger = EventLedger()
    ledger.append("s", "user/message", {"content": "one"})
    a = ledger.append("s", "assistant/message", {"content": "two", "tool_calls": []})
    b = ledger.append("s", "user/message", {"content": "three"})
    summary = ledger.append("s", "compaction/summary", {"content": "summary"})
    ledger.append(
        "s",
        "surface/replace",
        {"shadowed_seqs": [a.seq, b.seq], "replacement_seq": summary.seq},
    )
    messages = SurfaceProjector().messages(ledger.events("s"))
    assert [message.content for message in messages] == [
        "one",
        "<compacted-summary>\nsummary\n</compacted-summary>",
    ]


def test_file_cas(tmp_path: Path):
    ledger = EventLedger()
    guard = FileObservationGuard(ledger)
    path = tmp_path / "x.txt"
    path.write_text("a")
    observation = guard.read_text("s", path)
    path.write_text("external change")
    with pytest.raises(StaleFileVersion):
        guard.write_text("s", path, "agent change", expected_version=observation.version)


@pytest.mark.asyncio
async def test_code_mode_calls_tools():
    ledger = EventLedger()
    registry = ToolRegistry()

    async def add(args, ctx):
        return ToolResult(ctx.call_id, "add", str(int(args["a"]) + int(args["b"])))

    registry.register(ToolDefinition("add", "add", {"type": "object"}, add, "parallel", True))
    scheduler = ToolScheduler(ledger, registry)
    runner = CodeModeRunner(scheduler, timeout_s=5)
    registry.register(make_run_code_tool(runner))
    result = await runner.run(
        'x = tools.call("add", a=2, b=3)\nresult = {"sum": int(x)}\n',
        ToolContext("s", 1, 1, "outer"),
    )
    assert result["result"] == {"sum": 5}
