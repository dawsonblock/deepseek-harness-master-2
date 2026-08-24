from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from typing import Iterable

from .events import EventLedger
from .types import Message, ModelRequest, RequestHeader, ToolDefinition


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_tools(tools: Iterable[ToolDefinition]) -> tuple[dict, ...]:
    return tuple(tool.schema() for tool in sorted(tools, key=lambda tool: tool.name))


def canonical_header(header: RequestHeader) -> RequestHeader:
    tools = tuple(sorted((dict(tool) for tool in header.tools), key=lambda tool: str(tool.get("name", ""))))
    return RequestHeader(
        provider=header.provider,
        model=header.model,
        system=header.system or "",
        tools=tools,
        reasoning_effort=header.reasoning_effort,
        max_tokens=header.max_tokens,
    )


def header_hash(header: RequestHeader) -> str:
    encoded = canonical_json(asdict(canonical_header(header)))
    return hashlib.sha256(encoded.encode()).hexdigest()


class RequestBuilder:
    def __init__(self, ledger: EventLedger) -> None:
        self.ledger = ledger

    def build(
        self, session_id: str, header: RequestHeader, messages: tuple[Message, ...]
    ) -> ModelRequest:
        header = canonical_header(header)
        current_hash = header_hash(header)
        latest = self.ledger.latest(session_id, "request/header")
        if latest is None or latest.data.get("hash") != current_hash:
            self.ledger.append(
                session_id,
                "request/header",
                {"hash": current_hash, "header": asdict(header)},
            )
        return ModelRequest(header, messages)
