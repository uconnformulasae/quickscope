"""End-to-end API workflow against a synthetic session (no .xrk, no hardware).

Drives the real FastAPI app through the same sequence a user follows in the UI:
launch -> upload -> browse -> analyse -> export -> rename -> relaunch -> delete.
The parser is stubbed to return a known three-lap log, so every assertion can be
checked against values we constructed rather than "whatever the parser gave us".
"""

from __future__ import annotations

import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

from services import session_store
from services.session_cache import session_cache
from state import state

FAKE_XRK = ("run1.xrk", b"not-a-real-xrk", "application/octet-stream")


def upload(client: TestClient, name: str = "run1.xrk"):
    return client.post("/api/upload", files={"file": (name, b"bytes", "application/octet-stream")})


# ─── Launch state ────────────────────────────────────────────────────────────


def test_fresh_launch_has_no_sessions_and_no_active_log(client_with_synthetic_log):
    c = client_with_synthetic_log
    assert c.get("/api/sessions").json() == []
    for path in ("/api/channels", "/api/laps", "/api/gps"):
        assert c.get(path).status_code == 400, path
    assert c.get("/api/data", params={"channels": "RPM"}).status_code == 400
    assert c.get("/api/export", params={"channels": "RPM"}).status_code == 400


def test_settings_defaults_are_exposed_on_launch(client_with_synthetic_log):
    body = client_with_synthetic_log.get("/api/settings").json()
    assert body["aim_device_ip"] == "10.0.0.1"
    assert body["aim_device_port"] == 2000
    assert "railway_url" not in body


# ─── Upload ──────────────────────────────────────────────────────────────────


def test_upload_returns_session_info(client_with_synthetic_log):
    res = upload(client_with_synthetic_log)
    assert res.status_code == 200
    info = res.json()

    assert info["metadata"]["driver"] == "Test Driver"
    assert info["metadata"]["venue"] == "Test Track"
    assert info["metadata"]["vehicle"] == "CT17"
    assert info["lapCount"] == 3
    assert info["recordedAt"] == "2026-10-05T14:30:00"
    names = [c["name"] for c in info["channels"]]
    assert names == sorted(names)
    assert set(names) == {"RPM", "Throttle_Pos", "GPS Latitude", "GPS Longitude", "GPS Speed"}

    by_name = {c["name"]: c for c in info["channels"]}
    assert by_name["RPM"]["sampleCount"] == 9001
    assert by_name["RPM"]["sampleRateHz"] == pytest.approx(100.0, abs=0.1)
    assert by_name["Throttle_Pos"]["sampleRateHz"] == pytest.approx(50.0, abs=0.1)
    assert by_name["RPM"]["units"] == "rpm"
    # duration comes from non-GPS channels
    assert info["durationMs"] == 90_000
    assert info["totalSamples"] == sum(c["sampleCount"] for c in info["channels"])


def test_upload_persists_file_and_index_entry(client_with_synthetic_log, isolated_data_dir):
    upload(client_with_synthetic_log)

    sessions = client_with_synthetic_log.get("/api/sessions").json()
    assert len(sessions) == 1
    entry = sessions[0]
    assert entry["filename"] == "run1.xrk"
    assert entry["source"] == "manual_upload"
    assert entry["lap_count"] == 3
    assert entry["duration_s"] == 90
    assert entry["driver_name"] == "Test Driver"

    stored_file = isolated_data_dir / "sessions" / "run1.xrk"
    assert stored_file.read_bytes() == b"bytes"
    on_disk = json.loads((isolated_data_dir / "sessions.json").read_text())
    assert [s["id"] for s in on_disk] == [entry["id"]]


