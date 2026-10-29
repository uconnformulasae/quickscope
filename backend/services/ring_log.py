"""Thread-safe in-memory ring buffer shared by the upload and AiM pull logs."""

from __future__ import annotations

import threading
from collections import deque


class RingLog:
    """Keeps the most recent ``max_entries`` dict entries; never touches disk."""

    def __init__(self, max_entries: int = 100) -> None:
        self._lock = threading.Lock()
        self._entries: deque[dict] = deque(maxlen=max_entries)

    def append(self, entry: dict) -> None:
        with self._lock:
            self._entries.append(entry)

    def list_recent(self) -> list[dict]:
        """Newest first."""
        with self._lock:
            return list(reversed(self._entries))

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
