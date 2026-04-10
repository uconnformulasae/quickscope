"""
Sync service — bidirectional sync between local session index and Railway.

Pull: fetch remote session list, add missing ones as remote_only.
Push: upload local_only sessions to Railway.
"""

import logging

from pathlib import Path

from services import session_store, railway_client

logger = logging.getLogger(__name__)


async def sync_with_railway() -> dict:
    """Full bidirectional sync with Railway.

    Returns a summary of what happened.
    """
    stats = {"pulled": 0, "pushed": 0, "errors": []}

    # --- Pull: discover remote sessions ---
    try:
        remote_sessions = await railway_client.list_remote_sessions()
    except Exception as exc:
        stats["errors"].append(f"Failed to fetch remote sessions: {exc}")
        return stats

    for remote in remote_sessions:
        remote_id = remote["id"]

        # Check if we already know this session
        existing = session_store.find_by_remote_id(remote_id)
        if existing:
            continue

        # Also check by filename
        filename = remote.get("filename", "")
        by_name = session_store.find_by_filename(filename) if filename else None
        if by_name:
            session_store.update_session(
                by_name["id"],
                remote_id=remote_id,
                sync_status="synced" if by_name.get("local_path") else "remote_only",
            )
            continue

        # New remote session — add as remote_only
        session_store.add_session(
            filename=filename,
            source="railway",
            sync_status="remote_only",
            remote_id=remote_id,
            aim_session_id=remote.get("aim_session_id", ""),
            track_name=remote.get("track_name", ""),
            driver_name=remote.get("driver_name", ""),
            vehicle_name=remote.get("vehicle_name", ""),
            recorded_at=remote.get("recorded_at"),
            duration_s=remote.get("duration_s", 0),
            lap_count=remote.get("lap_count", 0),
        )
        stats["pulled"] += 1

    # --- Push: upload local_only sessions ---
    local_sessions = session_store.list_sessions()
    for local in local_sessions:
        if local["sync_status"] != "local_only":
            continue
        if not local.get("local_path"):
            continue

        file_path = Path(local["local_path"])
        if not file_path.exists():
            continue

        try:
            session_store.update_session(local["id"], sync_status="uploading")
            result = await railway_client.upload_session_file(file_path)
            if result.get("ok"):
                session_store.update_session(
                    local["id"],
                    sync_status="synced",
                )
                stats["pushed"] += 1
            else:
                session_store.update_session(local["id"], sync_status="local_only")
                stats["errors"].append(f"Upload failed for {local['filename']}: {result}")
        except Exception as exc:
            session_store.update_session(local["id"], sync_status="local_only")
            stats["errors"].append(f"Upload failed for {local['filename']}: {exc}")

    return stats


async def pull_session(session_id: str) -> dict:
    """Download a specific remote_only session's file from Railway."""
    entry = session_store.get_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    remote_id = entry.get("remote_id")
    if not remote_id:
        return {"ok": False, "error": "No remote ID for this session"}

    dest = session_store.session_file_path(entry["filename"])

    try:
        session_store.update_session(session_id, sync_status="downloading")
        await railway_client.download_session_file(remote_id, dest)
        session_store.update_session(
            session_id,
            local_path=str(dest),
            sync_status="synced",
        )
        return {"ok": True, "local_path": str(dest)}
    except Exception as exc:
        session_store.update_session(session_id, sync_status="remote_only")
        return {"ok": False, "error": str(exc)}
