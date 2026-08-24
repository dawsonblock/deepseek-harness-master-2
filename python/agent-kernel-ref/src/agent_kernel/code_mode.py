from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from .tools import ToolScheduler
from .types import ToolCall, ToolContext, ToolDefinition, ToolResult


class CodeModeError(RuntimeError):
    pass


class CodeModeRunner:
    """
    Runs model-authored orchestration code in a separate process.

    This is defense-in-depth, not a hardened hostile-code sandbox. Production deployments
    should place the worker inside Firecracker, gVisor, WASM, E2B, or an equivalent sandbox.
    """

    def __init__(
        self,
        scheduler: ToolScheduler,
        *,
        timeout_s: float = 30.0,
        memory_limit_mb: int = 256,
        cpu_limit_s: int = 10,
    ) -> None:
        self.scheduler = scheduler
        self.timeout_s = timeout_s
        self.memory_limit_mb = memory_limit_mb
        self.cpu_limit_s = cpu_limit_s
        self.worker = Path(__file__).with_name("sandbox_worker.py")

    def _preexec(self):
        if os.name != "posix":
            return None
        memory_bytes = self.memory_limit_mb * 1024 * 1024
        cpu = self.cpu_limit_s

        def apply_limits():
            import resource

            resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
            resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))

        return apply_limits

    async def run(self, code: str, ctx: ToolContext) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="agent-code-") as cwd:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-I",
                "-S",
                str(self.worker),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                preexec_fn=self._preexec(),
            )
            assert process.stdin and process.stdout and process.stderr

            async def send(obj: dict[str, Any]) -> None:
                process.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
                await process.stdin.drain()

            async def drive() -> dict[str, Any]:
                await send({"type": "start", "code": code})
                while True:
                    line = await process.stdout.readline()
                    if not line:
                        stderr = (await process.stderr.read()).decode(errors="replace")
                        raise CodeModeError(f"code worker exited unexpectedly: {stderr[-2000:]}")
                    message = json.loads(line)
                    kind = message.get("type")
                    if kind == "tool_call":
                        call = ToolCall(
                            f"{ctx.call_id}:sub:{message['id']}",
                            str(message["name"]),
                            dict(message.get("arguments", {})),
                        )
                        scheduled = await self.scheduler.execute(ctx.session_id, ctx.turn, ctx.step, [call])
                        result = scheduled[0].result
                        await send(
                            {
                                "type": "tool_result",
                                "id": message["id"],
                                "content": result.content,
                                "is_error": result.is_error,
                            }
                        )
                    elif kind == "tool_batch":
                        calls = tuple(
                            ToolCall(
                                f"{ctx.call_id}:batch:{message['id']}:{i}:{uuid.uuid4().hex[:6]}",
                                str(item["name"]),
                                dict(item.get("arguments", {})),
                            )
                            for i, item in enumerate(message.get("calls", []))
                        )
                        scheduled = await self.scheduler.execute(ctx.session_id, ctx.turn, ctx.step, calls)
                        await send(
                            {
                                "type": "tool_batch_result",
                                "id": message["id"],
                                "results": [
                                    {
                                        "name": item.call.name,
                                        "content": item.result.content,
                                        "is_error": item.result.is_error,
                                    }
                                    for item in scheduled
                                ],
                            }
                        )
                    elif kind == "done":
                        return {"logs": list(message.get("logs", [])), "result": message.get("result")}
                    elif kind == "error":
                        raise CodeModeError(f"{message.get('error')}\n{message.get('traceback', '')}")
                    else:
                        raise CodeModeError(f"unknown worker message: {message}")

            try:
                output = await asyncio.wait_for(drive(), timeout=self.timeout_s)
            except BaseException:
                process.kill()
                await process.wait()
                raise
            finally:
                if process.returncode is None:
                    process.stdin.close()
                    await process.wait()
            return output


def make_run_code_tool(runner: CodeModeRunner) -> ToolDefinition:
    async def handler(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        code = str(args.get("code", ""))
        description = str(args.get("description", "")).strip()
        if not code:
            raise ValueError("code is required")
        if not description:
            raise ValueError("description is required")
        output = await runner.run(code, ctx)
        pieces = [*output["logs"]]
        if output.get("result") is not None:
            result = output["result"]
            pieces.append(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))
        return ToolResult(ctx.call_id, "run_code", "\n".join(pieces) or "(run_code completed with no output)")

    return ToolDefinition(
        name="run_code",
        description="Run bounded Python orchestration code that can invoke registered tools through tools.call() and tools.batch().",
        parameters={
            "type": "object",
            "properties": {
                "code": {"type": "string"},
                "description": {"type": "string"},
            },
            "required": ["code", "description"],
            "additionalProperties": False,
        },
        handler=handler,
        execution_mode="exclusive",
        idempotent=False,
    )
