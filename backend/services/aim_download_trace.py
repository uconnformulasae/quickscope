"""
Persistent trace log for AiM file downloads.

Writes a human-readable timeline to backend/data/logs/aim_download/ so we can
diagnose truncated transfers without relying on console scrollback alone.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from services.aim_live import decode_frame

_LOG_DIR = Path(__file__).resolve().parent.parent / "data" / "logs" / "aim_download"


class AimDownloadTrace:
    def __init__(self, filename: str, expected_size: int = 0) -> None:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)
        self.path = _LOG_DIR / f"{stamp}_{safe}.log"
        self._fh = self.path.open("w", encoding="utf-8")
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
        self._fh.flush()

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
                next_h = raw.find(b"<h", offset + 1)
                if next_h == -1:
                    break
                offset = next_h
                continue
            if frame is None or consumed == 0:
                break
            key = f"{frame.cmd.decode('ascii', errors='replace')}:{len(frame.payload)}"
            counts[key] = counts.get(key, 0) + 1
            offset += consumed

        tail = raw[-256:] if len(raw) > 256 else raw
        self.log(
            "stream_analysis",
            raw_bytes=len(raw),
            extracted_bytes=extracted,
            expected_bytes=expected,
            frame_counts=counts,
            tail_hex=tail.hex(),
        )

    def close(self, *, status: str, **fields) -> None:
        self.log("session_end", status=status, **fields)
        self._fh.close()
