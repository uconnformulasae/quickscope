"""
Persistent trace log for AiM file downloads.

Writes a human-readable timeline to <data dir>/logs/aim_download/ so we can
diagnose truncated transfers without relying on console scrollback alone.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from services.aim_live import decode_frame, resync_offset
from services.settings_store import DATA_DIR
from services.trace_file import open_unique

_LOG_DIR = DATA_DIR / "logs" / "aim_download"


def log_dir() -> Path:
    """Directory the download traces are written to."""
    return _LOG_DIR


# How much of the end of a failed stream goes into the trace.
STREAM_TAIL_BYTES = 256


class AimDownloadTrace:
    def __init__(self, filename: str, expected_size: int = 0) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)
        self.path, self._fh = open_unique(_LOG_DIR, f"{stamp}_{safe}.log")
        self._unflushed = 0
        self.log(
            "session_start",
            filename=filename,
            expected_size=expected_size,
        )

    def log(self, event: str, **fields) -> None:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": event,
            **fields,
        }
        self._fh.write(json.dumps(entry, default=str) + "\n")
        # A download logs ~100+ lines (one per recv/frame/progress event);
        # flushing every single one is a syscall per line on the hot recv()
        # path. Flushing every 20 lines keeps the log readable soon after
        # writes without paying that cost per line; close() always flushes.
        self._unflushed += 1
        if self._unflushed >= 20:
            self._fh.flush()
            self._unflushed = 0

    def log_frame(self, frame, *, ack_sent: bool = False) -> None:
        fields: dict = {
            "cmd": frame.cmd.decode("ascii", errors="replace"),
            "payload_len": len(frame.payload),
            "ack_sent": ack_sent,
        }
        if len(frame.payload) == 64 and len(frame.payload) > 24:
            fields["opcode"] = chr(frame.payload[24]) if 32 <= frame.payload[24] < 127 else frame.payload[24]
        self.log("frame", **fields)

    def analyze_raw_stream(self, raw: bytes, *, extracted: int, expected: int) -> None:
        """Summarize STCP frames present in the captured byte stream."""
        counts: dict[str, int] = {}
        offset = 0
        while offset < len(raw):
            try:
                frame, consumed = decode_frame(raw, offset)
            except ValueError as exc:
                self.log("decode_error", offset=offset, error=str(exc))
                offset = resync_offset(raw, offset)
                continue
            if frame is None or consumed == 0:
                break
            key = f"{frame.cmd.decode('ascii', errors='replace')}:{len(frame.payload)}"
            counts[key] = counts.get(key, 0) + 1
            offset += consumed

        self.log_stream_summary(
            raw_bytes=len(raw), extracted=extracted, expected=expected,
            frame_counts=counts, tail=raw[-STREAM_TAIL_BYTES:],
        )

    def log_stream_summary(
        self, *, raw_bytes: int, extracted: int, expected: int, frame_counts: dict[str, int], tail: bytes,
    ) -> None:
        """What a failed download's byte stream looked like: frame mix and its last bytes."""
        self.log(
            "stream_analysis",
            raw_bytes=raw_bytes,
            extracted_bytes=extracted,
            expected_bytes=expected,
            frame_counts=frame_counts,
            tail_hex=bytes(tail[-STREAM_TAIL_BYTES:]).hex(),
        )

    def close(self, *, status: str, **fields) -> None:
        self.log("session_end", status=status, **fields)
        self._fh.flush()
        self._fh.close()
