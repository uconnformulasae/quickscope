"""Tests for DLL → LogFile adapter timecode conversion."""

from __future__ import annotations

from parsers.log_adapter import _to_timecodes_ms


def test_regular_channel_times_convert_seconds_to_ms():
    assert _to_timecodes_ms([0.0, 1.0, 2.5]) == [0, 1000, 2500]


def test_gps_channel_times_stay_in_ms():
    assert _to_timecodes_ms([1000.0, 2000.0, 3010.0], already_ms=True) == [1000, 2000, 3010]
