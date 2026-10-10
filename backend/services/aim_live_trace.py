"""
Persistent trace for AiM live view sessions.

Writes JSONL timelines under backend/data/logs/aim_live/sessions/ so failures
can be diagnosed without terminal scrollback. Each WebSocket live connection
gets one trace file; path is logged at session_start.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.trace_file import open_unique

logger = logging.getLogger(__name__)

_FRAME_FLUSH_INTERVAL_S = 1.0

_SESSION_DIR = Path(__file__).resolve().parent.parent / "data" / "logs" / "aim_live" / "sessions"


class AimLiveTrace:
    """Append-only JSONL log for one live-view attempt."""

    def __init__(self, *, configured_host: str) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        self.path, self._fh = open_unique(_SESSION_DIR, f"{stamp}_live.jsonl")
        self._closed = False
        self._last_flush = time.monotonic()
        self.log("session_start", configured_host=configured_host, trace_file=str(self.path))
        logger.info("AiM live trace: writing session log to %s", self.path)

    def log(self, event: str, **fields: Any) -> None:
        # AimPrimaryHub keeps the underlying AimLiveClient (and its
        # `_session_trace` reference) alive across WebSocket reconnects to
        # skip re-handshaking, but each WS session's trace file is closed
        # when that session ends. A late event from a client whose trace
        # outlived it (e.g. `close()` firing on the *next* connect attempt,
        # when the stale client gets torn down) must never crash the actual
        # connect/close flow over a diagnostics-only write.
        if self._closed:
            return
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": event,
            **fields,
        }
        line = json.dumps(entry, default=str)
        try:
            self._fh.write(line + "\n")
            # Frames arrive many times a second; flushing each one blocks the event
            # loop on a syscall. Batch them (<= 1 s stale) but flush other events at once.
            now = time.monotonic()
            if event != "frame" or now - self._last_flush >= _FRAME_FLUSH_INTERVAL_S:
                self._fh.flush()
                self._last_flush = now
        except ValueError:
            # "I/O operation on closed file" -- file closed out from under
            # us rather than through our own `_closed` flag. Same policy:
            # swallow it, this log is best-effort.
            self._closed = True

    def log_frame(self, direction: str, summary: str, **fields: Any) -> None:
        self.log("frame", direction=direction, summary=summary, **fields)

    def close(self, **summary: Any) -> None:
        if self._closed:
            return
        self.log("session_end", **summary)
        self._closed = True
        self._fh.close()
