"""In-memory progress for an in-flight AiM session pull (polled by the client).

Download progress covers the device conversation only. Indexing (parse +
metadata) runs afterwards in ``aim_pull_indexer`` with the device released, so
its per-file status lives in a separate map that outlives ``end_pull``.
"""

from __future__ import annotations

import threading
from typing import Any, Literal

Phase = Literal["idle", "download"]
IndexStatus = Literal["pending", "running", "ok", "failed"]

_lock = threading.Lock()
_active = False
_filenames: list[str] = []
_file_index = 0
_file_count = 0
_filename = ""
_bytes_received = 0
_bytes_total = 0
_phase: Phase = "idle"
_indexing: dict[str, IndexStatus] = {}


def begin_pull(filenames: list[str]) -> None:
    with _lock:
        global _active, _filenames, _file_index, _file_count, _filename
        global _bytes_received, _bytes_total, _phase
        _active = True
        _filenames = list(filenames)
        _file_index = 0
        _file_count = len(filenames)
        _filename = ""
        _bytes_received = 0
        _bytes_total = 0
        _phase = "download"
        _prune_finished_indexing()


def start_file(file_index: int, filename: str, bytes_total: int) -> None:
    with _lock:
        global _file_index, _filename, _bytes_received, _bytes_total, _phase
        _file_index = file_index
        _filename = filename
        _bytes_received = 0
        _bytes_total = max(0, bytes_total)
        _phase = "download"


def update_download(bytes_received: int, bytes_total: int) -> None:
    with _lock:
        global _bytes_received, _bytes_total, _phase
        _bytes_received = max(0, bytes_received)
        if bytes_total > 0:
            _bytes_total = bytes_total
        _phase = "download"


def end_pull() -> None:
    with _lock:
        global _active, _filenames, _file_index, _file_count, _filename
        global _bytes_received, _bytes_total, _phase
        _active = False
        _filenames = []
        _file_index = 0
        _file_count = 0
        _filename = ""
        _bytes_received = 0
        _bytes_total = 0
        _phase = "idle"


def set_index_status(filename: str, status: IndexStatus) -> None:
    with _lock:
        _indexing[filename] = status


def clear_indexing() -> None:
    with _lock:
        _indexing.clear()


def _prune_finished_indexing() -> None:
    """Drop finished entries; caller holds ``_lock``. In-flight ones survive a new pull."""
    for name in [n for n, s in _indexing.items() if s in ("ok", "failed")]:
        del _indexing[name]


def snapshot() -> dict[str, Any]:
    with _lock:
        return {
            "active": _active,
            "filenames": list(_filenames),
            "file_index": _file_index,
            "file_count": _file_count,
            "filename": _filename,
            "bytes_received": _bytes_received,
            "bytes_total": _bytes_total,
            "phase": _phase,
            "indexing": dict(_indexing),
        }
