"""Regression tests for the "I/O operation on closed file" live-connect crash.

AimPrimaryHub keeps the underlying AimLiveClient (and its `_session_trace`
reference) alive across WebSocket reconnects to skip re-handshaking, but
each WS session's AimLiveTrace file is closed when that session ends
(routes/live.py's `finally: trace.close(...)`). A late event from a client
whose trace outlived it -- most reliably `close()` firing when a stale
client gets torn down on the *next* connect attempt -- used to raise
`ValueError: I/O operation on closed file`, which surfaced to the user as
"AiM connect failed: I/O operation on closed file."
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from services.aim_live_trace import AimLiveTrace  # noqa: E402
from services.aim_primary_hub import AimPrimaryHub  # noqa: E402


def test_trace_log_after_close_does_not_raise(tmp_path, monkeypatch):
    monkeypatch.setattr("services.aim_live_trace._SESSION_DIR", tmp_path)
    trace = AimLiveTrace(configured_host="10.0.0.1")
    trace.close(outcome="normal")

    # Simulates a stale AimLiveClient's close()/_emit_trace() firing on the
    # *next* connect attempt, after this session's trace file is closed.
    trace.log("client_close", snapshots=3, poll_a_timeouts=0)
    trace.close(outcome="already_closed")  # close() itself must be idempotent too


def test_trace_survives_write_after_underlying_file_closed_directly(tmp_path, monkeypatch):
    """Same failure mode, but the file handle is closed without going
    through `AimLiveTrace.close()` -- covers the `ValueError` catch path."""
    monkeypatch.setattr("services.aim_live_trace._SESSION_DIR", tmp_path)
    trace = AimLiveTrace(configured_host="10.0.0.1")
    trace._fh.close()  # bypass AimLiveTrace's own bookkeeping

    trace.log("client_close", snapshots=1, poll_a_timeouts=0)  # must not raise


class _FakeConnectedClient:
    """Stands in for a real AimLiveClient whose primary TCP is still up."""

    def __init__(self, host: str) -> None:
        self.host = host
        self._handshake_done = True
        self._session_trace = None

    @property
    def connected(self) -> bool:
        return True


def test_ensure_primary_rebinds_trace_on_reused_client(tmp_path, monkeypatch):
    """Regression test: reusing the cached client on a fast reconnect must
    repoint it at the *new* WS session's trace, not leave it referencing a
    trace file the previous session already closed.
    """
    monkeypatch.setattr("services.aim_live_trace._SESSION_DIR", tmp_path)

    async def body() -> None:
        hub = AimPrimaryHub()
        hub._client = _FakeConnectedClient("10.0.0.1")

        old_trace = AimLiveTrace(configured_host="10.0.0.1")
        hub._client._session_trace = old_trace
        old_trace.close(outcome="normal")  # previous WS session ended

        new_trace = AimLiveTrace(configured_host="10.0.0.1")
        client = await hub.ensure_primary("10.0.0.1", trace=new_trace)

        assert client is hub._client
        assert client._session_trace is new_trace
        new_trace.close(outcome="normal")

    asyncio.run(body())
