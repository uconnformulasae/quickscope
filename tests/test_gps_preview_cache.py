"""GPS preview disk cache and parse priority behavior."""

import json
import threading
import time
from pathlib import Path

import pytest

from parsers.parse_gate import PARSE_GATE, PRIORITY_INTERACTIVE, PRIORITY_PREVIEW
from services import gps_preview, session_store


@pytest.fixture
def isolated_gps_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(session_store, "DATA_DIR", tmp_path)
    gps_preview._cache.clear()
    return tmp_path


def _seed_disk_cache(session_id: str, xrk: Path, preview: dict | None) -> None:
    mtime_ns, size = gps_preview._file_fingerprint(xrk)
    path = gps_preview._disk_cache_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"mtime_ns": mtime_ns, "size": size, "preview": preview}),
        encoding="utf-8",
    )


def test_disk_cache_hit_skips_parse(isolated_gps_cache, monkeypatch):
    xrk = isolated_gps_cache / "lap.xrk"
    xrk.write_bytes(b"xrk-bytes")
    session_id = "sess-1"
    cached = {
        "points": [[0.1, 0.2], [0.9, 0.8]],
        "bounds": {"minLat": 1.0, "maxLat": 2.0, "minLon": 3.0, "maxLon": 4.0},
        "pointCount": 10,
    }
    _seed_disk_cache(session_id, xrk, cached)

    def should_not_run(*_args, **_kwargs):
        raise AssertionError("parse_file should not run on disk cache hit")

    monkeypatch.setattr(gps_preview, "parse_file", should_not_run)
    result = gps_preview.compute_preview(xrk, session_id)
    assert result == cached


def test_disk_cache_miss_after_file_change(isolated_gps_cache, monkeypatch):
    xrk = isolated_gps_cache / "lap.xrk"
    xrk.write_bytes(b"v1")
    session_id = "sess-2"
    _seed_disk_cache(session_id, xrk, None)

    xrk.write_bytes(b"v2-longer-content")

    built = {
        "points": [[0.0, 0.0], [1.0, 1.0]],
        "bounds": {"minLat": 0.0, "maxLat": 1.0, "minLon": 0.0, "maxLon": 1.0},
        "pointCount": 4,
    }
    monkeypatch.setattr(gps_preview, "parse_file", lambda *_a, **_k: object())
    monkeypatch.setattr(gps_preview, "_preview_from_log", lambda _log: built)

    result = gps_preview.compute_preview(xrk, session_id)
    assert result == built

    hit, again = gps_preview._try_read_disk_cache(session_id, xrk)
    assert hit is True
    assert again == built


def test_warm_from_log_writes_disk(isolated_gps_cache):
    xrk = isolated_gps_cache / "warm.xrk"
    xrk.write_bytes(b"warm")
    session_id = "sess-warm"
    preview = {
        "points": [[0.5, 0.5]],
        "bounds": {"minLat": 0.0, "maxLat": 1.0, "minLon": 0.0, "maxLon": 1.0},
        "pointCount": 5,
    }

    class _FakeLog:
        pass

    gps_preview._cache.clear()
    original = gps_preview._preview_from_log
    gps_preview._preview_from_log = lambda _log: preview
    try:
        gps_preview.warm_from_log(session_id, xrk, _FakeLog())
    finally:
        gps_preview._preview_from_log = original

    hit, cached = gps_preview._try_read_disk_cache(session_id, xrk)
    assert hit is True
    assert cached == preview


def test_parse_gate_interactive_before_preview():
    order: list[str] = []

    def preview_worker():
        with PARSE_GATE.hold(PRIORITY_PREVIEW):
            order.append("preview")

    with PARSE_GATE.hold(PRIORITY_INTERACTIVE):
        t = threading.Thread(target=preview_worker)
        t.start()
        time.sleep(0.05)
        order.append("interactive")
    t.join(timeout=2)
    assert order == ["interactive", "preview"]
