"""libxrk parser regression on local XRK fixtures (no DLL, no Race Studio CSV).

Fixtures are gitignored. CI downloads them from fixtures-v1; run locally:

    .venv\\Scripts\\python.exe -m pytest -m libxrk
"""

from __future__ import annotations

import os

import pytest

from parsers import parse_xrk
from state import channel_data, extract_session_info
from conftest import fixture_xrk

LIBXRK_STABLE_CHANNELS = (
    "RPM",
    "GPS Speed",
    "GPS Latitude",
    "GPS Longitude",
    "Throttle_Pos",
    "Pack_Voltage",
)

_MIN_CHANNEL_COUNT = 50
_MIN_DURATION_MS = 60_000


@pytest.fixture
def libxrk_env(monkeypatch: pytest.MonkeyPatch):
    """Force libxrk even when MatLabXRK DLL is installed on Windows."""
    monkeypatch.setenv("QUICKSCOPE_PARSER", "libxrk")


@pytest.mark.libxrk
def test_libxrk_parses_fixture_sanity(libxrk_env: None):
    xrk = fixture_xrk()
    if xrk is None:
        pytest.skip("No .xrk/.xrz in tests/fixtures (add locally or run CI fixture download)")

    log = parse_xrk(xrk)
    info = extract_session_info(log, xrk.name)

    assert len(info["channels"]) >= _MIN_CHANNEL_COUNT
    assert info["durationMs"] >= _MIN_DURATION_MS

    missing = [name for name in LIBXRK_STABLE_CHANNELS if name not in log.channels]
    assert not missing, f"libxrk missing expected channels: {missing}"

    duration_ms = info["durationMs"]
    gps = channel_data("GPS Speed", log.channels["GPS Speed"])
    assert gps["timestamps"], "GPS Speed has no samples"
    assert max(gps["timestamps"]) <= duration_ms * 1.1
    assert max(gps["values"]) < 120.0


@pytest.mark.libxrk
def test_libxrk_via_parse_file_entrypoint(libxrk_env: None):
    """state.parse_file() should honor QUICKSCOPE_PARSER=libxrk."""
    xrk = fixture_xrk()
    if xrk is None:
        pytest.skip("No .xrk/.xrz in tests/fixtures")

    from state import parse_file

    assert os.environ.get("QUICKSCOPE_PARSER") == "libxrk"
    log = parse_file(xrk)
    assert "RPM" in log.channels
