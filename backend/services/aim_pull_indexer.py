"""Background parse + metadata indexing for files pulled from the AiM device.

The pull route only waits for bytes to land on disk; the device is released
before parsing starts. A single worker thread parses at preview priority so an
interactive ``load_session`` still preempts it through the parse gate.
"""

from __future__ import annotations

import logging
import queue
import threading
from dataclasses import dataclass
from pathlib import Path

from parsers.parse_gate import PRIORITY_PREVIEW
from services import aim_pull_log, aim_pull_progress, gps_preview, session_store
from services.session_cache import session_cache
from state import extract_session_info, parse_file, resolve_aim_recorded_at

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IndexJob:
    session_id: str
    filename: str
    path: Path
    device_ip: str
    size: int
    download_s: float
    device_date: str = ""
    device_hour: str = ""


_queue: "queue.Queue[IndexJob]" = queue.Queue()
_worker_lock = threading.Lock()
_worker: threading.Thread | None = None
_idle = threading.Condition()
_pending = 0


def enqueue(job: IndexJob) -> None:
    """Queue ``job`` and make sure the worker thread is running."""
    global _pending
    aim_pull_progress.set_index_status(job.filename, "pending")
    with _idle:
        _pending += 1
    _queue.put(job)
    _ensure_worker()


def wait_idle(timeout: float | None = None) -> bool:
    """Block until every queued job has finished. Returns False on timeout."""
    with _idle:
        return _idle.wait_for(lambda: _pending == 0, timeout=timeout)


def _ensure_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_run, name="aim-pull-indexer", daemon=True)
        _worker.start()


def _run() -> None:
    global _pending
    while True:
        job = _queue.get()
        try:
            index_one(job)
        except Exception:
            logger.exception("AiM index: unexpected failure for %s", job.filename)
            aim_pull_progress.set_index_status(job.filename, "failed")
        finally:
            with _idle:
                _pending -= 1
                _idle.notify_all()


def index_one(job: IndexJob) -> bool:
    """Parse ``job.path`` and fill in the session's metadata. Returns parse success."""
    aim_pull_progress.set_index_status(job.filename, "running")
    try:
        log = parse_file(job.path, PRIORITY_PREVIEW)
        info = extract_session_info(log, job.filename)
    except Exception as exc:
        logger.warning("AiM index: parse failed for %s: %s", job.filename, exc)
        session_store.update_session(job.session_id, index_status="failed")
        aim_pull_progress.set_index_status(job.filename, "failed")
        aim_pull_log.record(
            action="pull",
            status="parse_failed",
            device_ip=job.device_ip,
            filename=job.filename,
            size=job.size,
            duration_s=job.download_s,
            session_id=job.session_id,
            error=str(exc)[:200],
        )
        return False

    meta = info.get("metadata", {})
    session_store.update_session(
        job.session_id,
        track_name=meta.get("venue", ""),
        driver_name=meta.get("driver", ""),
        vehicle_name=meta.get("vehicle", ""),
        recorded_at=resolve_aim_recorded_at(
            job.device_date, job.device_hour, meta.get("date", ""), meta.get("time", ""),
        ),
        duration_s=info.get("durationMs", 0) / 1000,
        lap_count=info.get("lapCount", 0),
        index_status="ok",
    )
    session_cache.put(job.session_id, log, job.filename, job.path)
    try:
        gps_preview.warm_from_log(job.session_id, job.path, log)
    except Exception:
        logger.exception("Failed to warm GPS preview cache for %s", job.filename)
    aim_pull_progress.set_index_status(job.filename, "ok")
    aim_pull_log.record(
        action="pull",
        status="ok",
        device_ip=job.device_ip,
        filename=job.filename,
        size=job.size,
        duration_s=job.download_s,
        session_id=job.session_id,
    )
    return True
