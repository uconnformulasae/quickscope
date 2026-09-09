"""Tests for AiM pull session date handling."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from services import aim_pull_log, session_store
from state import (
    apply_stored_recorded_at,
    resolve_aim_recorded_at,
)

client = TestClient(app)


@pytest.fixture
def isolated_session_data(tmp_path, monkeypatch):
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
    return sessions_dir


@pytest.fixture(autouse=True)
def _clear_aim_pull_log():
    aim_pull_log.clear()
    yield
    aim_pull_log.clear()


def _setup_pull_mocks(monkeypatch: pytest.MonkeyPatch, isolated_session_data, *, device_sessions):
    monkeypatch.setattr(
        "routes.sessions.aim_connector.discover_device",
        lambda: {"ip": "10.0.0.1", "ssid": "AiM-TEST", "device_name": ""},
    )
    monkeypatch.setattr(
        "routes.sessions.sync_service.is_railway_configured",
        lambda: False,
    )
    monkeypatch.setattr(
        "routes.sessions.aim_connector.list_aim_sessions",
        lambda: device_sessions,
    )

    def _fake_download(filename: str, dest_dir, expected_size: int = 0):
        path = dest_dir / filename
        path.write_bytes(b"x" * 500)
        return path

    monkeypatch.setattr(
        "routes.sessions.aim_connector.download_aim_session",
        _fake_download,
    )

    def _fake_parse(path):
        class _Log:
            metadata = {
                "Vehicle": "V",
                "Driver": "D",
                "Log Date": "26/08/2026",
                "Log Time": "20:53:39",
                "Venue": "Track",
            }
            channels = {}
            laps = None

        return _Log()

    monkeypatch.setattr("routes.sessions.parse_file", _fake_parse)
    monkeypatch.setattr(
        "routes.sessions.extract_session_info",
        lambda log, filename: {
            "metadata": {
                "vehicle": "V",
                "driver": "D",
                "date": "26/08/2026",
                "time": "20:53:39",
                "venue": "Track",
                "championship": "",
                "sessionType": "",
                "comment": "",
            },
            "durationMs": 163_000,
            "lapCount": 1,
            "recordedAt": "2026-08-26T20:53:39",
        },
    )


def test_resolve_aim_recorded_at_prefers_device_date():
    result = resolve_aim_recorded_at(
        "01/09/2026",
        "14:30:00",
        "26/08/2026",
        "20:53:39",
    )
    assert result == "2026-09-01T14:30:00"


def test_resolve_aim_recorded_at_falls_back_to_xrk():
    result = resolve_aim_recorded_at("", "", "26/08/2026", "20:53:39")
    assert result == "2026-08-26T20:53:39"


def test_apply_stored_recorded_at_overrides_metadata():
    info = {
        "metadata": {"date": "26/08/2026", "time": "20:53:39"},
        "recordedAt": "2026-08-26T20:53:39",
    }
    updated = apply_stored_recorded_at(info, "2026-09-01T14:30:00")
    assert updated["recordedAt"] == "2026-09-01T14:30:00"
    assert updated["metadata"]["date"] == "01/09/2026"
    assert updated["metadata"]["time"] == "14:30:00"


def test_aim_pull_uses_device_date_over_xrk(
    monkeypatch: pytest.MonkeyPatch,
    isolated_session_data,
):
    _setup_pull_mocks(
        monkeypatch,
        isolated_session_data,
        device_sessions=[
            {
                "filename": "a_0116.xrz",
                "size": 500,
                "date": "01/09/2026",
                "hour": "14:30:00",
                "lap_count": 1,
                "vehicle": "V",
                "device_name": "EVO5",
            }
        ],
    )

    res = client.post("/api/aim/pull", json={"filenames": ["a_0116.xrz"]})
    assert res.status_code == 200

    sessions = session_store.list_sessions()
    assert len(sessions) == 1
    assert sessions[0]["recorded_at"] == "2026-09-01T14:30:00"


def test_aim_pull_falls_back_to_xrk_when_device_list_unavailable(
    monkeypatch: pytest.MonkeyPatch,
    isolated_session_data,
):
    _setup_pull_mocks(monkeypatch, isolated_session_data, device_sessions=[])

    def _fail_list():
        raise ConnectionError("device offline")

    monkeypatch.setattr(
        "routes.sessions.aim_connector.list_aim_sessions",
        _fail_list,
    )

    res = client.post("/api/aim/pull", json={"filenames": ["a_0116.xrz"]})
    assert res.status_code == 200

    sessions = session_store.list_sessions()
    assert len(sessions) == 1
    assert sessions[0]["recorded_at"] == "2026-08-26T20:53:39"


def test_load_session_uses_stored_recorded_at_for_aim_device(
    monkeypatch: pytest.MonkeyPatch,
    isolated_session_data,
):
    xrk_path = isolated_session_data / "a_0116.xrz"
    xrk_path.write_bytes(b"x" * 500)

    entry = session_store.add_session(
        filename="a_0116.xrz",
        source="aim_device",
        local_path=str(xrk_path),
        recorded_at="2026-09-01T14:30:00",
    )

    def _fake_parse(path):
        class _Log:
            metadata = {
                "Vehicle": "V",
                "Driver": "D",
                "Log Date": "26/08/2026",
                "Log Time": "20:53:39",
                "Venue": "Track",
            }
            channels = {}
            laps = None

        return _Log()

    monkeypatch.setattr("routes.sessions.parse_file", _fake_parse)

    res = client.post(f"/api/sessions/{entry['id']}/load")
    assert res.status_code == 200
    body = res.json()
    assert body["recordedAt"] == "2026-09-01T14:30:00"
    assert body["metadata"]["date"] == "01/09/2026"
    assert body["metadata"]["time"] == "14:30:00"
