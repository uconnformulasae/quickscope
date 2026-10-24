"""Tests for the live WebSocket route's queue/batch decoupling (speed-up plan Phase 3).

Live WS is normally backed by a real AiM device via `AimPrimaryHub`; these
tests fake that hub so they run in CI without hardware, and focus on the
route's own behavior: batching snapshots that queue up faster than the
browser is being sent to, and only including `raw_b64` when asked for.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
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
    channel_units = {"RPM": "rpm"}
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


class _RecordingHub(_FakeHub):
    def __init__(self, live_client=None) -> None:
        self.live_client = live_client or _FakeLiveClient()
        self.released = 0
        self.closed_primary = 0

    async def acquire_for_live(self, host, *, trace=None):
        return self.live_client

    async def release_live(self) -> None:
        self.released += 1

    async def close_primary(self) -> None:
        self.closed_primary += 1


class _BrokenIdentityClient(_FakeLiveClient):
    """Fails between the hub acquire and the "connected" frame."""

    @property
    def identity(self):
        raise RuntimeError("socket died during handshake")


def test_live_ws_releases_the_hub_when_setup_fails_after_acquire():
    """The release used to sit in a `finally` that only began 140 lines after
    the acquire, so a failure in between wedged the hub lock forever."""
    hub = _RecordingHub(_BrokenIdentityClient())
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        try:
            with client.websocket_connect("/api/live/ws") as ws:
                ws.receive_json()
        except Exception:
            pass
    assert hub.released == 1


class _DroppingLiveClient(_FakeLiveClient):
    async def stream(self):
        yield _FakeSnapshot(0)
        raise ConnectionError("device closed TCP")


def test_live_ws_delivers_the_device_drop_error_before_closing(monkeypatch):
    """The pump's error frame used to be cancelled along with the sender, so
    the browser only saw a bare socket close."""
    from starlette.websockets import WebSocket

    # A real network send yields to the event loop; the test client's doesn't,
    # which hides the race. Make each send take a moment, like a real socket.
    original_send_json = WebSocket.send_json

    async def slow_send_json(self, data, mode="text"):
        await asyncio.sleep(0.02)
        await original_send_json(self, data, mode)

    monkeypatch.setattr(WebSocket, "send_json", slow_send_json)
    hub = _RecordingHub(_DroppingLiveClient())
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            assert ws.receive_json()["type"] == "connected"
            messages = []
            while not any(m.get("type") == "error" for m in messages):
                msg = ws.receive_json()
                messages.extend(msg["messages"] if msg["type"] == "batch" else [msg])
    error = next(m for m in messages if m["type"] == "error")
    assert "closed the live connection" in error["message"]
    assert hub.closed_primary == 1 and hub.released == 1


def test_live_ws_rejects_a_foreign_origin():
    """CORS doesn't cover WebSockets: any page could otherwise drive the logger."""
    from starlette.websockets import WebSocketDisconnect

    hub = _RecordingHub()
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        for origin in ("https://evil.example", "null"):
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect("/api/live/ws", headers={"origin": origin}):
                    pass
            assert exc.value.code == 1008
    assert hub.released == 0  # never got as far as the device


def test_live_ws_accepts_the_app_and_dev_origins():
    for origin in ("app://quickscope", "http://localhost:5173", "http://127.0.0.1:8000"):
        with patch("routes.live.get_aim_primary_hub", return_value=_FakeHub()):
            with client.websocket_connect("/api/live/ws", headers={"origin": origin}) as ws:
                assert ws.receive_json()["type"] == "connected"
                ws.send_text("stop")


def test_live_ws_caches_seen_channel_names_for_the_offline_editor():
    import time

    from services import live_channel_cache

    with patch("routes.live.get_aim_primary_hub", return_value=_FakeHub()):
        with client.websocket_connect("/api/live/ws") as ws:
            ws.receive_json()  # connected
            ws.receive_json()  # first snapshot / batch
            ws.send_text("stop")

    # The cache write runs in a worker thread off the device pump.
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and not live_channel_cache.get("ev")["channels"]:
        time.sleep(0.02)
    cached = live_channel_cache.get("ev")
    assert cached["channels"] == ["RPM"]
    assert cached["vehicle"] == "CT17"
    assert cached["serial"] == "123"


def test_live_ws_sends_channel_units_once_per_layout():
    with patch("routes.live.get_aim_primary_hub", return_value=_FakeHub()):
        with client.websocket_connect("/api/live/ws") as ws:
            ws.receive_json()  # connected
            msg = ws.receive_json()
            snaps = msg["messages"] if msg["type"] == "batch" else [msg]
            while len(snaps) < 2:
                nxt = ws.receive_json()
                snaps += nxt["messages"] if nxt["type"] == "batch" else [nxt]
            ws.send_text("stop")
    assert snaps[0]["units"] == {"RPM": "rpm"}
    assert all("units" not in s for s in snaps[1:])
