from __future__ import annotations

import json
import sys
import traceback


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def recv():
    line = sys.stdin.readline()
    if not line:
        raise EOFError("parent closed bridge")
    return json.loads(line)


class Tools:
    def __init__(self):
        self._next = 0

    def call(self, name, **arguments):
        self._next += 1
        request_id = self._next
        send({"type": "tool_call", "id": request_id, "name": name, "arguments": arguments})
        message = recv()
        if message.get("type") != "tool_result" or message.get("id") != request_id:
            raise RuntimeError("invalid tool bridge response")
        if message.get("is_error"):
            raise RuntimeError(message.get("content", "tool failed"))
        return message.get("content", "")

    def batch(self, calls):
        self._next += 1
        request_id = self._next
        normalized = [
            {"name": item["name"], "arguments": dict(item.get("arguments", {}))}
            for item in calls
        ]
        send({"type": "tool_batch", "id": request_id, "calls": normalized})
        message = recv()
        if message.get("type") != "tool_batch_result" or message.get("id") != request_id:
            raise RuntimeError("invalid batch bridge response")
        return message.get("results", [])


SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "filter": filter,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "map": map,
    "max": max,
    "min": min,
    "range": range,
    "repr": repr,
    "reversed": reversed,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "Exception": Exception,
    "ValueError": ValueError,
    "RuntimeError": RuntimeError,
}


def json_safe(value):
    try:
        json.dumps(value)
        return value
    except Exception:
        return repr(value)


def main():
    start = recv()
    if start.get("type") != "start":
        raise RuntimeError("expected start")
    code = str(start.get("code", ""))
    logs = []

    def safe_print(*args, sep=" ", end="\n"):
        logs.append(sep.join(str(x) for x in args) + ("" if end == "\n" else end))

    builtins = dict(SAFE_BUILTINS)
    builtins["print"] = safe_print
    environment = {"__builtins__": builtins, "tools": Tools(), "result": None}
    try:
        exec(compile(code, "<run_code>", "exec"), environment, environment)
        if callable(environment.get("main")):
            environment["result"] = environment["main"]()
        send({"type": "done", "logs": logs, "result": json_safe(environment.get("result"))})
    except BaseException as exc:
        send(
            {
                "type": "error",
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(limit=8),
                "logs": logs,
            }
        )


if __name__ == "__main__":
    main()
