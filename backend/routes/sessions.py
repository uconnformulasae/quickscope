"""Session management routes — CRUD, rename, AiM device integration."""

import asyncio
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from services.csv_export import streaming_csv_response
from services.xrk_export import read_xrk_export_bytes

from services import (
    session_store,
    aim_connector,
    gps_preview,
    aim_pull_log,
    aim_download_trace,
)
from services.aim_keepalive import AimKeepalive
from services import aim_pull_indexer, aim_pull_progress
from services.aim_primary_hub import AimLiveActiveError, get_aim_primary_hub
from parsers.parse_gate import PRIORITY_INTERACTIVE
from services.session_cache import session_cache
from state import (
    state, logger,
    parse_file, extract_session_info, sanitize_filename,
    resolve_aim_recorded_at, apply_stored_recorded_at,
)

router = APIRouter(prefix="/api")


# ─── Session CRUD ────────────────────────────────────────────────────────────

@router.get("/sessions")
async def list_sessions():
    return session_store.list_sessions()


@router.post("/sessions/{session_id}/load")
async def load_session(session_id: str):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = session_store.repair_session_path(session_id, entry)
    if local_path is None:
        raise HTTPException(400, "Session file not available locally. Pull it first.")

    cached = session_cache.get_valid(session_id, local_path)
    if cached is not None:
        log, _ = cached
        session_cache.set_active(session_id)
        state.filename = entry["filename"]
    else:
        try:
            log = await asyncio.to_thread(
                parse_file, local_path, PRIORITY_INTERACTIVE,
            )
        except Exception:
            logger.exception("Failed to parse session file")
            raise HTTPException(500, "Failed to parse session file")
        session_cache.put(session_id, log, entry["filename"], local_path)
        session_cache.set_active(session_id)
        state.filename = entry["filename"]

    info = extract_session_info(log, entry["filename"])
    if entry.get("source") == "aim_device" and entry.get("recorded_at"):
        info = apply_stored_recorded_at(info, entry["recorded_at"])
    return info


async def _parsed_log_for_session(session_id: str):
    """Load a session's parsed log from cache or disk without changing analysis UI state."""
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = session_store.repair_session_path(session_id, entry)
    if local_path is None:
        raise HTTPException(400, "Session file not available locally. Pull it first.")

    try:
        log = await asyncio.to_thread(
            session_cache.get_or_load,
            session_id,
            local_path,
            lambda: parse_file(local_path, PRIORITY_INTERACTIVE),
        )
    except Exception:
        logger.exception("Failed to parse session file")
        raise HTTPException(500, "Failed to parse session file")

    return entry, log, local_path


@router.get("/sessions/{session_id}/file")
async def download_session_file(session_id: str):
    """Export session data as an uncompressed ``.xrk`` (decompresses ``.xrz`` on disk)."""
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = session_store.repair_session_path(session_id, entry)
    if local_path is None:
        raise HTTPException(400, "Session file not available locally. Pull it first.")

    try:
        payload, download_name = await asyncio.to_thread(
            read_xrk_export_bytes,
            local_path,
            entry.get("filename"),
            entry.get("aim_session_id"),
        )
    except ValueError:
        logger.exception("Failed to prepare XRK export")
        raise HTTPException(500, "Failed to export session file")

    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


