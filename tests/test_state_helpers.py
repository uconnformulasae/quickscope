"""Pure helpers in ``state.py`` that every route relies on."""

from __future__ import annotations

import math

import pytest

from conftest import make_log
from state import (
    apply_stored_recorded_at,
    channel_data,
    channel_meta,
    extract_session_info,
    format_recorded_at_display,
    interpolate,
    parse_recorded_at,
    resolve_aim_recorded_at,
    sanitize_filename,
)


# ─── interpolate ─────────────────────────────────────────────────────────────


def test_interpolate_midpoint_and_exact_hits():
    ts, vs = [0, 100, 200], [0.0, 10.0, 30.0]
    assert interpolate(ts, vs, 50) == pytest.approx(5.0)
    assert interpolate(ts, vs, 150) == pytest.approx(20.0)
    assert interpolate(ts, vs, 100) == 10.0


def test_interpolate_clamps_outside_range():
    ts, vs = [100, 200], [1.0, 2.0]
    assert interpolate(ts, vs, -50) == 1.0
    assert interpolate(ts, vs, 1e9) == 2.0


def test_interpolate_empty_and_single_sample():
    assert interpolate([], [], 5) is None
    assert interpolate([10], [7.0], 5) == 7.0
    assert interpolate([10], [7.0], 50) == 7.0


def test_interpolate_duplicate_timestamps_do_not_divide_by_zero():
    assert interpolate([0, 100, 100, 200], [0.0, 5.0, 9.0, 10.0], 100) in (5.0, 9.0)


def test_interpolate_matches_numpy_on_random_grid():
    np = pytest.importorskip("numpy")
    rng = np.random.default_rng(1)
    ts = np.sort(rng.choice(10_000, 400, replace=False)).tolist()
    vs = rng.normal(size=400).tolist()
    for t in rng.uniform(ts[0], ts[-1], 200):
        assert interpolate(ts, vs, t) == pytest.approx(float(np.interp(t, ts, vs)))


# ─── sanitize_filename ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("run1.xrk", "run1.xrk"),
        ("My Run (final).xrk", "My_Run__final_.xrk"),
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\x\\run.xrk", "C__Users_x_run.xrk"),
        ("dir/sub/run.xrz", "run.xrz"),
        ("name with spaces.xrk", "name_with_spaces.xrk"),
    ],
)
def test_sanitize_filename(raw, expected):
    assert sanitize_filename(raw) == expected


def test_sanitize_filename_rejects_empty():
    with pytest.raises(ValueError):
        sanitize_filename("")
    with pytest.raises(ValueError):
        sanitize_filename("/")


# ─── dates ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "date, time, expected",
    [
        ("05/10/2026", "14:30:00", "2026-10-05T14:30:00"),
        ("2026-10-05", "09:05", "2026-10-05T09:05:00"),
        ("25/12/2025", "", "2025-12-25T00:00:00"),
        ("05-10-2026", "23:59:59", "2026-10-05T23:59:59"),
        ("  05/10/2026 ", " 14:30:00 ", "2026-10-05T14:30:00"),
    ],
)
def test_parse_recorded_at(date, time, expected):
    assert parse_recorded_at(date, time) == expected


@pytest.mark.parametrize("date", ["", "garbage", "32/13/2026"])
def test_parse_recorded_at_rejects_bad_dates(date):
    assert parse_recorded_at(date, "10:00:00") is None


def test_parse_recorded_at_ignores_bad_time_but_keeps_date():
    assert parse_recorded_at("2026-10-05", "nope") == "2026-10-05T00:00:00"


def test_format_recorded_at_display_roundtrip():
    assert format_recorded_at_display("2026-10-05T14:30:00") == ("05/10/2026", "14:30:00")
    assert format_recorded_at_display("junk") == ("", "")


