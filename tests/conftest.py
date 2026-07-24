"""Shared pytest configuration."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"

sys.path.insert(0, str(REPO_ROOT / "backend"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))


def fixture_xrk() -> Path | None:
    """First .xrk/.xrz in tests/fixtures, if present."""
    for pattern in ("*.xrk", "*.xrz"):
        matches = sorted(FIXTURES_DIR.glob(pattern))
        if matches:
            return matches[0]
    return None
