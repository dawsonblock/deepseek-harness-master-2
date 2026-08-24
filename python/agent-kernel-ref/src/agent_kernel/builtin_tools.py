from __future__ import annotations

from pathlib import Path
from typing import Any

from .filesystem import FileObservationGuard
from .types import ToolContext, ToolDefinition, ToolResult


def make_read_file_tool(guard: FileObservationGuard) -> ToolDefinition:
    async def handler(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        observation = guard.read_text(ctx.session_id, Path(str(args["path"])))
        return ToolResult(ctx.call_id, "read_file", f"version={observation.version}\n{observation.content}")

    return ToolDefinition(
        "read_file",
        "Read a UTF-8 text file and observe its content version.",
        {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
        handler,
        "parallel",
        True,
    )


def make_write_file_tool(guard: FileObservationGuard) -> ToolDefinition:
    async def handler(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        version = guard.write_text(
            ctx.session_id,
            Path(str(args["path"])),
            str(args["content"]),
            expected_version=args.get("expected_version"),
        )
        return ToolResult(ctx.call_id, "write_file", f"written version={version}")

    return ToolDefinition(
        "write_file",
        "Replace a previously observed UTF-8 file using optimistic concurrency control.",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "expected_version": {"type": "string"},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
        handler,
        "exclusive",
        False,
    )


def make_create_file_tool(guard: FileObservationGuard) -> ToolDefinition:
    async def handler(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        version = guard.create_text(ctx.session_id, Path(str(args["path"])), str(args["content"]))
        return ToolResult(ctx.call_id, "create_file", f"created version={version}")

    return ToolDefinition(
        "create_file",
        "Create a new UTF-8 text file. Fails if the target already exists.",
        {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
            "additionalProperties": False,
        },
        handler,
        "exclusive",
        False,
    )
