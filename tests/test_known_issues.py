"""Executable record of bugs found in the codebase audit.

Each test asserts the *correct* behavior and is marked ``xfail(strict=True)``:

* today it fails (xfail), so the suite stays green and the bug is documented;
* the moment someone fixes the bug it XPASSes, ``strict`` turns that into a
  failure, and the fix is forced to remove the marker -- so the test becomes a
  permanent regression guard instead of rotting.

Nothing here modifies application code.
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from conftest import make_log
from services import session_store, settings_store
from state import channel_data, state

known_bug = pytest.mark.xfail(strict=True)


def _client_with_log(monkeypatch, log) -> TestClient:
    from main import app

    monkeypatch.setattr("routes.analysis.parse_file", lambda *a, **k: log)
    c = TestClient(app)
    c.__enter__()
    return c


def _upload(c: TestClient, name: str = "run.xrk"):
    return c.post("/api/upload", files={"file": (name, b"x", "application/octet-stream")})


# ─── Session state ───────────────────────────────────────────────────────────


def test_second_upload_becomes_the_active_session(monkeypatch):
    """Uploading file B after file A (same run) must leave B loaded.

    Actual: ``state.log = log`` writes B's log under A's cache key, then
    ``state.session_id = B`` activates an id with no cache entry. Result:
    ``/api/channels`` -> 400 "No file loaded" and A's cached log is B's data.
    """
    logs = {
        "a.xrk": make_log({"RPM": ([0, 10], [1.0, 2.0], "rpm")}),
        "b.xrk": make_log({"Speed": ([0, 10], [5.0, 6.0], "km/h")}),
    }
    current = {"n": "a.xrk"}
    monkeypatch.setattr("routes.analysis.parse_file", lambda *a, **k: logs[current["n"]])
    from main import app

    with TestClient(app) as c:
        _upload(c, "a.xrk")
        current["n"] = "b.xrk"
        _upload(c, "b.xrk")
        res = c.get("/api/channels")
        assert res.status_code == 200
        assert [ch["name"] for ch in res.json()["channels"]] == ["Speed"]


def test_second_upload_does_not_overwrite_first_sessions_cache(monkeypatch):
    from services.session_cache import session_cache

    a = make_log({"RPM": ([0, 10], [1.0, 2.0], "rpm")})
    b = make_log({"Speed": ([0, 10], [5.0, 6.0], "km/h")})
    state.log, state.filename, state.session_id = a, "a.xrk", "A"
    state.log, state.filename, state.session_id = b, "b.xrk", "B"
    assert session_cache.get("A")[0] is a


def test_renaming_active_session_keeps_cache_valid(tmp_path):
    """``state.filename = ...`` re-puts the entry with an empty fingerprint,
    so the next ``get_valid`` evicts a perfectly good in-memory log."""
    from services.session_cache import session_cache

    f = tmp_path / "a.xrk"
    f.write_bytes(b"x")
    log = make_log({"RPM": ([0, 10], [1.0, 2.0], "rpm")})
    session_cache.put("A", log, "a.xrk", f)
    session_cache.set_active("A")
    state.filename = "renamed.xrk"
    assert session_cache.get_valid("A", f) is not None


# ─── Data fidelity ───────────────────────────────────────────────────────────


def test_dropout_samples_are_not_reported_as_zero():
    log = make_log({"Pack_Voltage": ([0, 10, 20], [300.0, float("nan"), 298.0], "V")})
    values = channel_data("Pack_Voltage", log.channels["Pack_Voltage"])["values"]
    assert values[1] is None or math.isnan(values[1]), "a sensor dropout became 0.0 V"


def test_dropout_samples_can_be_dropped_for_numeric_consumers():
    log = make_log({"Pack_Voltage": ([0, 10, 20], [300.0, float("nan"), 298.0], "V")})
    data = channel_data("Pack_Voltage", log.channels["Pack_Voltage"], drop_gaps=True)
    assert data == {"timestamps": [0, 20], "values": [300.0, 298.0]}


def test_export_covers_the_full_session_not_just_densest_channel(monkeypatch):
    """Timebase is picked by sample *count*, so a short high-rate channel
    truncates the export of a longer low-rate one."""
    fast = list(range(0, 5_001, 10))  # 100 Hz for 5 s  -> 501 samples
    slow = list(range(0, 20_001, 100))  # 10 Hz for 20 s -> 201 samples
    log = make_log(
        {
            "Fast": (fast, [1.0] * len(fast), "u"),
            "Slow": (slow, [2.0] * len(slow), "u"),
        }
    )
    c = _client_with_log(monkeypatch, log)
    try:
        _upload(c)
        rows = c.get("/api/export", params={"channels": "Fast,Slow"}).text.strip().splitlines()
        last_time_s = float(rows[-1].split(",")[0])
        assert last_time_s == pytest.approx(20.0), f"export stops at {last_time_s}s of a 20s session"
    finally:
        c.__exit__(None, None, None)


def test_gps_speed_is_matched_by_time_not_array_index(monkeypatch):
    ts_pos = list(range(0, 1_001, 100))  # 10 Hz, 11 fixes
    ts_spd = list(range(0, 1_001, 200))  # 5 Hz, 6 samples; value == t / 100
    lat = [41.8 + i * 1e-5 for i in range(len(ts_pos))]
    lon = [-72.2 - i * 1e-5 for i in range(len(ts_pos))]
    log = make_log(
        {
            "GPS Latitude": (ts_pos, lat, "deg"),
            "GPS Longitude": (ts_pos, lon, "deg"),
            "GPS Speed": (ts_spd, [t / 100 for t in ts_spd], "m/s"),
        }
    )
    c = _client_with_log(monkeypatch, log)
    try:
        _upload(c)
        gps = c.get("/api/gps").json()["gps"]
        for t, speed in zip(gps["timestamps"], gps["speed"]):
            assert speed == pytest.approx(t / 100, abs=0.51), f"t={t} speed={speed}"
    finally:
        c.__exit__(None, None, None)


# ─── Resilience ──────────────────────────────────────────────────────────────


def test_corrupt_sessions_index_does_not_crash_startup():
    session_store.SESSIONS_FILE.write_text("{ truncated")
    assert session_store.list_sessions() == []


def test_corrupt_settings_file_falls_back_to_defaults():
    settings_store.SETTINGS_FILE.write_text("")
    assert settings_store.load()["aim_device_port"] == 2000


def test_derived_evaluate_blocks_object_introspection(monkeypatch):
    """``exec`` with a trimmed ``__builtins__`` is not a sandbox: attribute
    walking reaches every loaded class. (This probe only counts them.)"""
    import signal

    from main import app

    monkeypatch.setattr(signal, "signal", lambda *a, **k: None)
    monkeypatch.setattr(signal, "alarm", lambda *a, **k: 0)
    with TestClient(app) as c:
        res = c.post(
            "/api/derived/evaluate",
            json={
                "expression": "n = len(().__class__.__base__.__subclasses__())\n"
                "result = {'timestamps': [0], 'values': [n]}",
                "channels": {},
            },
        )
    assert res.status_code == 400


def test_cors_does_not_allow_arbitrary_origins():
    from main import app

    with TestClient(app) as c:
        res = c.options(
            "/api/derived/evaluate",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )
    assert res.headers.get("access-control-allow-origin") not in ("*", "https://evil.example")


@pytest.mark.skipif(not __import__("conftest").fixture_xrk(), reason="needs the real libxrk parser path")
def test_garbage_upload_is_rejected_not_stored_as_an_empty_session():
    """libxrk returns an empty LogFile for non-XRK bytes instead of raising, so
    a corrupt/mislabelled file becomes a blank 0-channel session in the browser."""
    from main import app

    with TestClient(app) as c:
        res = c.post(
            "/api/upload",
            files={"file": ("broken.xrk", b"\x00not an xrk" * 100, "application/octet-stream")},
        )
        assert res.status_code >= 400
        assert c.get("/api/sessions").json() == []
