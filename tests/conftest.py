"""Shared pytest configuration."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"

sys.path.insert(0, str(REPO_ROOT / "backend"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))


@pytest.fixture(autouse=True)
def _reset_session_state():
    """FastAPI routes share a module-level SessionState; isolate tests."""
    from state import state

    state.clear()
    yield
    state.clear()


def fixture_xrk() -> Path | None:
    """First .xrk/.xrz in tests/fixtures, if present."""
    for pattern in ("*.xrk", "*.xrz"):
        matches = sorted(FIXTURES_DIR.glob(pattern))
        if matches:
            return matches[0]
    return None
