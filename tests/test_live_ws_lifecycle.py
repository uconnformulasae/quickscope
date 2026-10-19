"""Live WebSocket connect/teardown paths and the /api/live/status probe.

The AiM hub is faked so these run without hardware.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from services import aim_device_cache, aim_live, settings_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def _no_cached_device(monkeypatch):
    monkeypatch.setattr(aim_device_cache, "_cached", None)


class _Snap:
    def __init__(self, i: int) -> None:
        self.timestamp_ms = i
        self.subsystem = "Syst"
        self.raw_b64 = "AAAA"
        self.channels = {"RPM": float(i)}


class _Client:
    def __init__(self, *, identity=None, stream=None) -> None:
        self.identity = identity
        self._snapshots_yielded = 0
        self._poll_a_timeouts = 0
        self.on_status = None
        self._stream = stream

    async def stream(self):
        if self._stream is not None:
            async for item in self._stream(self):
                yield item
            return
        await asyncio.Event().wait()
        yield  # pragma: no cover


class _Hub:
    def __init__(self, live_client=None, acquire_error: BaseException | None = None) -> None:
        self.live_client = live_client or _Client()
        self.acquire_error = acquire_error
        self.acquired_hosts: list[str] = []
        self.release_calls = 0
        self.close_calls = 0

    async def acquire_for_live(self, host, *, trace=None):
        self.acquired_hosts.append(host)
        if self.acquire_error is not None:
            raise self.acquire_error
        return self.live_client

    async def release_live(self) -> None:
        self.release_calls += 1

    async def close_primary(self) -> None:
        self.close_calls += 1


def _identity(ip="10.0.0.1"):
    return SimpleNamespace(ip=ip, model="EVO5", serial="740", vehicle="CT16")


# ── connect ────────────────────────────────────────────────────────────────


def test_connect_failure_sends_error_and_closes():
    hub = _Hub(acquire_error=ConnectionRefusedError("device refused"))
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            assert ws.receive_json() == {"type": "error", "message": "device refused"}

    assert hub.release_calls == 0


def test_connect_timeout_without_message_gets_readable_error():
    hub = _Hub(acquire_error=TimeoutError())
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            msg = ws.receive_json()

    assert msg["type"] == "error"
    assert "TCP port 2000" in msg["message"]


def test_connect_uses_configured_ip_when_nothing_cached():
    settings_store.update({"aim_device_ip": "192.168.4.1"})
    hub = _Hub()
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            connected = ws.receive_json()
            ws.send_text("stop")

    assert hub.acquired_hosts == ["192.168.4.1"]
    assert connected == {
        "type": "connected",
        "device": {"ip": "192.168.4.1", "model": "", "serial": "", "vehicle": ""},
    }


def test_connect_prefers_cached_device_ip():
    aim_device_cache.record_tcp_device("10.0.0.42")
    hub = _Hub(live_client=_Client(identity=_identity("10.0.0.42")))
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            connected = ws.receive_json()
            ws.send_text("stop")

    assert hub.acquired_hosts == ["10.0.0.42"]
    assert connected["device"] == {
        "ip": "10.0.0.42",
        "model": "EVO5",
        "serial": "740",
        "vehicle": "CT16",
    }


# ── teardown ───────────────────────────────────────────────────────────────


def test_client_stop_releases_live_and_keeps_tcp_open():
    hub = _Hub()
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            ws.receive_json()
            ws.send_text("stop")

    assert hub.release_calls == 1
    assert hub.close_calls == 0


def test_device_drop_closes_primary_tcp_then_releases():
    async def dropping(_client):
        yield _Snap(0)
        raise ConnectionError("peer reset")

    hub = _Hub(live_client=_Client(identity=_identity(), stream=dropping))
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            ws.receive_json()  # connected
            try:
                while True:
                    ws.receive_json()
            except Exception:
                pass

    assert hub.close_calls == 1
    assert hub.release_calls == 1


def test_stream_ending_normally_releases_without_closing():
    async def finite(_client):
        yield _Snap(0)

    hub = _Hub(live_client=_Client(identity=_identity(), stream=finite))
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            ws.receive_json()  # connected
            try:
                while True:
                    ws.receive_json()
            except Exception:
                pass

    assert hub.close_calls == 0
    assert hub.release_calls == 1


def test_device_status_events_are_forwarded_and_handler_cleared():
    async def with_status(live_client):
        live_client.on_status({"state": "reconnecting", "attempt": 1})
        yield _Snap(0)
        await asyncio.Event().wait()

    live_client = _Client(identity=_identity(), stream=with_status)
    hub = _Hub(live_client=live_client)
    with patch("routes.live.get_aim_primary_hub", return_value=hub):
        with client.websocket_connect("/api/live/ws") as ws:
            ws.receive_json()  # connected
            messages: list[dict] = []
            while not any(m["type"] == "heartbeat" for m in messages):
                msg = ws.receive_json()
                messages.extend(msg["messages"] if msg["type"] == "batch" else [msg])
            ws.send_text("stop")

    assert {"type": "status", "state": "reconnecting", "attempt": 1} in messages
    assert any(m["type"] == "snapshot" for m in messages)
    assert live_client.on_status is None


# ── /api/live/status ───────────────────────────────────────────────────────


def test_live_status_reports_cached_device_without_probing(monkeypatch):
    aim_device_cache.record_identity("10.0.0.5", model="EVO5", serial="740", vehicle="CT16")

    async def fail_discover(*_a, **_k):
        pytest.fail("discover() should not run when a device is cached")

    monkeypatch.setattr(aim_live, "discover", fail_discover)

    res = client.get("/api/live/status")

    assert res.status_code == 200
    assert res.json() == {
        "reachable": True,
        "host": "10.0.0.5",
        "source": "cache",
        "device": {"ip": "10.0.0.5", "model": "EVO5", "serial": "740", "vehicle": "CT16"},
    }


def test_live_status_unreachable(monkeypatch):
    async def none(*_a, **_k):
        return None

    monkeypatch.setattr(aim_live, "discover", none)

    res = client.get("/api/live/status")

    assert res.json() == {"reachable": False, "host": "10.0.0.1"}


def test_live_status_reachable_via_discovery(monkeypatch):
    async def found(*_a, **_k):
        return _identity("10.0.0.9")

    monkeypatch.setattr(aim_live, "discover", found)

    res = client.get("/api/live/status")

    assert res.json() == {
        "reachable": True,
        "host": "10.0.0.9",
        "device": {"ip": "10.0.0.9", "model": "EVO5", "serial": "740", "vehicle": "CT16"},
    }
