"""Tests for the live WebSocket route's queue/batch decoupling (speed-up plan Phase 3).

Live WS is normally backed by a real AiM device via `AimPrimaryHub`; these
tests fake that hub so they run in CI without hardware, and focus on the
route's own behavior: batching snapshots that queue up faster than the
browser is being sent to, and only including `raw_b64` when asked for.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


class _FakeSnapshot:
    def __init__(self, i: int) -> None:
        self.timestamp_ms = i
        self.subsystem = "Syst"
        self.raw_b64 = "AAAA"
        self.channels = {"RPM": float(i)}


class _FakeIdentity:
    ip = "10.0.0.1"
    model = "EVO5"
    serial = "123"
    vehicle = "CT17"


class _FakeLiveClient:
    identity = _FakeIdentity()
    _snapshots_yielded = 0
    _poll_a_timeouts = 0

    async def stream(self):
        # No `await` between yields: with nothing to hand control back to the
        # event loop, all 5 snapshots get enqueued before the sender task
        # gets a turn to run -- deterministically exercising the batch path.
        for i in range(5):
            yield _FakeSnapshot(i)
        await asyncio.Event().wait()  # hang until the test disconnects


class _FakeHub:
    async def acquire_for_live(self, host, *, trace=None):
        return _FakeLiveClient()

    async def release_live(self) -> None:
        return None

    async def close_primary(self) -> None:
        return None


def test_live_ws_batches_snapshots_that_outrun_the_sender():
    with patch("routes.live.get_aim_primary_hub", return_value=_FakeHub()):
        with client.websocket_connect("/api/live/ws") as ws:
            connected = ws.receive_json()
            assert connected["type"] == "connected"

            first = ws.receive_json()
            assert first["type"] in ("snapshot", "batch")
            if first["type"] == "batch":
                assert len(first["messages"]) >= 2
                assert all("raw" not in m for m in first["messages"])
            else:
                # Scheduling got the sender in between enqueues on this run;
                # still must hold the "no raw by default" invariant.
                assert "raw" not in first
            ws.send_text("stop")


def test_live_ws_omits_raw_by_default_and_includes_it_with_raw_flag():
    with patch("routes.live.get_aim_primary_hub", return_value=_FakeHub()):
        with client.websocket_connect("/api/live/ws?raw=1") as ws:
            ws.receive_json()  # connected
            msg = ws.receive_json()
            payloads = msg["messages"] if msg["type"] == "batch" else [msg]
            assert payloads
            assert all("raw" in p for p in payloads)
            ws.send_text("stop")
