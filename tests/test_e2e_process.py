"""Launch the real backend the way the desktop app does, then drive it over HTTP.

Starts ``backend/entry.py`` (the PyInstaller entry point Electron spawns) as a
subprocess on a free port with its own data directory, exactly like a user
double-clicking QuickScope. Covers what in-process TestClient cannot:

* real uvicorn startup/shutdown and port binding
* serving requests on the main thread (the derived-channel SIGALRM timeout)
* data persisting across a full process restart
* live-view websocket handshake when no AiM device is reachable
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from conftest import REPO_ROOT, fixture_xrk

ENTRY = REPO_ROOT / "backend" / "entry.py"
STARTUP_TIMEOUT_S = 30

pytestmark = pytest.mark.e2e


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Backend:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.port = _free_port()
        self.proc: subprocess.Popen | None = None
        self.base = f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        env = {
            **os.environ,
            "QUICKSCOPE_HOST": "127.0.0.1",
            "QUICKSCOPE_PORT": str(self.port),
            "QUICKSCOPE_DATA_DIR": str(self.data_dir),
            "PYTHONUNBUFFERED": "1",
        }
        self.log_path = self.data_dir / "backend.log"
        self._log = self.log_path.open("ab")
        self.proc = subprocess.Popen(
            [sys.executable, str(ENTRY)],
            cwd=REPO_ROOT / "backend",
            env=env,
            stdout=self._log,
            stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + STARTUP_TIMEOUT_S
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                pytest.fail(f"backend exited early ({self.proc.returncode}):\n{self.log_tail()}")
            try:
                if httpx.get(f"{self.base}/api/settings", timeout=1).status_code == 200:
                    return
            except httpx.TransportError:
                time.sleep(0.2)
        self.stop()
        pytest.fail(f"backend did not start in {STARTUP_TIMEOUT_S}s:\n{self.log_tail()}")

    def stop(self) -> int | None:
        if self.proc is None:
            return None
        self.proc.terminate()
        try:
            code = self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            code = self.proc.wait()
        self._log.close()
        self.proc = None
        return code

    def log_tail(self) -> str:
        try:
            return self.log_path.read_text(errors="replace")[-3000:]
        except OSError:
            return "<no log>"


@pytest.fixture
def backend(tmp_path):
    data_dir = tmp_path / "userdata"
    data_dir.mkdir()
    b = Backend(data_dir)
    b.start()
    yield b
    b.stop()


def test_backend_boots_serves_defaults_and_shuts_down_cleanly(backend):
    res = httpx.get(f"{backend.base}/api/settings")
    assert res.json()["aim_device_port"] == 2000
    assert httpx.get(f"{backend.base}/api/sessions").json() == []
    assert httpx.get(f"{backend.base}/api/channels").status_code == 400
    assert httpx.get(f"{backend.base}/docs").status_code == 200
    assert backend.stop() in (0, -15, None)


def test_two_backends_do_not_share_data(tmp_path):
    a, b = Backend(tmp_path / "a"), Backend(tmp_path / "b")
    for x in (a, b):
        x.data_dir.mkdir()
        x.start()
    try:
        httpx.put(f"{a.base}/api/settings", json={"aim_wifi_ssid": "OnlyA"})
        assert httpx.get(f"{a.base}/api/settings").json()["aim_wifi_ssid"] == "OnlyA"
        assert httpx.get(f"{b.base}/api/settings").json()["aim_wifi_ssid"] != "OnlyA"
    finally:
        a.stop()
        b.stop()


def test_cors_allows_the_vite_dev_origin(backend):
    res = httpx.options(
        f"{backend.base}/api/sessions",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] in ("*", "http://localhost:5173")


@pytest.mark.skipif(fixture_xrk() is None, reason="no .xrk fixture")
def test_user_session_survives_quit_and_relaunch(backend):
    """Upload, analyse, quit the app, relaunch it, and pick the session back up."""
    xrk = fixture_xrk()
    with httpx.Client(base_url=backend.base, timeout=120) as c:
        up = c.post("/api/upload", files={"file": (xrk.name, xrk.read_bytes())})
        assert up.status_code == 200
        n_channels = len(up.json()["channels"])
        sid = c.get("/api/sessions").json()[0]["id"]
        rpm_before = c.get("/api/data", params={"channels": "RPM"}).json()["RPM"]

    assert backend.stop() in (0, -15)
    assert (backend.data_dir / "sessions" / xrk.name).stat().st_size == xrk.stat().st_size

    backend.port = _free_port()
    backend.base = f"http://127.0.0.1:{backend.port}"
    backend.start()
    with httpx.Client(base_url=backend.base, timeout=120) as c:
        sessions = c.get("/api/sessions").json()
        assert [s["id"] for s in sessions] == [sid]
        assert c.get("/api/channels").status_code == 400  # nothing active after restart
        loaded = c.post(f"/api/sessions/{sid}/load")
        assert loaded.status_code == 200
        assert len(loaded.json()["channels"]) == n_channels
        assert c.get("/api/data", params={"channels": "RPM"}).json()["RPM"] == rpm_before


@pytest.mark.skipif(fixture_xrk() is None, reason="no .xrk fixture")
def test_upload_logs_no_errors_and_removed_cloud_routes_are_gone(backend):
    xrk = fixture_xrk()
    with httpx.Client(base_url=backend.base, timeout=120) as c:
        assert c.post("/api/upload", files={"file": (xrk.name, xrk.read_bytes())}).status_code == 200
        sid = c.get("/api/sessions").json()[0]["id"]
        assert c.post("/api/sessions/sync").status_code in (404, 405)
        assert c.post(f"/api/sessions/{sid}/pull").status_code in (404, 405)
        assert "railway_url" not in c.get("/api/settings").json()
    log = backend.log_path.read_text(errors="replace")
    assert "Traceback" not in log
    assert "railway" not in log.lower()


def test_backend_migrates_a_cloud_sync_era_data_dir_on_boot(tmp_path):
    """A user upgrading from a Railway-synced install keeps local sessions only."""
    data = tmp_path / "userdata"
    (data / "sessions").mkdir(parents=True)
    (data / "sessions" / "kept.xrk").write_bytes(b"x")
    base = {"aim_session_id": "s", "created_at": "t", "updated_at": "t"}
    (data / "sessions.json").write_text(json.dumps([
        {**base, "id": "1", "filename": "kept.xrk", "local_path": str(data / "sessions" / "kept.xrk"),
         "source": "railway", "sync_status": "synced", "remote_id": 7},
        {**base, "id": "2", "filename": "cloud_only.xrk", "local_path": None,
         "source": "railway", "sync_status": "remote_only", "remote_id": 8},
    ]))
    (data / "settings.json").write_text(json.dumps({"railway_url": "https://x.up.railway.app/api/v1", "aim_device_ip": "10.1.1.1"}))

    b = Backend(data)
    b.start()
    try:
        sessions = httpx.get(f"{b.base}/api/sessions").json()
        assert [s["id"] for s in sessions] == ["1"]
        assert sessions[0]["source"] == "manual_upload"
        assert "sync_status" not in sessions[0] and "remote_id" not in sessions[0]
        settings = httpx.get(f"{b.base}/api/settings").json()
        assert settings["aim_device_ip"] == "10.1.1.1"
        assert "railway_url" not in settings
    finally:
        b.stop()


@pytest.mark.skipif(sys.platform == "win32", reason="SIGALRM timeout is POSIX-only (known issue)")
@pytest.mark.slow
def test_derived_script_timeout_fires_on_real_server(backend):
    res = httpx.post(
        f"{backend.base}/api/derived/evaluate",
        json={"expression": "while True:\n    pass", "channels": {}},
        timeout=30,
    )
    assert res.status_code == 400
    assert "timed out" in res.json()["detail"]
    # server must still be responsive afterwards
    assert httpx.get(f"{backend.base}/api/settings", timeout=5).status_code == 200


def test_derived_evaluate_works_on_real_server(backend):
    res = httpx.post(
        f"{backend.base}/api/derived/evaluate",
        json={
            "expression": "a = channels['A']\n"
            "result = {'timestamps': a['timestamps'], 'values': [v + 1 for v in a['values']]}",
            "channels": {"A": {"timestamps": [0, 1], "values": [1.0, 2.0]}},
        },
    )
    assert res.status_code == 200
    assert res.json()["values"] == [2.0, 3.0]


@pytest.mark.slow
def test_live_status_and_websocket_without_a_device(backend):
    """No AiM hardware: the live view must fail fast and visibly, not hang."""
    websockets = pytest.importorskip("websockets.sync.client")
    status = httpx.get(f"{backend.base}/api/live/status", timeout=30)
    assert status.status_code == 200
    assert status.json()["reachable"] is False

    url = f"ws://127.0.0.1:{backend.port}/api/live/ws?host=127.0.0.1"
    start = time.monotonic()
    try:
        with websockets.connect(url, open_timeout=10) as ws:
            first = json.loads(ws.recv(timeout=40))
            assert first["type"] in ("error", "connected", "status")
            if first["type"] == "error":
                assert first.get("message") or first.get("error")
    except Exception as exc:  # closed by server after reporting the error is fine
        assert time.monotonic() - start < 45, f"live ws hung: {exc!r}"
    # backend is still healthy and the hub lock was released
    assert httpx.get(f"{backend.base}/api/settings", timeout=5).status_code == 200


@pytest.mark.slow
def test_aim_status_reports_unreachable_device_quickly(backend):
    start = time.monotonic()
    res = httpx.get(f"{backend.base}/api/aim/status", timeout=30)
    assert res.status_code == 200
    assert isinstance(res.json(), dict)
    assert time.monotonic() - start < 20
