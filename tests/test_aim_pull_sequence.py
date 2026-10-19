"""``/api/aim/pull`` must follow the RS3 connection sequence (RS3_PULL_241/242).

List and every file download run on the primary TCP, which stays open. Only
when the primary fails does the route close it and retry the remaining files
over the legacy download TCP, with aim-ka running for that whole loop. Never
open the legacy list TCP: the device ignores it while the primary is open.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from conftest import FakeKeepalive, FakePullHub
from main import app
from services import aim_pull_log, session_store

client = TestClient(app)


@pytest.fixture
def pull_env(tmp_path, monkeypatch, fake_keepalive):
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    monkeypatch.setattr(session_store, "session_file_path", lambda name: sessions_dir / name)
    monkeypatch.setattr(
        "routes.sessions.aim_connector.discover_device",
        lambda: {"ip": "10.0.0.1", "ssid": "AiM-TEST", "device_name": ""},
    )
    monkeypatch.setattr(
        "services.aim_pull_indexer.extract_session_info",
        lambda log, filename: {"metadata": {}, "durationMs": 0, "lapCount": 0},
    )
    monkeypatch.setattr("services.aim_pull_indexer.parse_file", lambda path, *a, **k: object())

    def _legacy_list_forbidden():
        raise AssertionError("pull must not open the legacy session-list TCP")

    monkeypatch.setattr(
        "routes.sessions.aim_connector.list_aim_sessions", _legacy_list_forbidden
    )

    hub = FakePullHub([{"filename": "a_0242.xrz", "size": 500, "date": "", "hour": ""}])
    monkeypatch.setattr("routes.sessions.get_aim_primary_hub", lambda: hub)
    aim_pull_log.clear()
    yield hub
    aim_pull_log.clear()


def _record_legacy_downloads(monkeypatch, hub, *, fail: bool = False):
    sizes: list[int] = []

    def _fake_download(filename, dest_dir, expected_size=0, on_progress=None):
        keepalive = FakeKeepalive.instances[-1]
        hub.calls.append(
            f"legacy_download:{filename}:keepalive="
            f"{'on' if keepalive.started and not keepalive.stopped else 'off'}"
        )
        sizes.append(expected_size)
        if fail:
            raise RuntimeError("device dropped")
        path = dest_dir / filename
        path.write_bytes(b"x" * 500)
        return path

    monkeypatch.setattr("routes.sessions.aim_connector.download_aim_session", _fake_download)
    return sizes


def test_pull_downloads_every_file_on_the_primary_tcp(monkeypatch, pull_env):
    # Arrange
    hub = pull_env
    _record_legacy_downloads(monkeypatch, hub)

    # Act
    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz", "a_0241.xrz"]})

    # Assert: no release, no second TCP, no separate keepalive.
    assert res.status_code == 200
    assert hub.calls == [
        "list_sessions",
        "primary_download:a_0242.xrz",
        "primary_download:a_0241.xrz",
    ]
    assert res.json()["downloaded"] == ["a_0242.xrz", "a_0241.xrz"]
    assert FakeKeepalive.instances == []


def test_pull_falls_back_to_legacy_tcp_for_files_left_after_primary_failure(
    monkeypatch, pull_env
):
    # Arrange: first file lands on the primary, then the primary drops.
    hub = pull_env
    hub.primary_error = ConnectionError("AiM device closed the connection")
    hub.fail_primary_at = 2
    sizes = _record_legacy_downloads(monkeypatch, hub)

    # Act
    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz", "a_0241.xrz"]})

    # Assert
    assert res.status_code == 200
    assert hub.calls == [
        "list_sessions",
        "primary_download:a_0242.xrz",
        "release_for_download",
        "legacy_download:a_0241.xrz:keepalive=on",
    ]
    assert sizes == [0]  # a_0241 is not in the device list -> unknown size
    assert res.json()["downloaded"] == ["a_0242.xrz", "a_0241.xrz"]
    (keepalive,) = FakeKeepalive.instances
    assert keepalive.host == "10.0.0.1"
    assert keepalive.stopped


def test_pull_stops_keepalive_even_when_legacy_download_fails(monkeypatch, pull_env):
    hub = pull_env
    hub.primary_error = TimeoutError("no file size")
    _record_legacy_downloads(monkeypatch, hub, fail=True)

    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz"]})

    assert res.status_code == 200
    assert res.json()["errors"]
    assert FakeKeepalive.instances[-1].stopped


def test_pull_falls_back_when_primary_list_times_out(monkeypatch, pull_env):
    hub = pull_env
    hub.list_error = TimeoutError("no session CSV")
    sizes = _record_legacy_downloads(monkeypatch, hub)

    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz"]})

    assert res.status_code == 200
    assert res.json()["downloaded"] == ["a_0242.xrz"]
    assert sizes == [0]


def test_pull_refuses_while_live_view_owns_the_primary(monkeypatch, pull_env):
    from services.aim_primary_hub import AimLiveActiveError

    hub = pull_env

    async def _live_active(*_a, **_k):
        raise AimLiveActiveError("Close live view before downloading logs from the AiM device.")

    hub.download_sessions = _live_active

    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz"]})

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "live view" in body["error"]


def test_legacy_fallback_proceeds_without_keepalive_when_udp_unavailable(monkeypatch, pull_env):
    class _BrokenKeepalive(FakeKeepalive):
        async def start(self) -> None:
            raise OSError("address in use")

    monkeypatch.setattr("routes.sessions.AimKeepalive", _BrokenKeepalive)
    hub = pull_env
    hub.primary_error = ConnectionError("primary down")
    downloads: list[str] = []

    def _fake_download(filename, dest_dir, expected_size=0, on_progress=None):
        downloads.append(filename)
        path = dest_dir / filename
        path.write_bytes(b"x" * 500)
        return path

    monkeypatch.setattr("routes.sessions.aim_connector.download_aim_session", _fake_download)

    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz"]})

    assert res.status_code == 200
    assert downloads == ["a_0242.xrz"]
    assert not FakeKeepalive.instances[-1].stopped  # never started, so never stopped
