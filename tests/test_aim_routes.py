"""AiM device routes: session list, pull, and the pull log."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from conftest import FakePullHub
from main import app
from services import aim_pull_log, session_store

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

    class _FakeHub:
        async def list_sessions(self, host=None):  # noqa: ANN001
            return fake_sessions

    monkeypatch.setattr(
        "routes.sessions.get_aim_primary_hub",
        lambda: _FakeHub(),
    )

    res = client.get("/api/aim/sessions")

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

    class _FailHub:
        async def list_sessions(self, host=None):  # noqa: ANN001
            raise ConnectionError("Failed to connect to AiM device: timed out")

    monkeypatch.setattr(
        "routes.sessions.get_aim_primary_hub",
        lambda: _FailHub(),
    )

    res = client.get("/api/aim/sessions")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "Could not connect" in body["error"]

    log = aim_pull_log.list_recent()
    assert log[0]["status"] == "list_failed"


def test_aim_pull_downloads_indexes_and_logs(
    monkeypatch: pytest.MonkeyPatch, isolated_session_data, fake_keepalive
):
    monkeypatch.setattr(
        "routes.sessions.aim_connector.discover_device",
        lambda: {"ip": "10.0.0.1", "ssid": "AiM-TEST", "device_name": ""},
    )
    monkeypatch.setattr(
        "routes.sessions.get_aim_primary_hub",
        lambda: FakePullHub(),
    )

    def _fake_parse(path, *_args, **_kwargs):
        class _Log:
            metadata = {"Vehicle": "V", "Driver": "D", "Log Date": "", "Log Time": "", "Venue": ""}
            channels = {}
            laps = None

        return _Log()

    monkeypatch.setattr("services.aim_pull_indexer.parse_file", _fake_parse)
    monkeypatch.setattr(
        "services.aim_pull_indexer.extract_session_info",
        lambda log, filename: {
            "metadata": {},
            "durationMs": 0,
            "lapCount": 0,
        },
    )

    res = client.post(
        "/api/aim/pull",
        json={"filenames": ["pull_test.xrk"]},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["downloaded"] == ["pull_test.xrk"]
    assert body["results"][0]["bytes"] == 500
    assert "railway_queued" not in body["results"][0]
    stored = session_store.list_sessions()
    assert [s["filename"] for s in stored] == ["pull_test.xrk"]
    assert stored[0]["source"] == "aim_device"
    assert "sync_status" not in stored[0] and "remote_id" not in stored[0]
    # The pull returns before indexing; the indexer then marks the session.
    assert body["results"][0]["index_status"] == "pending"
    assert stored[0]["index_status"] == "ok"

    log = aim_pull_log.list_recent()
    assert log[0]["action"] == "pull"
    assert log[0]["status"] == "ok"
    assert "railway_queued" not in log[0]

    progress = client.get("/api/aim/pull/progress").json()
    assert progress["active"] is False
    assert progress["indexing"] == {"pull_test.xrk": "ok"}


def test_aim_pull_records_parse_failure_without_failing_the_download(
    monkeypatch: pytest.MonkeyPatch, isolated_session_data
):
    monkeypatch.setattr(
        "routes.sessions.aim_connector.discover_device",
        lambda: {"ip": "10.0.0.1", "ssid": "AiM-TEST", "device_name": ""},
    )
    monkeypatch.setattr("routes.sessions.get_aim_primary_hub", lambda: FakePullHub())

    def _broken_parse(path, *_args, **_kwargs):
        raise ValueError("corrupt xrk")

    monkeypatch.setattr("services.aim_pull_indexer.parse_file", _broken_parse)

    res = client.post("/api/aim/pull", json={"filenames": ["bad.xrk"]})

    assert res.status_code == 200
    assert res.json()["downloaded"] == ["bad.xrk"]
    (stored,) = session_store.list_sessions()
    assert stored["index_status"] == "failed"
    assert aim_pull_log.list_recent()[0]["status"] == "parse_failed"


def test_aim_pull_progress_endpoint_idle():
    res = client.get("/api/aim/pull/progress")
    assert res.status_code == 200
    body = res.json()
    assert body["active"] is False
    assert body["phase"] == "idle"


def test_aim_pull_log_endpoint():
    aim_pull_log.record(
        action="pull",
        status="ok",
        device_ip="10.0.0.1",
        filename="sample.xrk",
        size=100,
        duration_s=1.5,
        session_id="abc-123",
    )

    res = client.get("/api/aim/pull/log")
    assert res.status_code == 200
    entries = res.json()["entries"]
    assert len(entries) == 1
    assert entries[0]["filename"] == "sample.xrk"
    assert "railway_queued" not in entries[0]
