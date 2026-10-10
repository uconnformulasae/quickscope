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
def isolated_data_dir(tmp_path, monkeypatch):
    """Point every on-disk store at a per-test temp dir.

    Without this, route tests read and write the developer's real
    ``backend/data`` (sessions.json, settings.json, session files).
    """
    from services import session_store, settings_store

    data_dir = tmp_path / "qs_data"
    sessions_dir = data_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    monkeypatch.setattr(session_store, "DATA_DIR", data_dir)
    monkeypatch.setattr(session_store, "SESSIONS_FILE", data_dir / "sessions.json")
    monkeypatch.setattr(session_store, "SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(settings_store, "DATA_DIR", data_dir)
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", data_dir / "settings.json")
    return data_dir


@pytest.fixture(autouse=True)
def _reset_session_state(isolated_data_dir):
    """FastAPI routes share a module-level SessionState; isolate tests."""
    from services import aim_pull_log, upload_log
    from services.session_cache import session_cache
    from state import state

    state.clear()
    session_cache.clear()
    upload_log.clear()
    aim_pull_log.clear()
    yield
    state.clear()
    session_cache.clear()


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


# ─── Synthetic telemetry (no .xrk needed) ────────────────────────────────────

# A small circuit around (41.8, -72.2): ~0.002 deg of lat/lon is ~200 m.
_TRACK_CENTER = (41.8000, -72.2000)


def _channel_table(name, timecodes, values, units=""):
    import pyarrow as pa
    from libxrk.base import ChannelMetadata

    meta = ChannelMetadata(units=units, dec_pts=0, interpolate=True, source_type=0)
    schema = pa.schema(
        [
            pa.field("timecodes", pa.int64()),
            pa.field(name, pa.float64(), metadata=meta.to_field_metadata()),
        ]
    )
    return pa.Table.from_arrays(
        [pa.array(timecodes, type=pa.int64()), pa.array(values, type=pa.float64())],
        schema=schema,
    )


def make_log(
    channels: dict[str, tuple[list[int], list[float], str]] | None = None,
    laps: list[tuple[int, int]] | None = None,
    metadata: dict | None = None,
):
    """Build a libxrk ``LogFile`` from ``{name: (timecodes_ms, values, units)}``."""
    import pyarrow as pa
    from libxrk.base import LogFile

    tables = {
        name: _channel_table(name, tcs, vals, units)
        for name, (tcs, vals, units) in (channels or {}).items()
    }
    laps = laps or []
    laps_table = pa.table(
        {
            "num": pa.array(range(len(laps)), type=pa.int32()),
            "start_time": pa.array([a for a, _ in laps], type=pa.int64()),
            "end_time": pa.array([b for _, b in laps], type=pa.int64()),
        }
    )
    return LogFile(
        channels=tables,
        laps=laps_table,
        metadata=metadata
        or {
            "Vehicle": "CT17",
            "Driver": "Test Driver",
            "Venue": "Test Track",
            "Series": "FSAE",
            "Session": "Endurance",
            "Log Date": "05/10/2026",
            "Log Time": "14:30:00",
            "Long Comment": "",
        },
        file_name="synthetic.xrk",
    )


def circuit_samples(n_laps: int = 3, lap_s: int = 30, hz: int = 10):
    """GPS samples driving ``n_laps`` loops of a ~60 m radius circle."""
    import math

    lat0, lon0 = _TRACK_CENTER
    radius_deg = 0.0006
    n = n_laps * lap_s * hz + 1
    ts, lat, lon = [], [], []
    for i in range(n):
        frac = (i / (lap_s * hz)) * 2 * math.pi
        ts.append(int(i * 1000 / hz))
        lat.append(lat0 + radius_deg * math.sin(frac))
        lon.append(lon0 + radius_deg * (1 - math.cos(frac)))
    return ts, lat, lon


@pytest.fixture
def synthetic_log():
    """Three-lap session: RPM@100Hz, Throttle@50Hz, GPS@10Hz, device lap markers."""
    ts_rpm = list(range(0, 90_001, 10))
    rpm = [3000.0 + 2000.0 * ((i // 100) % 2) for i in range(len(ts_rpm))]
    ts_thr = list(range(0, 90_001, 20))
    thr = [float(i % 101) for i in range(len(ts_thr))]
    ts_gps, lat, lon = circuit_samples(3, 30, 10)
    speed = [15.0 + (i % 7) for i in range(len(ts_gps))]
    return make_log(
        {
            "RPM": (ts_rpm, rpm, "rpm"),
            "Throttle_Pos": (ts_thr, thr, "%"),
            "GPS Latitude": (ts_gps, lat, "deg"),
            "GPS Longitude": (ts_gps, lon, "deg"),
            "GPS Speed": (ts_gps, speed, "m/s"),
        },
        laps=[(0, 30_000), (30_000, 60_000), (60_000, 90_000)],
    )


@pytest.fixture
def client_with_synthetic_log(monkeypatch, synthetic_log):
    """TestClient whose parser returns ``synthetic_log`` for any uploaded bytes.

    Runs the full app lifespan (startup hooks included) like a real launch.
    """
    from fastapi.testclient import TestClient

    import state as state_module
    from main import app

    monkeypatch.setattr(state_module, "parse_file", lambda *a, **k: synthetic_log)
    for mod in ("routes.analysis", "routes.sessions"):
        monkeypatch.setattr(f"{mod}.parse_file", lambda *a, **k: synthetic_log)
    with TestClient(app) as c:
        yield c
