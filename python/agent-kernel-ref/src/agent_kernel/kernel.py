from __future__ import annotations

import uuid
from dataclasses import asdict

from .context import CompactionConfig, ContextController, TokenMeter
from .events import EventLedger
from .goals import GoalStore, render_goal_round
from .requests import RequestBuilder, canonical_tools, header_hash
from .retry import ContextWindowExceeded, RetryPolicy, retry_async
from .surface import SurfaceProjector
from .telemetry import SessionMetrics, derive_session_metrics
from .tools import ToolRegistry, ToolScheduler
from .types import Goal, GoalVerifier, ModelClient, ModelResponse, RequestHeader


class AgentKernel:
    def __init__(
        self,
        *,
        model: ModelClient,
        ledger: EventLedger,
        registry: ToolRegistry,
        provider: str,
        model_name: str,
        system_prompt: str,
        context_window: int,
        max_parallel_tools: int = 10,
        max_steps_per_turn: int = 32,
        max_output_tokens: int = 8192,
        reasoning_effort: str | None = None,
        retry_policy: RetryPolicy = RetryPolicy(),
    ) -> None:
        self.model = model
        self.ledger = ledger
        self.registry = registry
        self.provider = provider
        self.model_name = model_name
        self.system_prompt = system_prompt
        self.max_steps_per_turn = max_steps_per_turn
        self.max_output_tokens = max_output_tokens
        self.reasoning_effort = reasoning_effort
        self.retry_policy = retry_policy
        self.projector = SurfaceProjector()
        self.request_builder = RequestBuilder(ledger)
        self.scheduler = ToolScheduler(ledger, registry, max_parallel=max_parallel_tools)
        self.context = ContextController(
            ledger,
            self.projector,
            model,
            CompactionConfig(context_window=context_window),
            TokenMeter(),
        )
        self.goals = GoalStore(ledger)

    def header(self) -> RequestHeader:
        return RequestHeader(
            provider=self.provider,
            model=self.model_name,
            system=self.system_prompt,
            tools=canonical_tools(self.registry.definitions()),
            reasoning_effort=self.reasoning_effort,
            max_tokens=self.max_output_tokens,
        )

    def metrics(self, session_id: str) -> SessionMetrics:
        return derive_session_metrics(self.ledger, session_id)

    def _next_turn(self, session_id: str) -> int:
        return 1 + sum(1 for event in self.ledger.events(session_id) if event.type == "turn/start")

    async def _generate(self, session_id: str, request) -> ModelResponse:
        attempt_counter = 0

        async def operation() -> ModelResponse:
            nonlocal attempt_counter
            attempt_counter += 1
            self.ledger.append(
                session_id,
                "model/request",
                {
                    "attempt": attempt_counter,
                    "provider": request.header.provider,
                    "model": request.header.model,
                    "header_hash": header_hash(request.header),
                    "message_count": len(request.messages),
                },
            )
            try:
                response = await self.model.generate(request)
            except BaseException as exc:
                if not isinstance(exc, (KeyboardInterrupt, SystemExit)):
                    self.ledger.append(
                        session_id,
                        "model/error",
                        {
                            "attempt": attempt_counter,
                            "error": f"{type(exc).__name__}: {exc}",
                        },
                    )
                raise
            self.ledger.append(
                session_id,
                "model/response",
                {
                    "attempt": attempt_counter,
                    "finish_reason": response.finish_reason,
                    "has_tool_calls": bool(response.tool_calls),
                },
            )
            return response

        def on_retry(attempt: int, exc: BaseException, delay: float) -> None:
            self.ledger.append(
                session_id,
                "retry",
                {
                    "attempt": attempt,
                    "error": f"{type(exc).__name__}: {exc}",
                    "delay_s": delay,
                },
            )

        return await retry_async(operation, policy=self.retry_policy, on_retry=on_retry)

    async def run_turn(self, session_id: str, user_text: str) -> str:
        turn = self._next_turn(session_id)
        self.ledger.append(session_id, "turn/start", {"turn": turn})
        self.ledger.append(session_id, "user/message", {"turn": turn, "content": user_text})
        header = self.header()
        overflow_retries = 0

        for step in range(1, self.max_steps_per_turn + 1):
            self.ledger.append(session_id, "step/start", {"turn": turn, "step": step})
            await self.context.compact_if_needed(session_id, header)
            messages = self.context.visible_messages(session_id, prune=True)
            request = self.request_builder.build(session_id, header, messages)
            try:
                response = await self._generate(session_id, request)
            except ContextWindowExceeded:
                if overflow_retries >= 1:
                    self.ledger.append(
                        session_id,
                        "turn/end",
                        {"turn": turn, "reason": {"kind": "context-overflow"}},
                    )
                    raise
                overflow_retries += 1
                if not await self.context.compact(session_id, header):
                    raise
                self.ledger.append(
                    session_id,
                    "retry",
                    {
                        "attempt": overflow_retries,
                        "error": "ContextWindowExceeded",
                        "reason": "compacted-and-retry",
                    },
                )
                continue

            self.ledger.append(
                session_id,
                "assistant/message",
                {
                    "turn": turn,
                    "step": step,
                    "content": response.content,
                    "tool_calls": [call.to_dict() for call in response.tool_calls],
                    "usage": asdict(response.usage),
                    "finish_reason": response.finish_reason,
                },
            )
            if not response.tool_calls:
                self.ledger.append(
                    session_id,
                    "step/end",
                    {"turn": turn, "step": step, "reason": "assistant-final"},
                )
                self.ledger.append(
                    session_id,
                    "turn/end",
                    {"turn": turn, "reason": {"kind": "complete"}},
                )
                return response.content

            scheduled = await self.scheduler.execute(session_id, turn, step, response.tool_calls)
            concluded = any(item.result.concludes_turn for item in scheduled)
            self.ledger.append(
                session_id,
                "step/end",
                {"turn": turn, "step": step, "reason": "tool-results", "concluded": concluded},
            )
            if concluded:
                self.ledger.append(
                    session_id,
                    "turn/end",
                    {"turn": turn, "reason": {"kind": "tool-concluded"}},
                )
                return response.content

        self.ledger.append(
            session_id,
            "turn/end",
            {"turn": turn, "reason": {"kind": "step-limit", "limit": self.max_steps_per_turn}},
        )
        raise RuntimeError(f"turn exceeded {self.max_steps_per_turn} steps")

    async def _drive_goal(self, session_id: str, goal: Goal, verifier: GoalVerifier) -> Goal:
        while goal.phase == "active" and goal.rounds_started < goal.max_rounds:
            prompt = render_goal_round(goal)
            goal.rounds_started += 1
            self.goals.save(session_id, goal)
            await self.run_turn(session_id, prompt)
            messages = self.context.visible_messages(session_id, prune=True)
            verdict = await verifier.verify(goal, messages)
            self.ledger.append(
                session_id,
                "goal/verification",
                {
                    "goal_id": goal.id,
                    "round": goal.rounds_started,
                    "passed": verdict.passed,
                    "reason": verdict.reason,
                    "evidence": list(verdict.evidence),
                },
            )
            goal.evidence.extend(verdict.evidence)
            if verdict.passed:
                goal.phase = "complete"
                self.goals.save(session_id, goal)
                return goal

        if goal.phase == "active":
            goal.phase = "blocked"
            self.ledger.append(
                session_id,
                "goal/blocked",
                {"goal_id": goal.id, "reason": "round-limit", "max_rounds": goal.max_rounds},
            )
            self.goals.save(session_id, goal)
        return goal

    async def run_goal(
        self,
        session_id: str,
        *,
        objective: str,
        acceptance_criteria: tuple[str, ...],
        verifier: GoalVerifier,
        max_rounds: int = 8,
        goal_id: str | None = None,
    ) -> Goal:
        goal = Goal(
            id=goal_id or uuid.uuid4().hex,
            objective=objective,
            acceptance_criteria=acceptance_criteria,
            max_rounds=max_rounds,
        )
        self.goals.create(session_id, goal)
        return await self._drive_goal(session_id, goal, verifier)

    async def resume_goal(
        self,
        session_id: str,
        goal_id: str,
        *,
        verifier: GoalVerifier,
        additional_rounds: int = 4,
    ) -> Goal:
        if additional_rounds < 1:
            raise ValueError("additional_rounds must be >= 1")
        goal = self.goals.get(session_id, goal_id)
        if goal.phase in {"complete", "failed"}:
            return goal
        if goal.rounds_started >= goal.max_rounds:
            goal.max_rounds = goal.rounds_started + additional_rounds
        goal.phase = "active"
        self.ledger.append(
            session_id,
            "goal/resumed",
            {
                "goal_id": goal.id,
                "rounds_started": goal.rounds_started,
                "max_rounds": goal.max_rounds,
            },
        )
        self.goals.save(session_id, goal)
        return await self._drive_goal(session_id, goal, verifier)
