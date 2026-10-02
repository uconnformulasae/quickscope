"""Per-id LRU cache of parsed XRK logs.

Keeps up to MAX_ENTRIES recently opened sessions in memory so switching
back to a session in the same app run does not re-parse the file.
Thread-safe for parses running in asyncio.to_thread.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from pathlib import Path
from typing import Callable, Optional, TypeVar

T = TypeVar("T")

MAX_ENTRIES = 4

# (log, filename, file fingerprint)
_FileFingerprint = tuple[str, int, int]
_CacheEntry = tuple[object, str, _FileFingerprint]


def _fingerprint(path: Path) -> _FileFingerprint:
    st = path.stat()
    mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
    return (str(path.resolve()), mtime_ns, st.st_size)


class SessionCache:
    def __init__(self, max_entries: int = MAX_ENTRIES):
        self._max = max_entries
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, _CacheEntry] = OrderedDict()
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

    def _fingerprint_matches(self, entry: _CacheEntry, path: Path) -> bool:
        try:
            return entry[2] == _fingerprint(path)
        except OSError:
            return False

    def get(self, session_id: str) -> Optional[tuple[object, str]]:
        """Return (log, filename) for session_id without validating the file."""
        with self._lock:
            entry = self._entries.get(session_id)
            if entry is not None:
                self._entries.move_to_end(session_id)
                return entry[0], entry[1]
            return None

    def get_valid(self, session_id: str, local_path: Path) -> Optional[tuple[object, str]]:
        """Return cached log if the on-disk file still matches the cached fingerprint."""
        with self._lock:
            entry = self._entries.get(session_id)
            if entry is None:
                return None
            if not self._fingerprint_matches(entry, local_path):
                self._entries.pop(session_id, None)
                if self._active_id == session_id:
                    self._active_id = None
                return None
            self._entries.move_to_end(session_id)
            return entry[0], entry[1]

    def put(
        self,
        session_id: str,
        log: object,
        filename: str,
        local_path: Path | None = None,
    ) -> None:
        if local_path is not None and local_path.is_file():
            fp = _fingerprint(local_path)
        else:
            fp = ("", 0, 0)
        with self._lock:
            self._entries[session_id] = (log, filename, fp)
            self._entries.move_to_end(session_id)
            while len(self._entries) > self._max:
                evicted_id, _ = self._entries.popitem(last=False)
                if evicted_id == self._active_id:
                    self._active_id = None

    def rebind_file(self, session_id: str, local_path: Path, filename: str | None = None) -> None:
        """Attach a real on-disk fingerprint to an entry (e.g. after upload)."""
        with self._lock:
            entry = self._entries.get(session_id)
            if entry is None:
                return
            log, fn, _ = entry
            self._entries[session_id] = (
                log,
                filename if filename is not None else fn,
                _fingerprint(local_path),
            )

    def get_or_load(
        self,
        session_id: str,
        local_path: Path,
        loader: Callable[[], T],
    ) -> T:
        cached = self.get_valid(session_id, local_path)
        if cached is not None:
            return cached[0]  # type: ignore[return-value]
        log = loader()
        self.put(session_id, log, local_path.name, local_path)
        return log

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
