"""Tests for shared AiM device cache (live + session pull)."""

from services.aim_device_cache import (
    clear_cache_for_tests,
    get_cached,
    record_from_parsed,
    record_tcp_device,
)


def setup_function() -> None:
    clear_cache_for_tests()


def test_fresh_cache_returned() -> None:
    record_from_parsed({"ip": "10.0.0.1", "model": "EVO5", "serial": "123"})
    cached = get_cached(max_age_s=60.0)
    assert cached is not None
    assert cached.ip == "10.0.0.1"
    assert cached.model == "EVO5"


def test_tcp_refresh_preserves_identity() -> None:
    record_from_parsed({"ip": "10.0.0.1", "model": "EVO5", "vehicle": "CT17"})
    record_tcp_device("10.0.0.1")
    cached = get_cached()
    assert cached is not None
    assert cached.model == "EVO5"
    assert cached.vehicle == "CT17"
