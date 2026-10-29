"""Session file path resolution across native vs Docker data dirs."""

from __future__ import annotations

from pathlib import Path

import pytest

from services import session_store


@pytest.fixture()
def isolated_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    data_dir = tmp_path / "data"
    sessions_dir = data_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    monkeypatch.setattr(session_store, "DATA_DIR", data_dir)
    monkeypatch.setattr(session_store, "SESSIONS_FILE", data_dir / "sessions.json")
    monkeypatch.setattr(session_store, "SESSIONS_DIR", sessions_dir)
    return sessions_dir


def test_resolve_session_path_uses_canonical_when_stored_path_missing(
    isolated_store: Path,
):
    xrk = isolated_store / "lap1.xrk"
    xrk.write_bytes(b"stub")

    entry = {
        "filename": "lap1.xrk",
        "local_path": r"C:\Users\dev\quickscope\backend\data\sessions\lap1.xrk",
    }

    resolved = session_store.resolve_session_path(entry)
    assert resolved == xrk


def test_repair_session_path_updates_stale_index(isolated_store: Path):
    xrk = isolated_store / "lap2.xrk"
    xrk.write_bytes(b"stub")

    entry = session_store.add_session(
        filename="lap2.xrk",
        source="manual_upload",
        local_path=r"C:\stale\path\lap2.xrk",
    )

    repaired = session_store.repair_session_path(entry["id"], entry)
    assert repaired == xrk

    stored = session_store.get_session(entry["id"])
    assert stored is not None
    assert stored["local_path"] == str(xrk)
