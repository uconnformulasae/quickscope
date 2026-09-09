"""Tests for AiM / Railway decoupling."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from services import aim_pull_log, session_store
from state import background_sync

client = TestClient(app)


@pytest.fixture
def isolated_session_data(tmp_path, monkeypatch):
    """Keep integration tests from writing fake sessions into backend/data."""
    data_dir = tmp_path / "data"
    sessions_dir = data_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    monkeypatch.setattr(session_store, "DATA_DIR", data_dir)
    monkeypatch.setattr(session_store, "SESSIONS_FILE", data_dir / "sessions.json")
    monkeypatch.setattr(session_store, "SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(
        session_store,
        "session_file_path",
        lambda filename: sessions_dir / filename,
    )
    return data_dir


@pytest.fixture(autouse=True)
def _clear_aim_pull_log():
    aim_pull_log.clear()
    yield
    aim_pull_log.clear()


def test_aim_sessions_succeeds_without_udp_probe(monkeypatch: pytest.MonkeyPatch):
    """TCP list should work even when UDP discovery would fail."""
    monkeypatch.setattr(
        "routes.sessions.aim_connector.discover_device",
        lambda: None,
    )
    fake_sessions = [
        {
            "filename": "test_session.xrk",
            "size": 1234,
            "date": "01/01/2026",
            "hour": "12:00:00",
            "lap_count": 3,
            "vehicle": "TestCar",
            "device_name": "EVO5",
        }
    ]
    monkeypatch.setattr(
        "routes.sessions.aim_connector.list_aim_sessions",
        lambda: fake_sessions,
    )

    with patch("routes.sessions.railway_client.list_remote_sessions", new_callable=AsyncMock) as mock_railway:
        res = client.get("/api/aim/sessions")
        mock_railway.assert_not_called()

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["sessions"][0]["filename"] == "test_session.xrk"
    assert body["sessions"][0]["already_downloaded"] is False

    log = aim_pull_log.list_recent()
    assert len(log) == 1
    assert log[0]["action"] == "list"
    assert log[0]["status"] == "list_ok"
    assert log[0]["session_count"] == 1


def test_aim_sessions_returns_error_on_connection_failure(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "routes.sessions.aim_connector.discover_device",
        lambda: None,
    )

    def _fail():
        raise ConnectionError("Failed to connect to AiM device: timed out")

    monkeypatch.setattr("routes.sessions.aim_connector.list_aim_sessions", _fail)

    res = client.get("/api/aim/sessions")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "Could not connect" in body["error"]

    log = aim_pull_log.list_recent()
    assert log[0]["status"] == "list_failed"


def test_aim_pull_does_not_require_railway(monkeypatch: pytest.MonkeyPatch, isolated_session_data):
    monkeypatch.setattr(
        "routes.sessions.aim_connector.discover_device",
        lambda: {"ip": "10.0.0.1", "ssid": "AiM-TEST", "device_name": ""},
    )
    monkeypatch.setattr(
        "routes.sessions.sync_service.is_railway_configured",
        lambda: False,
    )

    dest_parent = None

    def _fake_download(filename: str, dest_dir, expected_size: int = 0):
        nonlocal dest_parent
        dest_parent = dest_dir
        path = dest_dir / filename
        path.write_bytes(b"x" * 500)
        return path

    monkeypatch.setattr(
        "routes.sessions.aim_connector.list_aim_sessions",
        lambda: [],
    )

    monkeypatch.setattr(
        "routes.sessions.aim_connector.download_aim_session",
        _fake_download,
    )

    def _fake_parse(path):
        class _Log:
            metadata = {"Vehicle": "V", "Driver": "D", "Log Date": "", "Log Time": "", "Venue": ""}
            channels = {}
            laps = None

        return _Log()

    monkeypatch.setattr("routes.sessions.parse_file", _fake_parse)
    monkeypatch.setattr(
        "routes.sessions.extract_session_info",
        lambda log, filename: {
            "metadata": {},
            "durationMs": 0,
            "lapCount": 0,
        },
    )

    with patch("routes.sessions.railway_client.list_remote_sessions", new_callable=AsyncMock) as mock_railway:
        res = client.post(
            "/api/aim/pull",
            json={"filenames": ["pull_test.xrk"]},
        )
        mock_railway.assert_not_called()

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["downloaded"] == ["pull_test.xrk"]
    assert body["results"][0]["bytes"] == 500
    assert body["results"][0]["railway_queued"] is False
    assert body["results"][0]["parse_ok"] is True

    log = aim_pull_log.list_recent()
    assert log[0]["action"] == "pull"
    assert log[0]["status"] == "ok"
    assert log[0]["railway_queued"] is False


def test_background_sync_skips_when_railway_unconfigured(monkeypatch: pytest.MonkeyPatch):
    import asyncio

    monkeypatch.setattr(
        "state.sync_service.is_railway_configured",
        lambda: False,
    )

    with patch("state.sync_service.sync_with_railway", new_callable=AsyncMock) as mock_sync:
        asyncio.run(background_sync())
        mock_sync.assert_not_called()


def test_aim_pull_log_endpoint():
    aim_pull_log.record(
        action="pull",
        status="ok",
        device_ip="10.0.0.1",
        filename="sample.xrk",
        size=100,
        duration_s=1.5,
        session_id="abc-123",
        railway_queued=False,
    )

    res = client.get("/api/aim/pull/log")
    assert res.status_code == 200
    entries = res.json()["entries"]
    assert len(entries) == 1
    assert entries[0]["filename"] == "sample.xrk"
    assert entries[0]["railway_queued"] is False
