from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class SessionEvent:
    session_id: str
    seq: int
    ts_ns: int
    type: str
    data: dict[str, Any]


class EventLedger:
    """Immutable per-session event log backed by SQLite WAL."""

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._conn:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=FULL")
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    session_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    ts_ns INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    PRIMARY KEY(session_id, seq)
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type, seq)"
            )

    def append(self, session_id: str, event_type: str, data: dict[str, Any]) -> SessionEvent:
        encoded = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            seq = int(row["next_seq"])
            ts_ns = time.time_ns()
            self._conn.execute(
                "INSERT INTO events(session_id, seq, ts_ns, type, data_json) VALUES (?, ?, ?, ?, ?)",
                (session_id, seq, ts_ns, event_type, encoded),
            )
        return SessionEvent(session_id, seq, ts_ns, event_type, data)

    def append_many(
        self, session_id: str, items: Iterable[tuple[str, dict[str, Any]]]
    ) -> list[SessionEvent]:
        output: list[SessionEvent] = []
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            seq = int(row["next_seq"])
            for event_type, data in items:
                ts_ns = time.time_ns()
                encoded = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                self._conn.execute(
                    "INSERT INTO events(session_id, seq, ts_ns, type, data_json) VALUES (?, ?, ?, ?, ?)",
                    (session_id, seq, ts_ns, event_type, encoded),
                )
                output.append(SessionEvent(session_id, seq, ts_ns, event_type, data))
                seq += 1
        return output

    def events(self, session_id: str) -> list[SessionEvent]:
        rows = self._conn.execute(
            "SELECT session_id, seq, ts_ns, type, data_json FROM events WHERE session_id = ? ORDER BY seq",
            (session_id,),
        ).fetchall()
        return [
            SessionEvent(
                row["session_id"],
                int(row["seq"]),
                int(row["ts_ns"]),
                row["type"],
                json.loads(row["data_json"]),
            )
            for row in rows
        ]

    def latest(self, session_id: str, event_type: str) -> SessionEvent | None:
        row = self._conn.execute(
            """
            SELECT session_id, seq, ts_ns, type, data_json
            FROM events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1
            """,
            (session_id, event_type),
        ).fetchone()
        if row is None:
            return None
        return SessionEvent(
            row["session_id"], int(row["seq"]), int(row["ts_ns"]), row["type"], json.loads(row["data_json"])
        )

    def close(self) -> None:
        self._conn.close()