@router.get("/sessions/{session_id}/export")
async def export_session_csv(session_id: str, channels: str = Query(...)):
    """CSV export for a stored session without requiring it to be the active analysis session."""
    names = [n.strip() for n in channels.split(",") if n.strip()]
    if not names:
        raise HTTPException(400, "No channels specified")

    entry, log, _local_path = await _parsed_log_for_session(session_id)

    try:
        return streaming_csv_response(
            log, entry["filename"], names, aim_session_id=entry.get("aim_session_id"),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


class RenameRequest(BaseModel):
    filename: str


@router.post("/sessions/{session_id}/rename")
async def rename_session(session_id: str, body: RenameRequest):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    try:
        new_filename = sanitize_filename(body.filename)
    except ValueError:
        raise HTTPException(400, "Invalid filename")

    # Preserve original extension if the user omitted it
    old_ext = Path(entry["filename"]).suffix
    if old_ext and not Path(new_filename).suffix:
        new_filename += old_ext

    # Check for conflicts
    existing = session_store.find_by_filename(new_filename)
    if existing and existing["id"] != session_id:
        raise HTTPException(409, "A session with that filename already exists")

    # Rename physical file on disk
    old_path = session_store.resolve_session_path(entry)
    new_path = None
    if old_path and old_path.exists():
        new_path = str(session_store.session_file_path(new_filename))
        old_path.rename(new_path)

    # Keep the in-memory caches pointing at the renamed file. rebind_file
    # re-fingerprints the new path so the next load is still a cache hit; the
    # active session's filename is read back from this entry.
    if new_path:
        session_cache.rebind_file(session_id, Path(new_path), new_filename)
        gps_preview.evict(path=old_path)
    else:
        session_cache.rename(session_id, new_filename)

    updated = session_store.update_session(
        session_id,
        filename=new_filename,
        aim_session_id=Path(new_filename).stem,
        local_path=new_path or (str(old_path) if old_path else entry.get("local_path")),
    )
    return updated


@router.get("/sessions/{session_id}/gps-preview")
async def get_gps_preview(session_id: str):
    """Returns a downsampled GPS thumbnail for the SessionBrowser UI.

    Returns 200 with `{"preview": null}` if the session has no usable GPS
    track (so the frontend can cache the absence and skip the icon). Only
    returns 404 when the session itself doesn't exist.
    """
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")
    local_path = session_store.resolve_session_path(entry)
    if local_path is None:
        return {"preview": None}
    preview = await asyncio.to_thread(
        gps_preview.compute_preview, local_path, session_id,
    )
    return {"preview": preview}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = session_store.resolve_session_path(entry)
    if local_path:
        local_path.unlink(missing_ok=True)

    if state.session_id == session_id:
        state.clear()
    session_cache.evict(session_id)
    gps_preview.evict(session_id, local_path)

    session_store.delete_session(session_id)
    return {"ok": True}


# ─── AiM Device ──────────────────────────────────────────────────────────────

@router.get("/aim/status")
async def aim_status():
    device_info = await asyncio.to_thread(aim_connector.discover_device)
    connected = device_info is not None
    return {"connected": connected, "device": device_info}


@router.get("/aim/sessions")
async def list_aim_sessions():
    started = time.monotonic()
    device = await asyncio.to_thread(aim_connector.discover_device)
    device_ip = device["ip"] if device else ""

    sessions = []
    try:
        hub = get_aim_primary_hub()
        sessions = await hub.list_sessions(device_ip or None)
    except ConnectionError as exc:
        aim_pull_log.record(
            action="list",
            status="list_failed",
            device_ip=device_ip,
            duration_s=time.monotonic() - started,
            session_count=0,
            error=str(exc)[:200],
        )
        return {
            "ok": False,
            "sessions": [],
            "error": "Could not connect to AiM device. Check WiFi connection and device IP in Settings.",
        }
    duration_s = time.monotonic() - started

    aim_pull_log.record(
        action="list",
        status="list_ok",
        device_ip=device_ip,
        duration_s=duration_s,
        session_count=len(sessions),
    )

    local_sessions = session_store.list_sessions()
    local_filenames = {s["filename"] for s in local_sessions}

    for s in sessions:
        s["already_downloaded"] = s["filename"] in local_filenames

    return {"ok": True, "sessions": sessions}


@router.get("/aim/pull/log")
async def get_aim_pull_log():
    """Recent AiM list/pull attempts, newest first. In-memory only."""
    return {"entries": aim_pull_log.list_recent()}


@router.get("/aim/pull/progress")
async def get_aim_pull_progress():
    """Byte progress for the pull currently running on this backend instance."""
    return aim_pull_progress.snapshot()


@router.get("/aim/download/trace")
async def list_aim_download_traces():
    """List persisted AiM download trace logs (newest first)."""
    log_dir = aim_download_trace._LOG_DIR
    if not log_dir.is_dir():
        return {"traces": []}
    files = sorted(log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    return {
        "traces": [
            {
                "path": str(path),
                "name": path.name,
                "size": path.stat().st_size,
                "modified_at": path.stat().st_mtime,
            }
            for path in files[:20]
        ]
    }


@router.get("/aim/download/trace/{name}")
async def get_aim_download_trace(name: str):
    """Return one AiM download trace log file."""
    log_dir = aim_download_trace._LOG_DIR
    path = (log_dir / Path(name).name).resolve()
    if not path.is_file() or not path.is_relative_to(log_dir.resolve()):
        raise HTTPException(404, "Trace log not found")
    return {"name": path.name, "lines": path.read_text(encoding="utf-8").splitlines()}


class AimPullRequest(BaseModel):
    filenames: list[str]


@router.post("/aim/pull")
async def pull_from_aim(body: AimPullRequest):
    if not body.filenames:
        return {"ok": False, "error": "No files selected", "downloaded": [], "results": []}

    device = await asyncio.to_thread(aim_connector.discover_device)
    device_ip = device["ip"] if device else ""

    logger.info("AiM pull: downloading %d selected sessions...", len(body.filenames))

    batch = _PullBatch(device_ip)
    filenames = batch.sanitize(body.filenames)
    aim_pull_progress.begin_pull(filenames)
    hub = get_aim_primary_hub()
    try:
        try:
            primary = await hub.download_sessions(
                filenames,
                lambda name: session_store.session_file_path(name).parent,
                host=device_ip or None,
                on_file_start=aim_pull_progress.start_file,
                on_progress=aim_pull_progress.update_download,
                on_file_done=batch.complete,
            )
        except AimLiveActiveError as exc:
            return {
                "ok": False,
                "error": str(exc),
                "downloaded": [],
                "errors": [str(exc)],
                "results": [],
            }
        if primary.remaining:
            logger.warning(
                "AiM pull: primary TCP failed (%s); retrying %d file(s) on a dedicated download TCP",
                primary.error,
                len(primary.remaining),
            )
            await _download_legacy(
                hub,
                primary.remaining,
                primary.device_meta_by_file,
                batch,
                first_index=len(primary.downloaded) + 1,
            )
    finally:
        aim_pull_progress.end_pull()

    return batch.response()


async def _start_download_keepalive(host: str) -> AimKeepalive | None:
    """Race Studio keeps ``aim-ka`` running during downloads (RS3_PULL_241/242);
    without it the device drops port 2000 ~30 s after the last datagram."""
    keepalive = AimKeepalive(host)
    try:
        await keepalive.start()
    except OSError as exc:
        logger.warning("AiM pull: keepalive could not start (%s); long downloads may drop", exc)
        return None
    return keepalive


async def _download_legacy(
    hub,  # noqa: ANN001
    filenames: list[str],
    device_meta_by_file: dict[str, dict],
    batch: "_PullBatch",
    *,
    first_index: int,
) -> None:
    """Fallback: close the primary and pull each file over its own download TCP."""
    try:
        await hub.release_for_download()
    except ConnectionError as exc:
        for filename in filenames:
            batch.fail(filename, exc, 0.0)
        return

    keepalive = await _start_download_keepalive(hub.resolve_host(batch.device_ip or None))
    try:
        for file_index, filename in enumerate(filenames, start=first_index):
            device_meta = device_meta_by_file.get(filename, {})
            expected_size = int(device_meta.get("size", 0) or 0)
            aim_pull_progress.start_file(file_index, filename, expected_size)
            dest = session_store.session_file_path(filename)
            started = time.monotonic()
            try:
                await asyncio.to_thread(
                    aim_connector.download_aim_session,
                    filename,
                    dest.parent,
                    expected_size,
                    aim_pull_progress.update_download,
                )
            except Exception as exc:
                batch.fail(filename, exc, time.monotonic() - started)
                continue
            batch.complete(filename, dest, time.monotonic() - started, device_meta)
    finally:
        if keepalive is not None:
            await keepalive.stop()


class _PullBatch:
    """Collects per-file pull outcomes; registers and queues each landed file for indexing."""

    def __init__(self, device_ip: str) -> None:
        self.device_ip = device_ip
        self.downloaded: list[str] = []
        self.errors: list[str] = []
        self.results: list[dict] = []

    def sanitize(self, raw_filenames: list[str]) -> list[str]:
        valid = []
        for raw in raw_filenames:
            try:
                valid.append(sanitize_filename(raw))
            except ValueError:
                self.errors.append(f"{raw}: invalid filename")
                aim_pull_log.record(
                    action="pull",
                    status="download_failed",
                    device_ip=self.device_ip,
                    filename=raw,
                    error="invalid filename",
                )
        return valid

    def fail(self, filename: str, exc: BaseException, duration_s: float) -> None:
        logger.error("AiM pull: failed to download %s: %s", filename, exc, exc_info=exc)
        self.errors.append(f"{filename}: {exc}")
        aim_pull_log.record(
            action="pull",
            status="download_failed",
            device_ip=self.device_ip,
            filename=filename,
            duration_s=duration_s,
            error=str(exc)[:200],
        )

    def complete(self, filename: str, path: Path, duration_s: float, device_meta: dict) -> None:
        """Register a landed file and queue it for background indexing. Never raises."""
        try:
            self._register(filename, path, duration_s, device_meta)
        except Exception as exc:
            self.fail(filename, exc, duration_s)

    def _register(self, filename: str, path: Path, duration_s: float, device_meta: dict) -> None:
        file_bytes = path.stat().st_size
        expected_size = int(device_meta.get("size", 0) or 0)
        if expected_size > 0 and file_bytes < expected_size:
            raise RuntimeError(
                f"Incomplete download: got {file_bytes} bytes, expected {expected_size} bytes"
            )
        logger.info("AiM pull: saved %s (%d bytes) in %.1fs", path, file_bytes, duration_s)

        device_date = device_meta.get("date", "")
        device_hour = device_meta.get("hour", "")
        fields = {
            "local_path": str(path),
            "recorded_at": resolve_aim_recorded_at(device_date, device_hour, "", ""),
            "index_status": "pending",
        }
        existing = session_store.find_by_filename(filename)
        if existing is not None:
            entry = session_store.update_session(existing["id"], **fields) or existing
        else:
            entry = session_store.add_session(filename=filename, source="aim_device", **fields)

        aim_pull_indexer.enqueue(aim_pull_indexer.IndexJob(
            session_id=entry["id"],
            filename=filename,
            path=path,
            device_ip=self.device_ip,
            size=file_bytes,
            download_s=duration_s,
            device_date=device_date,
            device_hour=device_hour,
        ))
        self.downloaded.append(filename)
        self.results.append({
            "filename": filename,
            "bytes": file_bytes,
            "duration_s": round(duration_s, 3),
            "session_id": entry["id"],
            "index_status": "pending",
            "local_path": str(path),
        })

    def response(self) -> dict:
        return {
            "ok": True,
            "downloaded": self.downloaded,
            "errors": self.errors,
            "results": self.results,
        }
