from __future__ import annotations

import json
from dataclasses import asdict

from .events import EventLedger
from .types import Goal, Message, ModelClient, ModelRequest, RequestHeader, Verification


def render_goal_round(goal: Goal) -> str:
    criteria = "\n".join(f"- {criterion}" for criterion in goal.acceptance_criteria)
    return f"""
Continue the active goal.

Objective:
{goal.objective}

Acceptance criteria:
{criteria}

Round:
{goal.rounds_started + 1}/{goal.max_rounds}

Treat the current workspace, tool results, and durable session state as authoritative.
Do not trust earlier narration when it conflicts with current evidence.
Make concrete progress. Verify what you changed.
Do not claim completion unless the acceptance criteria are supported by evidence.
""".strip()


class RuleVerifier:
    def __init__(self, predicate, reason: str = "deterministic acceptance predicate") -> None:
        self.predicate = predicate
        self.reason = reason

    async def verify(self, goal: Goal, messages: tuple[Message, ...]) -> Verification:
        return Verification(bool(self.predicate(goal, messages)), self.reason)


class LLMGoalVerifier:
    def __init__(self, model: ModelClient, header: RequestHeader) -> None:
        self.model = model
        self.header = header

    async def verify(self, goal: Goal, messages: tuple[Message, ...]) -> Verification:
        criteria = "\n".join(f"- {criterion}" for criterion in goal.acceptance_criteria)
        prompt = f"""
Act as an independent verifier. Judge only from the transcript and evidence above.
Goal:
{goal.objective}
Acceptance criteria:
{criteria}
Return strict JSON only:
{{"passed": true, "reason": "...", "evidence": ["..."]}}
Do not pass merely because the worker says it is done.
""".strip()
        response = await self.model.generate(
            ModelRequest(self.header, messages + (Message("user", prompt),))
        )
        try:
            data = json.loads(response.content)
            return Verification(
                bool(data["passed"]),
                str(data.get("reason", "")),
                tuple(str(x) for x in data.get("evidence", [])),
            )
        except Exception:
            return Verification(False, f"verifier returned invalid JSON: {response.content[:500]}")


def _goal_from_dict(data: dict) -> Goal:
    return Goal(
        id=str(data["id"]),
        objective=str(data["objective"]),
        acceptance_criteria=tuple(str(x) for x in data.get("acceptance_criteria", [])),
        max_rounds=int(data.get("max_rounds", 8)),
        rounds_started=int(data.get("rounds_started", 0)),
        phase=str(data.get("phase", "active")),
        evidence=[str(x) for x in data.get("evidence", [])],
    )


class GoalStore:
    """Durable goal store projected from goal/update events.

    The in-memory map is only a cache. A fresh process can reconstruct goals from
    the event ledger and resume them without relying on prior Python objects.
    """

    def __init__(self, ledger: EventLedger) -> None:
        self.ledger = ledger
        self._goals: dict[tuple[str, str], Goal] = {}

    def create(self, session_id: str, goal: Goal) -> Goal:
        existing = self.try_get(session_id, goal.id)
        if existing is not None:
            raise ValueError(f"goal already exists: {goal.id}")
        self.save(session_id, goal)
        return goal

    def save(self, session_id: str, goal: Goal) -> None:
        self._goals[(session_id, goal.id)] = goal
        self.ledger.append(session_id, "goal/update", {"goal": asdict(goal)})

    def try_get(self, session_id: str, goal_id: str) -> Goal | None:
        cached = self._goals.get((session_id, goal_id))
        if cached is not None:
            return cached
        for event in reversed(self.ledger.events(session_id)):
            if event.type != "goal/update":
                continue
            raw = dict(event.data.get("goal", {}))
            if str(raw.get("id", "")) != goal_id:
                continue
            goal = _goal_from_dict(raw)
            self._goals[(session_id, goal_id)] = goal
            return goal
        return None

    def get(self, session_id: str, goal_id: str) -> Goal:
        goal = self.try_get(session_id, goal_id)
        if goal is None:
            raise KeyError((session_id, goal_id))
        return goal

    def list(self, session_id: str) -> tuple[Goal, ...]:
        latest: dict[str, Goal] = {}
        for event in self.ledger.events(session_id):
            if event.type != "goal/update":
                continue
            raw = dict(event.data.get("goal", {}))
            if not raw.get("id"):
                continue
            goal = _goal_from_dict(raw)
            latest[goal.id] = goal
            self._goals[(session_id, goal.id)] = goal
        return tuple(latest[key] for key in sorted(latest))
