"""Per-id LRU cache of parsed aim_xrk logs.

Replaces the prior single-session model in state.SessionState. Sessions are
keyed by session_id (UUID from session_store). When the cache exceeds
MAX_ENTRIES, the least-recently-accessed entry is evicted. Thread-safe via
threading.Lock — callers may be FastAPI handlers (asyncio) but parses run in
asyncio.to_thread, so the lock is honest.

Usage:
    log = session_cache.get_or_load(session_id, lambda: parse_file(path))
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Optional


MAX_ENTRIES = 4


class SessionCache:
    def __init__(self, max_entries: int = MAX_ENTRIES):
        self._max = max_entries
        self._lock = threading.Lock()
        # OrderedDict: most-recently-used at the end
        self._entries: "OrderedDict[str, tuple[object, str]]" = OrderedDict()
        # Active id (the session whose data the legacy non-id endpoints read)
        self._active_id: Optional[str] = None

    @property
    def active_id(self) -> Optional[str]:
        with self._lock:
            return self._active_id

    def set_active(self, session_id: str) -> None:
        with self._lock:
            if session_id in self._entries:
                self._entries.move_to_end(session_id)
            self._active_id = session_id

    def clear_active(self) -> None:
        with self._lock:
            self._active_id = None

    def get(self, session_id: str) -> Optional[tuple[object, str]]:
        """Return (log, filename) for session_id without parsing. Bumps MRU."""
        with self._lock:
            entry = self._entries.get(session_id)
            if entry is not None:
                self._entries.move_to_end(session_id)
            return entry

    def put(self, session_id: str, log: object, filename: str) -> None:
        with self._lock:
            self._entries[session_id] = (log, filename)
            self._entries.move_to_end(session_id)
            while len(self._entries) > self._max:
                evicted_id, _ = self._entries.popitem(last=False)
                if evicted_id == self._active_id:
                    self._active_id = None

    def evict(self, session_id: str) -> None:
        with self._lock:
            self._entries.pop(session_id, None)
            if self._active_id == session_id:
                self._active_id = None

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._active_id = None

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._entries.keys())


session_cache = SessionCache()
