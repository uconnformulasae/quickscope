"""``/api/aim/pull`` must follow the RS3 connection sequence (QS_Pull_241/242 vs RS3_PULL_*).

List on the primary TCP -> release it -> aim-ka keep-alive for the whole
download loop -> stop keep-alive. Never open the legacy list TCP: the device
ignores it while the primary is open and the pull stalls ~37 s.
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
    monkeypatch.setattr(session_store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(session_store, "SESSIONS_FILE", tmp_path / "sessions.json")
    monkeypatch.setattr(session_store, "SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(session_store, "session_file_path", lambda name: sessions_dir / name)
    monkeypatch.setattr(
        "routes.sessions.aim_connector.discover_device",
        lambda: {"ip": "10.0.0.1", "ssid": "AiM-TEST", "device_name": ""},
    )
    monkeypatch.setattr(
        "routes.sessions.extract_session_info",
        lambda log, filename: {"metadata": {}, "durationMs": 0, "lapCount": 0},
    )
    monkeypatch.setattr("routes.sessions.parse_file", lambda path, *a, **k: object())

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


def _record_downloads(monkeypatch, hub, *, fail: bool = False):
    sizes: list[int] = []

    def _fake_download(filename, dest_dir, expected_size=0):
        keepalive = FakeKeepalive.instances[-1]
        hub.calls.append(
            f"download:{filename}:keepalive={'on' if keepalive.started and not keepalive.stopped else 'off'}"
        )
        sizes.append(expected_size)
        if fail:
            raise RuntimeError("device dropped")
        path = dest_dir / filename
        path.write_bytes(b"x" * 500)
        return path

    monkeypatch.setattr("routes.sessions.aim_connector.download_aim_session", _fake_download)
    return sizes


def test_pull_lists_on_primary_then_releases_then_downloads_with_keepalive(
    monkeypatch, pull_env
):
    # Arrange
    hub = pull_env
    sizes = _record_downloads(monkeypatch, hub)

    # Act
    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz", "a_0241.xrz"]})

    # Assert
    assert res.status_code == 200
    assert hub.calls == [
        "list_sessions",
        "release_for_download",
        "download:a_0242.xrz:keepalive=on",
        "download:a_0241.xrz:keepalive=on",
    ]
    assert sizes == [500, 0]  # size from the primary-TCP list; unknown file -> 0
    (keepalive,) = FakeKeepalive.instances
    assert keepalive.host == "10.0.0.1"
    assert keepalive.stopped


def test_pull_stops_keepalive_even_when_download_fails(monkeypatch, pull_env):
    hub = pull_env
    _record_downloads(monkeypatch, hub, fail=True)

    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz"]})

    assert res.status_code == 200
    assert res.json()["errors"]
    assert FakeKeepalive.instances[-1].stopped


def test_pull_continues_when_primary_list_times_out(monkeypatch, pull_env):
    hub = pull_env
    hub.list_error = TimeoutError("no session CSV")
    sizes = _record_downloads(monkeypatch, hub)

    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz"]})

    assert res.status_code == 200
    assert res.json()["downloaded"] == ["a_0242.xrz"]
    assert sizes == [0]


def test_pull_proceeds_without_keepalive_when_udp_unavailable(monkeypatch, pull_env):
    class _BrokenKeepalive(FakeKeepalive):
        async def start(self) -> None:
            raise OSError("address in use")

    monkeypatch.setattr("routes.sessions.AimKeepalive", _BrokenKeepalive)
    hub = pull_env
    downloads: list[str] = []

    def _fake_download(filename, dest_dir, expected_size=0):
        downloads.append(filename)
        path = dest_dir / filename
        path.write_bytes(b"x" * 500)
        return path

    monkeypatch.setattr("routes.sessions.aim_connector.download_aim_session", _fake_download)

    res = client.post("/api/aim/pull", json={"filenames": ["a_0242.xrz"]})

    assert res.status_code == 200
    assert downloads == ["a_0242.xrz"]
    assert not FakeKeepalive.instances[-1].stopped  # never started, so never stopped