def test_upload_makes_session_active(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    assert state.loaded
    assert state.filename == "run1.xrk"
    assert state.session_id == client_with_synthetic_log.get("/api/sessions").json()[0]["id"]


def test_reupload_same_filename_does_not_duplicate(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    upload(client_with_synthetic_log)
    assert len(client_with_synthetic_log.get("/api/sessions").json()) == 1


@pytest.mark.parametrize("name", ["notes.txt", "run.csv", "run", "run.xrk.exe", ""])
def test_upload_rejects_non_xrk_extensions(client_with_synthetic_log, name):
    res = client_with_synthetic_log.post(
        "/api/upload", files={"file": (name, b"x", "application/octet-stream")}
    )
    assert res.status_code in (400, 422)
    assert client_with_synthetic_log.get("/api/sessions").json() == []


def test_upload_accepts_uppercase_extension(client_with_synthetic_log):
    assert upload(client_with_synthetic_log, "RUN.XRK").status_code == 200


def test_upload_sanitizes_path_traversal(client_with_synthetic_log, isolated_data_dir):
    res = upload(client_with_synthetic_log, "../../evil name!.xrk")
    assert res.status_code == 200
    entry = client_with_synthetic_log.get("/api/sessions").json()[0]
    assert "/" not in entry["filename"] and "\\" not in entry["filename"]
    assert entry["filename"].endswith(".xrk")
    saved = list((isolated_data_dir / "sessions").iterdir())
    assert len(saved) == 1
    assert saved[0].parent == isolated_data_dir / "sessions"
    assert not (isolated_data_dir.parent / "evil name!.xrk").exists()


def test_upload_parse_failure_cleans_up(monkeypatch, isolated_data_dir):
    from main import app

    def boom(*_a, **_k):
        raise ValueError("corrupt")

    monkeypatch.setattr("routes.analysis.parse_file", boom)
    with TestClient(app) as c:
        res = upload(c, "bad.xrk")
        assert res.status_code == 500
        assert c.get("/api/sessions").json() == []
        assert not (isolated_data_dir / "sessions" / "bad.xrk").exists()
        assert not state.loaded
        log = c.get("/api/uploads/log").json()["entries"]
        assert log[0]["status"] == "parse_failed"
        assert log[0]["filename"] == "bad.xrk"


def test_upload_log_records_success_newest_first(client_with_synthetic_log):
    upload(client_with_synthetic_log, "a.xrk")
    upload(client_with_synthetic_log, "b.xrk")
    entries = client_with_synthetic_log.get("/api/uploads/log").json()["entries"]
    assert [e["filename"] for e in entries] == ["b.xrk", "a.xrk"]
    assert {e["status"] for e in entries} == {"ok"}
    assert all(e["size"] == 5 for e in entries)


# ─── Channels & data ─────────────────────────────────────────────────────────


def test_channels_lists_every_channel_with_unique_colors_and_units(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    channels = client_with_synthetic_log.get("/api/channels").json()["channels"]
    assert [c["name"] for c in channels] == sorted(c["name"] for c in channels)
    assert [c["index"] for c in channels] == list(range(len(channels)))
    assert len({c["color"] for c in channels}) == len(channels)
    units = {c["name"]: c["units"] for c in channels}
    assert units["GPS Speed"] == "m/s"
    assert units["Throttle_Pos"] == "%"


def test_data_returns_aligned_monotonic_series(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    res = client_with_synthetic_log.get("/api/data", params={"channels": "RPM,Throttle_Pos"})
    body = res.json()
    assert set(body) == {"RPM", "Throttle_Pos"}
    for name, series in body.items():
        assert len(series["timestamps"]) == len(series["values"]) > 0, name
        assert series["timestamps"] == sorted(series["timestamps"]), name
    assert body["RPM"]["timestamps"][0] == 0
    assert body["RPM"]["timestamps"][-1] == 90_000
    assert body["RPM"]["values"][0] == 3000.0


def test_data_ignores_unknown_channels_and_whitespace(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    body = client_with_synthetic_log.get(
        "/api/data", params={"channels": " RPM , Nope ,, "}
    ).json()
    assert list(body) == ["RPM"]


def test_data_requires_channels_param(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    assert client_with_synthetic_log.get("/api/data").status_code == 422


# ─── Laps & GPS ──────────────────────────────────────────────────────────────


def test_laps_prefer_device_markers(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    body = client_with_synthetic_log.get("/api/laps").json()
    assert body["source"] == "device"
    assert [(l["startTime"], l["endTime"]) for l in body["laps"]] == [
        (0, 30_000),
        (30_000, 60_000),
        (60_000, 90_000),
    ]
    assert [l["lapNumber"] for l in body["laps"]] == [0, 1, 2]


def test_laps_fall_back_to_gps_when_device_has_none(monkeypatch, synthetic_log, isolated_data_dir):
    from main import app
    
    synthetic_log.laps = synthetic_log.laps.slice(0, 0)
    monkeypatch.setattr("routes.analysis.parse_file", lambda *a, **k: synthetic_log)
    with TestClient(app) as c:
        upload(c)
        body = c.get("/api/laps").json()
    assert body["source"] == "gps_auto"
    assert len(body["laps"]) >= 2
    for prev, nxt in zip(body["laps"], body["laps"][1:]):
        assert prev["endTime"] <= nxt["startTime"] + 1
    assert all(l["endTime"] > l["startTime"] for l in body["laps"])


def test_gps_returns_track_with_relative_time(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    gps = client_with_synthetic_log.get("/api/gps").json()["gps"]
    n = len(gps["lat"])
    assert n == len(gps["lon"]) == len(gps["speed"]) == len(gps["timestamps"]) > 100
    assert gps["timestamps"][0] == 0
    assert all(41.79 < v < 41.81 for v in gps["lat"])
    assert all(-72.21 < v < -72.19 for v in gps["lon"])
    assert min(gps["speed"]) >= 15.0


def test_gps_is_null_when_session_has_no_gps(monkeypatch, isolated_data_dir):
    from main import app
    from conftest import make_log

    log = make_log({"RPM": ([0, 10, 20], [1.0, 2.0, 3.0], "rpm")})
    monkeypatch.setattr("routes.analysis.parse_file", lambda *a, **k: log)
    with TestClient(app) as c:
        upload(c)
        assert c.get("/api/gps").json() == {"gps": None}


def test_gps_drops_zero_fixes(monkeypatch, isolated_data_dir):
    from main import app
    from conftest import make_log

    ts = [0, 100, 200, 300]
    log = make_log(
        {
            "GPS Latitude": (ts, [0.0, 41.8, 41.8001, 0.0], "deg"),
            "GPS Longitude": (ts, [0.0, -72.2, -72.2001, 0.0], "deg"),
        }
    )
    monkeypatch.setattr("routes.analysis.parse_file", lambda *a, **k: log)
    with TestClient(app) as c:
        upload(c)
        gps = c.get("/api/gps").json()["gps"]
    assert len(gps["lat"]) == 2
    assert gps["timestamps"] == [100 - 0, 200 - 0]


# ─── Export ──────────────────────────────────────────────────────────────────


def _export(c: TestClient, channels: str):
    res = c.get("/api/export", params={"channels": channels})
    assert res.status_code == 200
    return res, list(csv.reader(io.StringIO(res.text)))


def test_export_csv_shape_headers_and_download_name(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    res, rows = _export(client_with_synthetic_log, "RPM,Throttle_Pos")

    assert res.headers["content-type"].startswith("text/csv")
    assert res.headers["content-disposition"] == 'attachment; filename="run1_export.csv"'
    assert rows[0] == ["Time (s)", "RPM (rpm)", "Throttle_Pos (%)"]
    assert len(rows) - 1 == 9001  # timebase = RPM (100 Hz)
    assert rows[1] == ["0.000000", "3000.00000", "0.00000"]
    assert float(rows[-1][0]) == pytest.approx(90.0)


def test_export_interpolates_slower_channel_onto_timebase(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    _, rows = _export(client_with_synthetic_log, "RPM,Throttle_Pos")
    # Throttle samples every 20 ms. At t=10ms (row 2) the value is halfway
    # between throttle[0]=0 and throttle[1]=1.
    assert rows[2][0] == "0.010000"
    assert float(rows[2][2]) == pytest.approx(0.5, abs=1e-4)


def test_export_errors(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    c = client_with_synthetic_log
    assert c.get("/api/export", params={"channels": ""}).status_code == 400
    assert c.get("/api/export", params={"channels": " , "}).status_code == 400
    assert c.get("/api/export", params={"channels": "Nope"}).status_code == 400
    assert c.get("/api/export").status_code == 422


def test_export_skips_unknown_channels_but_keeps_valid_ones(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    _, rows = _export(client_with_synthetic_log, "Nope,RPM")
    assert rows[0] == ["Time (s)", "RPM (rpm)"]


# ─── Derived channels ────────────────────────────────────────────────────────

@pytest.fixture
def no_sigalrm(monkeypatch):
    """The derived-channel timeout uses SIGALRM, which only works on the main thread.

    Starlette's TestClient serves requests from a worker thread, so in-process
    tests stub the alarm out. The real timeout is exercised against a live
    uvicorn process in test_e2e_process.py.
    """
    import signal

    monkeypatch.setattr(signal, "signal", lambda *a, **k: None)
    monkeypatch.setattr(signal, "alarm", lambda *a, **k: 0)


SERIES = {"A": {"timestamps": [0, 1000, 2000], "values": [1.0, 2.0, 3.0]}}


def evaluate(c: TestClient, expression: str, channels: dict | None = None):
    return c.post(
        "/api/derived/evaluate",
        json={"expression": expression, "channels": SERIES if channels is None else channels},
    )


def test_derived_scales_channel(client_with_synthetic_log, no_sigalrm):
    res = evaluate(
        client_with_synthetic_log,
        "a = channels['A']\n"
        "result = {'timestamps': a['timestamps'], 'values': [v * 2 for v in a['values']]}",
    )
    assert res.status_code == 200
    assert res.json() == {"timestamps": [0, 1000, 2000], "values": [2.0, 4.0, 6.0]}


def test_derived_can_use_numpy_math_and_interpolate(client_with_synthetic_log, no_sigalrm):
    res = evaluate(
        client_with_synthetic_log,
        "a = channels['A']\n"
        "ts = np.array(a['timestamps'])\n"
        "vals = np.array(a['values']) ** 2\n"
        "mid = interpolate(a, 500)\n"
        "result = {'timestamps': ts, 'values': vals + math.floor(mid)}",
    )
    assert res.status_code == 200
    assert res.json()["values"] == [2.0, 5.0, 10.0]


@pytest.mark.parametrize(
    "expression, fragment",
    [
        ("x = 1", "result"),
        ("result = 5", "dict"),
        ("result = {'timestamps': [1]}", "dict"),
        ("result = {'timestamps': [1, 2], 'values': [1]}", ""),
        ("this is not python", "Execution error"),
        ("result = 1 / 0", "ZeroDivisionError"),
        ("import os", "not allowed"),
        ("open('/etc/passwd')", "Execution error"),
        ("__import__('os')", "not allowed"),
    ],
)
def test_derived_rejects_bad_scripts(client_with_synthetic_log, expression, fragment, no_sigalrm):
    res = evaluate(client_with_synthetic_log, expression)
    assert res.status_code == 400
    assert fragment in res.json()["detail"]


def test_derived_rejects_oversized_expression(client_with_synthetic_log, no_sigalrm):
    res = evaluate(client_with_synthetic_log, "x" * 50_001)
    assert res.status_code == 400
    assert "too long" in res.json()["detail"]


# ─── Session browser actions ─────────────────────────────────────────────────


def test_load_session_after_backend_restart_reparses_from_disk(
    monkeypatch, synthetic_log, isolated_data_dir
):
    """Quit and relaunch: in-memory cache is empty, sessions.json + file remain."""
    from main import app

    monkeypatch.setattr("routes.analysis.parse_file", lambda *a, **k: synthetic_log)
    monkeypatch.setattr("routes.sessions.parse_file", lambda *a, **k: synthetic_log)

    with TestClient(app) as c:
        upload(c)
        session_id = c.get("/api/sessions").json()[0]["id"]

    # --- "restart" ---
    session_cache.clear()
    state.clear()

    with TestClient(app) as c:
        assert [s["id"] for s in c.get("/api/sessions").json()] == [session_id]
        assert c.get("/api/channels").status_code == 400  # nothing active yet
        res = c.post(f"/api/sessions/{session_id}/load")
        assert res.status_code == 200
        assert res.json()["lapCount"] == 3
        assert len(c.get("/api/channels").json()["channels"]) == 5


def test_load_unknown_session_is_404(client_with_synthetic_log):
    assert client_with_synthetic_log.post("/api/sessions/nope/load").status_code == 404


def test_load_session_with_missing_file_is_reported(client_with_synthetic_log, isolated_data_dir):
    upload(client_with_synthetic_log)
    sid = client_with_synthetic_log.get("/api/sessions").json()[0]["id"]
    (isolated_data_dir / "sessions" / "run1.xrk").unlink()
    session_cache.clear()
    res = client_with_synthetic_log.post(f"/api/sessions/{sid}/load")
    assert res.status_code in (400, 404, 410)


def test_rename_moves_file_and_updates_index(client_with_synthetic_log, isolated_data_dir):
    upload(client_with_synthetic_log)
    sid = client_with_synthetic_log.get("/api/sessions").json()[0]["id"]

    res = client_with_synthetic_log.post(f"/api/sessions/{sid}/rename", json={"filename": "Heat 2"})
    assert res.status_code == 200
    assert res.json()["filename"] == "Heat_2.xrk"  # sanitized + original extension kept
    sessions_dir = isolated_data_dir / "sessions"
    assert not (sessions_dir / "run1.xrk").exists()
    assert (sessions_dir / "Heat_2.xrk").read_bytes() == b"bytes"
    assert client_with_synthetic_log.get("/api/sessions").json()[0]["aim_session_id"] == "Heat_2"


def test_rename_conflict_and_missing(client_with_synthetic_log):
    upload(client_with_synthetic_log, "a.xrk")
    upload(client_with_synthetic_log, "b.xrk")
    sessions = {s["filename"]: s["id"] for s in client_with_synthetic_log.get("/api/sessions").json()}
    res = client_with_synthetic_log.post(
        f"/api/sessions/{sessions['a.xrk']}/rename", json={"filename": "b.xrk"}
    )
    assert res.status_code == 409
    assert client_with_synthetic_log.post(
        "/api/sessions/nope/rename", json={"filename": "x.xrk"}
    ).status_code == 404


def test_rename_to_same_name_is_allowed(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    sid = client_with_synthetic_log.get("/api/sessions").json()[0]["id"]
    res = client_with_synthetic_log.post(f"/api/sessions/{sid}/rename", json={"filename": "run1.xrk"})
    assert res.status_code == 200


def test_delete_session_removes_file_index_and_active_state(
    client_with_synthetic_log, isolated_data_dir
):
    upload(client_with_synthetic_log)
    sid = client_with_synthetic_log.get("/api/sessions").json()[0]["id"]

    assert client_with_synthetic_log.delete(f"/api/sessions/{sid}").json() == {"ok": True}
    assert client_with_synthetic_log.get("/api/sessions").json() == []
    assert not (isolated_data_dir / "sessions" / "run1.xrk").exists()
    assert not state.loaded
    assert client_with_synthetic_log.get("/api/channels").status_code == 400
    assert client_with_synthetic_log.delete(f"/api/sessions/{sid}").status_code == 404


def test_delete_inactive_session_keeps_active_one(client_with_synthetic_log):
    upload(client_with_synthetic_log, "a.xrk")
    upload(client_with_synthetic_log, "b.xrk")
    sessions = {s["filename"]: s["id"] for s in client_with_synthetic_log.get("/api/sessions").json()}
    # Load explicitly: see test_known_issues.py for why a 2nd upload isn't enough.
    client_with_synthetic_log.post(f"/api/sessions/{sessions['b.xrk']}/load")
    client_with_synthetic_log.delete(f"/api/sessions/{sessions['a.xrk']}")
    assert state.filename == "b.xrk"
    assert client_with_synthetic_log.get("/api/channels").status_code == 200


def test_switching_sessions_changes_active_log(monkeypatch, isolated_data_dir):
    from main import app
    from conftest import make_log

    logs = {
        "a.xrk": make_log({"RPM": ([0, 10], [1.0, 2.0], "rpm")}),
        "b.xrk": make_log({"Speed": ([0, 10], [5.0, 6.0], "km/h")}),
    }
    current = {"name": "a.xrk"}
    monkeypatch.setattr("routes.analysis.parse_file", lambda *a, **k: logs[current["name"]])
    monkeypatch.setattr("routes.sessions.parse_file", lambda p, *a, **k: logs[p.name])

    with TestClient(app) as c:
        upload(c, "a.xrk")
        current["name"] = "b.xrk"
        upload(c, "b.xrk")
        ids = {s["filename"]: s["id"] for s in c.get("/api/sessions").json()}

        current["name"] = "a.xrk"
        c.post(f"/api/sessions/{ids['a.xrk']}/load")
        assert [ch["name"] for ch in c.get("/api/channels").json()["channels"]] == ["RPM"]
        current["name"] = "b.xrk"
        c.post(f"/api/sessions/{ids['b.xrk']}/load")
        assert [ch["name"] for ch in c.get("/api/channels").json()["channels"]] == ["Speed"]


# ─── Settings ────────────────────────────────────────────────────────────────


def test_settings_update_persists_and_ignores_unknown_keys(
    client_with_synthetic_log, isolated_data_dir
):
    c = client_with_synthetic_log
    res = c.put(
        "/api/settings",
        json={"aim_device_ip": "192.168.1.50", "aim_device_port": 2001, "evil": "x"},
    )
    assert res.status_code == 200
    assert res.json()["aim_device_ip"] == "192.168.1.50"
    assert "evil" not in res.json()

    assert c.get("/api/settings").json()["aim_device_port"] == 2001
    stored = json.loads((isolated_data_dir / "settings.json").read_text())
    assert stored["aim_device_ip"] == "192.168.1.50"
    assert "evil" not in stored


def test_settings_partial_update_keeps_other_values(client_with_synthetic_log):
    c = client_with_synthetic_log
    c.put("/api/settings", json={"aim_device_ip": "1.2.3.4"})
    c.put("/api/settings", json={"aim_wifi_ssid": "MyNet"})
    body = c.get("/api/settings").json()
    assert body["aim_device_ip"] == "1.2.3.4"
    assert body["aim_wifi_ssid"] == "MyNet"


# ─── Cross-cutting ───────────────────────────────────────────────────────────


def test_cors_preflight_from_dev_server_origin(client_with_synthetic_log):
    res = client_with_synthetic_log.options(
        "/api/sessions",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] in ("*", "http://localhost:5173")


def test_unknown_route_is_404(client_with_synthetic_log):
    assert client_with_synthetic_log.get("/api/does-not-exist").status_code == 404


def test_cloud_sync_routes_no_longer_exist(client_with_synthetic_log):
    c = client_with_synthetic_log
    upload(c)
    sid = c.get("/api/sessions").json()[0]["id"]
    assert c.post("/api/sessions/sync").status_code in (404, 405)
    assert c.post(f"/api/sessions/{sid}/pull").status_code in (404, 405)


def test_session_entries_carry_no_cloud_fields(client_with_synthetic_log):
    upload(client_with_synthetic_log)
    entry = client_with_synthetic_log.get("/api/sessions").json()[0]
    assert "remote_id" not in entry and "sync_status" not in entry
    assert entry["source"] == "manual_upload"


def test_startup_migrates_cloud_sync_era_index(isolated_data_dir):
    """Sessions written by Railway-synced versions are cleaned on the next launch."""
    from main import app

    local = session_store.session_file_path("kept.xrk")
    local.write_bytes(b"x")
    entries = [
        {"id": "keep", "filename": "kept.xrk", "local_path": str(local), "source": "railway",
         "sync_status": "synced", "remote_id": 3, "aim_session_id": "kept"},
        {"id": "ghost", "filename": "ghost.xrk", "local_path": None, "source": "railway",
         "sync_status": "remote_only", "remote_id": 4, "aim_session_id": "ghost"},
        {"id": "plain", "filename": "plain.xrk", "local_path": None, "source": "manual_upload",
         "aim_session_id": "plain"},
    ]
    session_store.SESSIONS_FILE.write_text(json.dumps(entries))

    with TestClient(app) as c:
        sessions = {s["id"]: s for s in c.get("/api/sessions").json()}

    assert set(sessions) == {"keep", "plain"}  # ghost had no file and can never be opened
    assert sessions["keep"]["source"] == "manual_upload"
    assert all("sync_status" not in s and "remote_id" not in s for s in sessions.values())


def test_legacy_railway_url_is_dropped_from_settings(client_with_synthetic_log, isolated_data_dir):
    (isolated_data_dir / "settings.json").write_text(
        json.dumps({"railway_url": "https://x.up.railway.app/api/v1", "aim_device_ip": "10.9.9.9"})
    )
    body = client_with_synthetic_log.get("/api/settings").json()
    assert body["aim_device_ip"] == "10.9.9.9"
    assert "railway_url" not in body
    assert "railway_url" not in json.loads((isolated_data_dir / "settings.json").read_text())

    res = client_with_synthetic_log.put("/api/settings", json={"railway_url": "https://again", "aim_device_port": 2002})
    assert "railway_url" not in res.json()


def test_gps_preview_endpoint(client_with_synthetic_log, monkeypatch):
    upload(client_with_synthetic_log)
    sid = client_with_synthetic_log.get("/api/sessions").json()[0]["id"]
    res = client_with_synthetic_log.get(f"/api/sessions/{sid}/gps-preview")
    assert res.status_code == 200
    assert "preview" in res.json()
    assert client_with_synthetic_log.get("/api/sessions/nope/gps-preview").status_code == 404


@pytest.mark.parametrize("script", [
    "result = {'timestamps': [0], 'values': [len(().__class__.__base__.__subclasses__())]}",
    "import os\nresult = None",
    "g = (i for i in [1])\nx = g.gi_frame.f_globals",
    "x = '{0.__class__}'.format(1)",
    "np.save('/tmp/x', [1])",
])
def test_derived_rejects_sandbox_escapes(client_with_synthetic_log, script):
    assert evaluate(client_with_synthetic_log, script).status_code == 400


def test_derived_timeout_without_sigalrm(client_with_synthetic_log, monkeypatch):
    monkeypatch.setattr("routes.analysis._EVAL_TIMEOUT_SECONDS", 1)
    res = evaluate(client_with_synthetic_log, "while True:\n    pass")
    assert res.status_code == 400 and "timed out" in res.json()["detail"]
