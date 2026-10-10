"""Persistence layer: sessions.json index and settings.json."""

from __future__ import annotations

import json

import pytest

from services import session_store, settings_store


# ─── session_store ───────────────────────────────────────────────────────────


def test_add_get_update_delete_roundtrip():
    entry = session_store.add_session(
        "run.xrk", source="manual_upload", track_name="Lime Rock", lap_count=4, duration_s=61.5
    )
    assert session_store.get_session(entry["id"]) == entry
    assert session_store.find_by_filename("run.xrk")["id"] == entry["id"]
    assert session_store.find_by_aim_session_id("run")["id"] == entry["id"]  # defaults to stem

    updated = session_store.update_session(entry["id"], track_name="Pitt Race")
    assert updated["track_name"] == "Pitt Race"
    assert updated["updated_at"] >= entry["updated_at"]
    assert session_store.get_session(entry["id"])["lap_count"] == 4

    assert session_store.delete_session(entry["id"]) is True
    assert session_store.delete_session(entry["id"]) is False
    assert session_store.list_sessions() == []


def test_update_unknown_session_returns_none():
    assert session_store.update_session("nope", track_name="x") is None


def test_ids_are_unique_and_order_is_insertion_order():
    ids = [session_store.add_session(f"{i}.xrk", source="manual_upload")["id"] for i in range(5)]
    assert len(set(ids)) == 5
    assert [s["id"] for s in session_store.list_sessions()] == ids


def test_index_survives_reload_from_disk():
    entry = session_store.add_session("run.xrk", source="aim_device", recorded_at="2026-10-05T14:30:00")
    on_disk = json.loads(session_store.SESSIONS_FILE.read_text())
    assert on_disk[0]["id"] == entry["id"]
    assert on_disk[0]["recorded_at"] == "2026-10-05T14:30:00"


def test_save_is_atomic_and_leaves_no_temp_file():
    session_store.add_session("a.xrk", source="manual_upload")
    assert not list(session_store.DATA_DIR.glob("*.tmp"))


def test_failed_write_keeps_previous_index_intact(monkeypatch):
    session_store.add_session("keep.xrk", source="manual_upload")
    before = session_store.SESSIONS_FILE.read_text()

    def explode(*_a, **_k):
        raise OSError("disk full")

    with monkeypatch.context() as m:
        m.setattr(session_store.json, "dump", explode)
        with pytest.raises(OSError):
            session_store.add_session("new.xrk", source="manual_upload")

    assert session_store.SESSIONS_FILE.read_text() == before
    assert [s["filename"] for s in session_store.list_sessions()] == ["keep.xrk"]


@pytest.mark.parametrize("name", ["../escape.xrk", "a/../../escape.xrk", "/abs/escape.xrk"])
def test_session_file_path_never_escapes_sessions_dir(name):
    path = session_store.session_file_path(name)
    assert path.parent == session_store.SESSIONS_DIR.resolve()
    assert path.name == "escape.xrk"


@pytest.mark.parametrize("name", ["", "/", ".."])
def test_session_file_path_rejects_empty_names(name):
    with pytest.raises(ValueError):
        session_store.session_file_path(name)


def test_resolve_session_path_prefers_stored_path_then_canonical(tmp_path):
    elsewhere = tmp_path / "elsewhere.xrk"
    elsewhere.write_bytes(b"x")
    assert session_store.resolve_session_path({"filename": "x.xrk", "local_path": str(elsewhere)}) == elsewhere

    assert session_store.resolve_session_path({"filename": "x.xrk", "local_path": "/missing/x.xrk"}) is None
    canonical = session_store.session_file_path("x.xrk")
    canonical.write_bytes(b"x")
    assert session_store.resolve_session_path({"filename": "x.xrk", "local_path": "/missing/x.xrk"}) == canonical
    assert session_store.resolve_session_path({}) is None


def _legacy(index, **overrides):
    entry = {"id": "x", "filename": "x.xrk", "local_path": None, "source": "manual_upload",
             "aim_session_id": "x", "created_at": "t", "updated_at": "t", **overrides}
    index.append(entry)
    return entry


def test_new_entries_have_no_cloud_fields():
    entry = session_store.add_session("a.xrk", source="manual_upload")
    assert "remote_id" not in entry and "sync_status" not in entry
    assert not hasattr(session_store, "find_by_remote_id")
    assert not hasattr(session_store, "reset_stale_sync_states")


def test_migration_prunes_remote_only_entries_without_a_file():
    index: list[dict] = []
    _legacy(index, id="ghost", filename="ghost.xrk", source="railway", sync_status="remote_only", remote_id=1)
    _legacy(index, id="ghost2", filename="g2.xrk", sync_status="remote_only", remote_id=2)
    session_store.SESSIONS_FILE.write_text(json.dumps(index))

    assert session_store.migrate_legacy_entries() == {"pruned": 2, "cleaned": 0}
    assert session_store.list_sessions() == []


