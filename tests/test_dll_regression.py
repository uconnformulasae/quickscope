"""Optional Windows DLL regression against a local XRK + RS CSV pair.

Fixtures are gitignored (large binaries). CI downloads them from the
fixtures-v1 release; run locally with files in tests/fixtures/:

    .venv\\Scripts\\python.exe -m pytest -m dll
"""

from __future__ import annotations

import pytest

from parsers import aim_dll
from validate_dll import FIXTURES_DIR, validate_file
from conftest import fixture_xrk

STABLE_CHANNELS = (
    "RPM",
    "GPS Latitude",
    "GPS Longitude",
    "Throttle_Pos",
    "Pack_Voltage",
)


@pytest.mark.dll
def test_dll_sanity_and_stable_channels():
    if not aim_dll.dll_available():
        pytest.skip("MatLabXRK DLL not available")

    xrk = fixture_xrk()
    if xrk is None:
        pytest.skip(f"No .xrk/.xrz in {FIXTURES_DIR} (add locally for DLL regression)")

    reference = xrk.with_name(f"{xrk.stem}_rs.csv")
    if not reference.is_file():
        pytest.skip(f"Missing reference CSV: {reference}")

    issues = validate_file(
        xrk,
        reference=reference,
        channels=list(STABLE_CHANNELS),
        atol=0.01,
        rtol=0.001,
        stride=20,
        verbose=False,
    )
    assert issues == 0, f"DLL regression failed for {xrk.name} ({issues} issue(s))"
