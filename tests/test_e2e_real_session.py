"""Full workflow on the committed real-world .xrk (CT16-EV endurance run).

Unlike test_api_workflow.py these use the real parser and a real 32 MB file, and
check results against the Race Studio CSV export that ships next to it, so a
parser regression, unit change or timestamp bug shows up as a wrong number.
"""

from __future__ import annotations

import csv
import io
import statistics

import pytest
from fastapi.testclient import TestClient

from conftest import fixture_xrk
from services.session_cache import session_cache
from state import interpolate, state

XRK = fixture_xrk()
pytestmark = pytest.mark.skipif(XRK is None, reason="no .xrk in tests/fixtures")

REFERENCE_CSV = XRK.with_name(f"{XRK.stem}_rs.csv") if XRK else None

# QuickScope channel name -> Race Studio CSV column. GPS channels are excluded:
# RS applies its own GPS clock correction, so they differ by design.
RS_COLUMNS = {"RPM": "RPM", "Throttle_Pos": "Throttle Pos", "BSE_Voltage": "BSE Voltage"}


@pytest.fixture
def app_client():
    from main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def loaded(app_client):
    res = app_client.post(
        "/api/upload", files={"file": (XRK.name, XRK.read_bytes(), "application/octet-stream")}
    )
    assert res.status_code == 200, res.text
    return app_client, res.json()


def _reference_rows():
    if REFERENCE_CSV is None or not REFERENCE_CSV.exists():
        pytest.skip("no Race Studio reference CSV next to fixture")
    rows = list(csv.reader(REFERENCE_CSV.open(encoding="utf-8-sig")))
    head = next(i for i, r in enumerate(rows) if r and r[0] == "Time" and len(r) > 5)
    return rows[head], rows[head + 2 :]


def test_session_info_matches_known_run(loaded):
    _, info = loaded
    assert info["metadata"]["vehicle"] == "CT16-EV"
    assert info["metadata"]["date"] == "06/06/2026"
    assert info["recordedAt"] == "2026-06-06T18:01:43"
    assert info["durationMs"] == pytest.approx(1632_000, rel=0.01)  # RS: 1632 s
    assert len(info["channels"]) >= 90
    names = {c["name"] for c in info["channels"]}
    for expected in ("RPM", "GPS Speed", "GPS Latitude", "GPS Longitude", "Throttle_Pos", "Pack_Voltage"):
        assert expected in names


@pytest.mark.parametrize("channel", sorted(RS_COLUMNS))
def test_channel_values_match_race_studio_export(loaded, channel):
    c, _ = loaded
    series = c.get("/api/data", params={"channels": channel}).json()[channel]
    header, data = _reference_rows()
    col = header.index(RS_COLUMNS[channel])

    errors, scale = [], []
    for row in data[::25]:
        try:
            t, expected = float(row[0]), float(row[col])
        except (ValueError, IndexError):
            continue
        got = interpolate(series["timestamps"], series["values"], t * 1000)
        errors.append(abs(got - expected))
        scale.append(abs(expected))
    assert len(errors) > 500
    span = max(scale) or 1.0
    assert statistics.median(errors) <= 0.001 * span
    assert max(errors) <= 0.02 * span


def test_data_timestamps_are_sorted_finite_and_within_session(loaded):
    c, info = loaded
    body = c.get("/api/data", params={"channels": "RPM,Throttle_Pos,BSE_Voltage"}).json()
    for name, s in body.items():
        ts = s["timestamps"]
        assert len(ts) == len(s["values"]) > 1000, name
        assert ts == sorted(ts), name
        assert ts[0] >= 0 and ts[-1] <= info["durationMs"] * 1.05, name


def test_gps_track_is_where_the_run_happened(loaded):
    c, _ = loaded
    gps = c.get("/api/gps").json()["gps"]
    assert len(gps["lat"]) > 5000
    # RS header: session at 41.817 N, 72.263 W (UConn)
    assert statistics.median(gps["lat"]) == pytest.approx(41.817, abs=0.02)
    assert statistics.median(gps["lon"]) == pytest.approx(-72.263, abs=0.02)
    assert gps["timestamps"][0] >= 0  # first valid fix, relative to first GPS sample
    assert gps["timestamps"] == sorted(gps["timestamps"])
    assert len(gps["speed"]) == len(gps["lat"])


def test_laps_are_detected_from_gps_when_device_has_none(loaded):
    c, info = loaded
    body = c.get("/api/laps").json()
    if info["lapCount"] == 0:
        assert body["source"] in ("gps_auto", "beacon_auto")
    assert body["laps"], "an endurance run must have at least one detectable lap"
    ends = [l["endTime"] for l in body["laps"]]
    assert ends == sorted(ends)
    assert all(l["endTime"] > l["startTime"] for l in body["laps"])


def test_export_real_channels_roundtrip(loaded):
    c, _ = loaded
    res = c.get("/api/export", params={"channels": "RPM,Throttle_Pos"})
    assert res.status_code == 200
    rows = list(csv.reader(io.StringIO(res.text)))
    assert rows[0][0] == "Time (s)" and rows[0][1].startswith("RPM")
    data = c.get("/api/data", params={"channels": "RPM,Throttle_Pos"}).json()
    union = set(data["RPM"]["timestamps"]) | set(data["Throttle_Pos"]["timestamps"])
    assert len(rows) - 1 == len(union)  # timebase is the union of both channels' timestamps
    times = [float(r[0]) for r in rows[1:]]
    assert times == sorted(times)
    assert all(len(r) == 3 for r in rows)


def test_derived_channel_over_real_data_end_to_end(loaded, monkeypatch):
    """Fetch two real channels, then evaluate a derived formula over them."""
    import signal

    monkeypatch.setattr(signal, "signal", lambda *a, **k: None)
    monkeypatch.setattr(signal, "alarm", lambda *a, **k: 0)
    c, _ = loaded
    data = c.get("/api/data", params={"channels": "RPM"}).json()
    res = c.post(
        "/api/derived/evaluate",
        json={
            "expression": "r = channels['RPM']\n"
            "result = {'timestamps': r['timestamps'], 'values': [v / 2 for v in r['values']]}",
            "channels": data,
        },
    )
    assert res.status_code == 200
    out = res.json()
    assert len(out["values"]) == len(data["RPM"]["values"])
    assert out["values"][1000] == pytest.approx(data["RPM"]["values"][1000] / 2)


def test_relaunch_and_reload_gives_identical_data(loaded):
    c, info = loaded
    before = c.get("/api/data", params={"channels": "RPM"}).json()["RPM"]
    sid = c.get("/api/sessions").json()[0]["id"]

    session_cache.clear()  # backend process restarted
    state.clear()
    assert c.get("/api/channels").status_code == 400
    reloaded = c.post(f"/api/sessions/{sid}/load").json()
    assert reloaded["totalSamples"] == info["totalSamples"]
    assert c.get("/api/data", params={"channels": "RPM"}).json()["RPM"] == before


def test_gps_preview_for_real_track(loaded):
    c, _ = loaded
    sid = c.get("/api/sessions").json()[0]["id"]
    preview = c.get(f"/api/sessions/{sid}/gps-preview").json()["preview"]
    assert preview, "real session has a GPS track; thumbnail should not be empty"