def test_migration_keeps_local_files_and_strips_cloud_keys():
    f = session_store.session_file_path("have.xrk")
    f.write_bytes(b"x")
    index: list[dict] = []
    _legacy(index, id="a", filename="have.xrk", local_path=str(f), source="railway",
            sync_status="synced", remote_id=5)
    _legacy(index, id="b", filename="have.xrk", local_path=str(f), source="aim_device",
            sync_status="local_only", remote_id=None)
    session_store.SESSIONS_FILE.write_text(json.dumps(index))

    assert session_store.migrate_legacy_entries() == {"pruned": 0, "cleaned": 2}
    a, b = session_store.list_sessions()
    assert a["source"] == "manual_upload"  # railway -> manual_upload
    assert b["source"] == "aim_device"
    assert all("sync_status" not in s and "remote_id" not in s for s in (a, b))


def test_migration_never_touches_ordinary_sessions_with_missing_files():
    """A manually uploaded session whose file went missing is not 'legacy'; leave it
    so the user sees the real error instead of silently losing the row."""
    index: list[dict] = []
    _legacy(index, id="m", filename="missing.xrk", local_path="/gone/missing.xrk")
    session_store.SESSIONS_FILE.write_text(json.dumps(index))
    assert session_store.migrate_legacy_entries() == {"pruned": 0, "cleaned": 0}
    assert [s["id"] for s in session_store.list_sessions()] == ["m"]


def test_migration_is_idempotent_and_skips_writing_when_clean():
    session_store.add_session("a.xrk", source="manual_upload")
    before = session_store.SESSIONS_FILE.stat().st_mtime_ns
    assert session_store.migrate_legacy_entries() == {"pruned": 0, "cleaned": 0}
    assert session_store.SESSIONS_FILE.stat().st_mtime_ns == before


def test_migration_on_empty_store():
    assert session_store.migrate_legacy_entries() == {"pruned": 0, "cleaned": 0}


# ─── settings_store ──────────────────────────────────────────────────────────


def test_load_creates_defaults_when_file_missing():
    settings_store.SETTINGS_FILE.unlink(missing_ok=True)
    loaded = settings_store.load()
    assert loaded == settings_store.DEFAULTS
    assert settings_store.SETTINGS_FILE.exists()


def test_stored_values_override_defaults_and_new_defaults_still_appear():
    settings_store.SETTINGS_FILE.write_text(json.dumps({"aim_device_ip": "9.9.9.9"}))
    loaded = settings_store.load()
    assert loaded["aim_device_ip"] == "9.9.9.9"
    assert loaded["aim_device_port"] == 2000


def test_update_filters_unknown_keys_and_persists():
    out = settings_store.update({"aim_device_port": 2222, "not_a_setting": 1})
    assert out["aim_device_port"] == 2222
    assert "not_a_setting" not in out
    assert json.loads(settings_store.SETTINGS_FILE.read_text())["aim_device_port"] == 2222


def test_settings_save_is_atomic():
    settings_store.update({"aim_device_ip": "1.1.1.1"})
    assert not list(settings_store.DATA_DIR.glob("*.tmp"))


def test_failed_settings_write_keeps_previous_file(monkeypatch):
    settings_store.update({"aim_device_ip": "1.1.1.1"})
    before = settings_store.SETTINGS_FILE.read_text()
    def explode(*_a, **_k):
        raise OSError("full")

    with monkeypatch.context() as m:
        m.setattr(settings_store.json, "dump", explode)
        with pytest.raises(OSError):
            settings_store.update({"aim_device_ip": "2.2.2.2"})
    assert settings_store.SETTINGS_FILE.read_text() == before


def test_defaults_have_no_railway_url():
    assert "railway_url" not in settings_store.DEFAULTS
    assert set(settings_store.DEFAULTS) == {
        "aim_wifi_ssid", "aim_device_ip", "aim_device_port",
    }


def test_load_strips_legacy_keys_and_rewrites_file():
    settings_store.SETTINGS_FILE.write_text(
        json.dumps({"railway_url": "https://x", "aim_device_ip": "7.7.7.7"})
    )
    loaded = settings_store.load()
    assert loaded["aim_device_ip"] == "7.7.7.7"
    assert "railway_url" not in loaded
    assert json.loads(settings_store.SETTINGS_FILE.read_text()).keys() == loaded.keys()


def test_update_drops_legacy_keys_already_in_the_file():
    settings_store.SETTINGS_FILE.write_text(json.dumps({"railway_url": "https://x"}))
    out = settings_store.update({"aim_device_port": 2005})
    assert "railway_url" not in out
    assert "railway_url" not in json.loads(settings_store.SETTINGS_FILE.read_text())


# ─── ring logs (upload_log / aim_pull_log share RingLog) ─────────────────────


def test_ring_log_is_bounded_newest_first_and_clearable():
    from services.ring_log import RingLog

    log = RingLog(max_entries=3)
    for i in range(5):
        log.append({"i": i})
    assert [e["i"] for e in log.list_recent()] == [4, 3, 2]
    log.clear()
    assert log.list_recent() == []


def test_upload_and_pull_logs_are_independent():
    from services import aim_pull_log, upload_log

    upload_log.record(filename="a.xrk", size=1, duration_s=0.1, client_ip="x", user_agent="u", status="ok")
    aim_pull_log.record(action="list", status="list_ok", session_count=2)
    assert [e["filename"] for e in upload_log.list_recent()] == ["a.xrk"]
    assert [e["action"] for e in aim_pull_log.list_recent()] == ["list"]
    upload_log.clear()
    assert aim_pull_log.list_recent() != []
