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


class FakeKeepalive:
    """Stands in for ``AimKeepalive`` so route tests never open UDP sockets."""

    instances: list["FakeKeepalive"] = []

    def __init__(self, host: str, **_kwargs) -> None:
        self.host = host
        self.started = False
        self.stopped = False
        FakeKeepalive.instances.append(self)

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


@pytest.fixture
def fake_keepalive(monkeypatch):
    FakeKeepalive.instances = []
    monkeypatch.setattr("routes.sessions.AimKeepalive", FakeKeepalive)
    return FakeKeepalive


class FakePullHub:
    """Minimal ``AimPrimaryHub`` for ``/api/aim/pull`` route tests."""

    def __init__(self, sessions=None, list_error: Exception | None = None) -> None:
        self.sessions = sessions or []
        self.list_error = list_error
        self.calls: list[str] = []

    async def list_sessions(self, host=None):  # noqa: ANN001
        self.calls.append("list_sessions")
        if self.list_error is not None:
            raise self.list_error
        return self.sessions

    async def release_for_download(self) -> None:
        self.calls.append("release_for_download")

    def resolve_host(self, host=None):  # noqa: ANN001
        return host or "10.0.0.1"


def fixture_xrk() -> Path | None:
    """First .xrk/.xrz in tests/fixtures, if present."""
    for pattern in ("*.xrk", "*.xrz"):
        matches = sorted(FIXTURES_DIR.glob(pattern))
        if matches:
            return matches[0]
    return None
