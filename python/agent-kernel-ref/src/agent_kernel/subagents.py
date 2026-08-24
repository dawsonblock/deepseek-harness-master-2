from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from typing import Callable

from .kernel import AgentKernel


@dataclass(frozen=True)
class SubagentResult:
    session_id: str
    task: str
    conclusion: str
    evidence: tuple[str, ...] = ()


class SubagentManager:
    """Each child receives an isolated durable session; the parent receives only its product."""

    def __init__(self, kernel_factory: Callable[[], AgentKernel], max_parallel: int = 4) -> None:
        self.kernel_factory = kernel_factory
        self._sem = asyncio.Semaphore(max_parallel)

    async def spawn(self, task: str, *, seed_context: str | None = None) -> SubagentResult:
        async with self._sem:
            kernel = self.kernel_factory()
            session_id = "sub-" + uuid.uuid4().hex
            prompt = task + ("\n\nBounded parent context:\n" + seed_context if seed_context else "")
            conclusion = await kernel.run_turn(session_id, prompt)
            return SubagentResult(session_id, task, conclusion)

    async def gather(
        self, tasks: tuple[str, ...], *, seed_context: str | None = None
    ) -> tuple[SubagentResult, ...]:
        return tuple(
            await asyncio.gather(*(self.spawn(task, seed_context=seed_context) for task in tasks))
        )
