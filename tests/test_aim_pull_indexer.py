"""Background indexing of pulled AiM files (runs after the device is released)."""

from __future__ import annotations

import threading

import pytest

from services import aim_pull_indexer, aim_pull_log, aim_pull_progress, session_store
from services.session_cache import session_cache

_INFO = {
    "metadata": {"venue": "Track", "driver": "D", "vehicle": "V", "date": "08/26/2026", "time": "20:53:39"},
    "durationMs": 163_000,
    "lapCount": 4,
}


def _job(tmp_path, name: str = "a_0242.xrz", **overrides) -> aim_pull_indexer.IndexJob:
    path = tmp_path / name
    path.write_bytes(b"x" * 500)
    entry = session_store.add_session(
        filename=name, source="aim_device", local_path=str(path), index_status="pending",
    )
    fields = dict(
        session_id=entry["id"],
        filename=name,
        path=path,
        device_ip="10.0.0.1",
        size=500,
        download_s=1.5,
    )
    fields.update(overrides)
    return aim_pull_indexer.IndexJob(**fields)


@pytest.fixture
def fake_parser(monkeypatch):
    calls: list[tuple] = []

    def _parse(path, priority=None):
        calls.append((path, priority, threading.current_thread().name))
        return object()

    monkeypatch.setattr(aim_pull_indexer, "parse_file", _parse)
    monkeypatch.setattr(aim_pull_indexer, "extract_session_info", lambda log, filename: _INFO)
    monkeypatch.setattr(aim_pull_indexer.gps_preview, "warm_from_log", lambda *a, **k: None)
    return calls


def test_index_one_fills_metadata_and_prefers_device_date(tmp_path, fake_parser):
    # Arrange
    job = _job(tmp_path, device_date="01/09/2026", device_hour="14:30:00")

    # Act
    ok = aim_pull_indexer.index_one(job)

    # Assert
    assert ok is True
    stored = session_store.get_session(job.session_id)
    assert stored["index_status"] == "ok"
    assert stored["track_name"] == "Track"
    assert stored["lap_count"] == 4
    assert stored["duration_s"] == 163
    assert stored["recorded_at"] == "2026-09-01T14:30:00"
    assert session_cache.get_valid(job.session_id, job.path) is not None
    assert aim_pull_progress.snapshot()["indexing"] == {job.filename: "ok"}
    assert aim_pull_log.list_recent()[0]["status"] == "ok"


def test_index_one_parses_at_preview_priority(tmp_path, fake_parser):
    from parsers.parse_gate import PRIORITY_PREVIEW

    aim_pull_indexer.index_one(_job(tmp_path))

    assert fake_parser[0][1] == PRIORITY_PREVIEW


def test_index_one_marks_failed_on_parse_error(tmp_path, monkeypatch):
    def _boom(path, priority=None):
        raise ValueError("corrupt xrk")

    monkeypatch.setattr(aim_pull_indexer, "parse_file", _boom)
    job = _job(tmp_path)

    ok = aim_pull_indexer.index_one(job)

    assert ok is False
    assert session_store.get_session(job.session_id)["index_status"] == "failed"
    assert aim_pull_progress.snapshot()["indexing"] == {job.filename: "failed"}
    entry = aim_pull_log.list_recent()[0]
    assert entry["status"] == "parse_failed"
    assert "corrupt xrk" in entry["error"]


@pytest.mark.real_aim_indexer
def test_enqueue_parses_on_the_background_worker(tmp_path, fake_parser):
    # Arrange
    jobs = [_job(tmp_path, "a_0241.xrz"), _job(tmp_path, "a_0242.xrz")]

    # Act
    for job in jobs:
        aim_pull_indexer.enqueue(job)
    finished = aim_pull_indexer.wait_idle(timeout=5)

    # Assert
    assert finished
    assert [c[2] for c in fake_parser] == ["aim-pull-indexer", "aim-pull-indexer"]
    assert aim_pull_progress.snapshot()["indexing"] == {"a_0241.xrz": "ok", "a_0242.xrz": "ok"}


def test_new_pull_prunes_finished_but_keeps_in_flight_indexing():
    aim_pull_progress.set_index_status("done.xrz", "ok")
    aim_pull_progress.set_index_status("bad.xrz", "failed")
    aim_pull_progress.set_index_status("busy.xrz", "running")

    aim_pull_progress.begin_pull(["next.xrz"])

    assert aim_pull_progress.snapshot()["indexing"] == {"busy.xrz": "running"}
    aim_pull_progress.end_pull()
