from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Awaitable, Callable, Literal, Protocol

Json = dict[str, Any]
Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: Json

    def to_dict(self) -> Json:
        return {"id": self.id, "name": self.name, "arguments": self.arguments}


@dataclass(frozen=True)
class Message:
    role: Role
    content: str
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()

    def to_dict(self) -> Json:
        out: Json = {"role": self.role, "content": self.content}
        if self.name is not None:
            out["name"] = self.name
        if self.tool_call_id is not None:
            out["tool_call_id"] = self.tool_call_id
        if self.tool_calls:
            out["tool_calls"] = [call.to_dict() for call in self.tool_calls]
        return out


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    name: str
    content: str
    is_error: bool = False
    concludes_turn: bool = False
    additional_contexts: tuple[str, ...] = ()


@dataclass(frozen=True)
class ModelUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0


@dataclass(frozen=True)
class ModelResponse:
    content: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    usage: ModelUsage = field(default_factory=ModelUsage)
    finish_reason: str | None = None


@dataclass(frozen=True)
class RequestHeader:
    provider: str
    model: str
    system: str = ""
    tools: tuple[Json, ...] = ()
    reasoning_effort: str | None = None
    max_tokens: int | None = None


@dataclass(frozen=True)
class ModelRequest:
    header: RequestHeader
    messages: tuple[Message, ...]


class ModelClient(Protocol):
    async def generate(self, request: ModelRequest) -> ModelResponse:
        ...


@dataclass(frozen=True)
class ToolContext:
    session_id: str
    turn: int
    step: int
    call_id: str


ToolHandler = Callable[[Json, ToolContext], Awaitable[ToolResult]]
ExecutionMode = Literal["parallel", "exclusive"]


@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: Json
    handler: ToolHandler
    execution_mode: ExecutionMode | Callable[[Json], ExecutionMode] = "exclusive"
    idempotent: bool = False

    def mode_for(self, args: Json) -> ExecutionMode:
        mode = self.execution_mode(args) if callable(self.execution_mode) else self.execution_mode
        return mode if mode == "parallel" else "exclusive"

    def schema(self) -> Json:
        return {"name": self.name, "description": self.description, "parameters": self.parameters}


@dataclass(frozen=True)
class Verification:
    passed: bool
    reason: str
    evidence: tuple[str, ...] = ()


@dataclass
class Goal:
    id: str
    objective: str
    acceptance_criteria: tuple[str, ...]
    max_rounds: int = 8
    rounds_started: int = 0
    phase: Literal["active", "blocked", "complete", "failed"] = "active"
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> Json:
        return asdict(self)


class GoalVerifier(Protocol):
    async def verify(self, goal: Goal, messages: tuple[Message, ...]) -> Verification:
        ...
