from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from .events import EventLedger


class FileNotObserved(RuntimeError):
    pass


class StaleFileVersion(RuntimeError):
    pass


@dataclass(frozen=True)
class FileObservation:
    path: str
    version: str
    content: str


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FileObservationGuard:
    """Optimistic concurrency control for AI filesystem mutation."""

    def __init__(self, ledger: EventLedger | None = None) -> None:
        self.ledger = ledger
        self._observed: dict[tuple[str, str], str] = {}

    def read_text(self, session_id: str, path: str | Path, encoding: str = "utf-8") -> FileObservation:
        path = Path(path).resolve()
        data = path.read_bytes()
        version = content_hash(data)
        self._observed[(session_id, str(path))] = version
        content = data.decode(encoding)
        if self.ledger:
            self.ledger.append(session_id, "fs/observed", {"path": str(path), "version": version})
        return FileObservation(str(path), version, content)

    def write_text(
        self,
        session_id: str,
        path: str | Path,
        content: str,
        *,
        expected_version: str | None = None,
        encoding: str = "utf-8",
    ) -> str:
        path = Path(path).resolve()
        key = (session_id, str(path))
        observed = expected_version or self._observed.get(key)
        if observed is None:
            raise FileNotObserved(f"FS_NOT_OBSERVED: {path}")
        current = content_hash(path.read_bytes()) if path.exists() else content_hash(b"")
        if current != observed:
            raise StaleFileVersion(
                f"FS_STALE_VERSION: {path}: expected {observed}, current {current}"
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding=encoding)
        new_version = content_hash(path.read_bytes())
        self._observed[key] = new_version
        if self.ledger:
            self.ledger.append(
                session_id,
                "fs/mutated",
                {"path": str(path), "old_version": current, "new_version": new_version},
            )
        return new_version

    def create_text(self, session_id: str, path: str | Path, content: str, encoding: str = "utf-8") -> str:
        path = Path(path).resolve()
        if path.exists():
            raise FileExistsError(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding=encoding)
        version = content_hash(path.read_bytes())
        self._observed[(session_id, str(path))] = version
        if self.ledger:
            self.ledger.append(session_id, "fs/created", {"path": str(path), "version": version})
        return version