def test_device_date_wins_over_embedded_xrk_date():
    assert resolve_aim_recorded_at("06/10/2026", "08:00:00", "05/10/2026", "14:30:00") == "2026-10-06T08:00:00"
    assert resolve_aim_recorded_at("", "", "05/10/2026", "14:30:00") == "2026-10-05T14:30:00"
    assert resolve_aim_recorded_at("", "", "", "") is None


def test_apply_stored_recorded_at_overrides_without_mutating_input():
    info = {"metadata": {"date": "01/01/2000", "time": "00:00:00"}, "recordedAt": None}
    out = apply_stored_recorded_at(info, "2026-10-05T14:30:00")
    assert out["metadata"] == {"date": "05/10/2026", "time": "14:30:00"}
    assert out["recordedAt"] == "2026-10-05T14:30:00"
    assert info["metadata"]["date"] == "01/01/2000"
    assert apply_stored_recorded_at(info, None) is info


# ─── channel helpers ─────────────────────────────────────────────────────────


def test_channel_meta_reads_units():
    log = make_log({"RPM": ([0, 10], [1.0, 2.0], "rpm")})
    assert channel_meta("RPM", log.channels["RPM"])["units"] == "rpm"


def test_channel_data_returns_plain_lists():
    log = make_log({"RPM": ([0, 10, 20], [1.0, 2.0, 3.0], "rpm")})
    data = channel_data("RPM", log.channels["RPM"])
    assert data == {"timestamps": [0, 10, 20], "values": [1.0, 2.0, 3.0]}
    assert type(data["timestamps"][0]) is int and type(data["values"][0]) is float


def test_channel_data_output_is_json_safe():
    """inf/nan would make FastAPI's JSON encoder raise on the way out."""
    log = make_log({"X": ([0, 10, 20], [float("nan"), float("inf"), 1.0], "")})
    values = channel_data("X", log.channels["X"])["values"]
    assert all(v is None or math.isfinite(v) for v in values)


# ─── extract_session_info ────────────────────────────────────────────────────


def test_session_info_duration_ignores_gps_and_sentinel_timestamps():
    log = make_log(
        {
            "RPM": ([0, 1000, 2000], [1.0, 2.0, 3.0], "rpm"),
            "GPS Speed": ([0, 1000, 9_000_000], [1.0, 2.0, 3.0], "m/s"),  # GPS clock junk
            "Weird": ([0, 50_000_000], [0.0, 1.0], ""),  # > 10 h, treated as bogus
        }
    )
    info = extract_session_info(log, "x.xrk")
    assert info["durationMs"] == 2000


def test_session_info_sample_rate_and_counts():
    ts = list(range(0, 1001, 10))  # 101 samples over 1 s
    log = make_log({"RPM": (ts, [1.0] * len(ts), "rpm")})
    ch = extract_session_info(log, "x.xrk")["channels"][0]
    assert ch["sampleCount"] == 101
    assert ch["sampleRateHz"] == pytest.approx(100.0)


def test_session_info_handles_empty_and_single_sample_channels():
    log = make_log({"One": ([5], [1.0], ""), "Empty": ([], [], "")})
    info = extract_session_info(log, "x.xrk")
    assert {c["name"]: c["sampleRateHz"] for c in info["channels"]} == {"One": 0, "Empty": 0}


def test_session_info_with_missing_metadata_and_no_laps():
    log = make_log({"RPM": ([0, 10], [1.0, 2.0], "")}, metadata={"Vehicle": "Car"})
    info = extract_session_info(log, "x.xrk")
    assert info["metadata"]["vehicle"] == "Car"
    assert info["metadata"]["driver"] == ""
    assert info["lapCount"] == 0
    assert info["recordedAt"] is None


def test_session_info_channels_sorted_and_colored():
    log = make_log({n: ([0, 1], [0.0, 1.0], "") for n in ("b", "a", "c")})
    info = extract_session_info(log, "x.xrk")
    assert [c["name"] for c in info["channels"]] == ["a", "b", "c"]
    assert [c["index"] for c in info["channels"]] == [0, 1, 2]
    assert all(c["color"].startswith("#") for c in info["channels"])
