"""Regression tests for the second code audit (2026-11-10).

One test per finding: each pins the behaviour that was wrong or unprotected.
"""

from __future__ import annotations

import asyncio
import io
import struct
import sys
import threading

import pytest
from fastapi.testclient import TestClient

from conftest import make_log
from main import app
from routes import live as live_route
from routes import sessions as sessions_route
from services import aim_connector, aim_primary_hub, aim_pull_indexer, session_store, settings_store
from services.aim_connector import download_aim_session, pull_target_path
from services.aim_live import STNC_GET_SESSIONS, AimLiveClient, encode_frame
from services.session_cache import SessionCache, session_cache

client = TestClient(app)


# ─── Pulling a file whose name is already used locally ───────────────────────


def test_pull_target_is_the_plain_name_when_nothing_is_there(tmp_path):
    assert pull_target_path(tmp_path, "a_0001.xrz", 10) == tmp_path / "a_0001.xrz"


def test_pull_target_reuses_a_local_file_of_the_same_size(tmp_path):
    (tmp_path / "a_0001.xrz").write_bytes(b"x" * 10)

    assert pull_target_path(tmp_path, "a_0001.xrz", 10) == tmp_path / "a_0001.xrz"


@pytest.mark.parametrize("local_size", [3, 25])
def test_pull_target_keeps_a_different_local_session(tmp_path, local_size):
    """The logger reuses names after a memory clear: a size mismatch means a
    different session, whether the local one is smaller or larger."""
    (tmp_path / "a_0001.xrz").write_bytes(b"x" * local_size)

    assert pull_target_path(tmp_path, "a_0001.xrz", 10) == tmp_path / "a_0001_2.xrz"


def test_pull_target_finds_its_own_earlier_copy(tmp_path):
    (tmp_path / "a_0001.xrz").write_bytes(b"x" * 3)
    (tmp_path / "a_0001_2.xrz").write_bytes(b"y" * 10)

    assert pull_target_path(tmp_path, "a_0001.xrz", 10) == tmp_path / "a_0001_2.xrz"


def test_pull_target_trusts_the_local_file_when_the_size_is_unknown(tmp_path):
    (tmp_path / "a_0001.xrz").write_bytes(b"x" * 3)

    assert pull_target_path(tmp_path, "a_0001.xrz", 0) == tmp_path / "a_0001.xrz"


def test_failed_download_leaves_the_clashing_local_file_alone(tmp_path, monkeypatch):
    """It used to be deleted up front as "incomplete", before the download ran."""
    (tmp_path / "a.xrz").write_bytes(b"old")

    def refuse(**_kwargs):
        raise OSError("logger unreachable")

    monkeypatch.setattr(aim_connector, "_open_device_socket", refuse)

    with pytest.raises(OSError):
        download_aim_session("a.xrz", tmp_path, 10)

    assert (tmp_path / "a.xrz").read_bytes() == b"old"


def test_a_pulled_file_stored_under_a_suffix_is_its_own_session(isolated_data_dir):
    # Arrange: a manual upload already owns the logger's file name.
    sessions_dir = isolated_data_dir / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    (sessions_dir / "a_0001.xrz").write_bytes(b"manual")
    manual = session_store.add_session(
        "a_0001.xrz", source="manual_upload", local_path=str(sessions_dir / "a_0001.xrz"),
        track_name="Home Track",
    )
    pulled = sessions_dir / "a_0001_2.xrz"
    pulled.write_bytes(b"x" * 500)
    batch = sessions_route._PullBatch("10.0.0.1")

    # Act
    batch.complete("a_0001.xrz", pulled, 0.1, {"size": 500})
    aim_pull_indexer.wait_idle(5)

    # Assert: the upload is untouched and the pull is a second entry; the
    # response still names the file the way the logger (and the picker) does.
    by_name = {s["filename"]: s for s in session_store.list_sessions()}
    assert set(by_name) == {"a_0001.xrz", "a_0001_2.xrz"}
    assert by_name["a_0001.xrz"]["id"] == manual["id"]
    assert by_name["a_0001.xrz"]["source"] == "manual_upload"
    assert by_name["a_0001.xrz"]["track_name"] == "Home Track"
    assert by_name["a_0001_2.xrz"]["source"] == "aim_device"
    assert batch.downloaded == ["a_0001.xrz"]
    assert batch.results[0]["session_id"] == by_name["a_0001_2.xrz"]["id"]


# ─── Session list spanning several blocks ────────────────────────────────────


class _NullWriter:
    def write(self, _data: bytes) -> None:
        pass

    async def drain(self) -> None:
        pass

    def is_closing(self) -> bool:
        return False


def _control(sub_cmd: int, op: str, size: int = 0) -> bytes:
    payload = bytearray(64)
    payload[8:12] = struct.pack("<I", sub_cmd)
    payload[16:20] = struct.pack("<I", size)
    payload[24] = ord(op)
    return encode_frame(b"STCP", bytes(payload))


def test_session_list_block_offsets_are_not_read_as_text():
    """Each block starts with its u32 offset. 0x4241 is the bytes "AB": left in,
    they landed in the middle of whichever row crossed the block boundary."""
    first = b"name,size,date,hour,nlap,veicolo,device\r\na_0001.xrk,1000,19/10/2026,10:0"
    second = b"0:00,3,CT16,EVO5\r\na_0002.xrk,2000,19/10/2026,11:00:00,0,CT16,EVO5\r\n"
    server = (
        _control(STNC_GET_SESSIONS, "Q", len(first) + len(second))
        + encode_frame(b"STCP", struct.pack("<I", 0) + first)
        + encode_frame(b"STCP", struct.pack("<I", 0x4241) + second)
    )

    async def scenario():
        live = AimLiveClient(host="10.0.0.1")
        reader = asyncio.StreamReader()
        reader.feed_data(server)
        live._reader, live._writer = reader, _NullWriter()
        live._handshake_done = True
        return await live.fetch_session_list(timeout=5)

    rows = asyncio.run(scenario())

    assert [(r["filename"], r["hour"], r["lap_count"]) for r in rows] == [
        ("a_0001.xrk", "10:00:00", 3),
        ("a_0002.xrk", "11:00:00", 0),
    ]


def test_session_names_with_two_dots_survive():
    csv_text = aim_connector._extract_session_csv(
        b"name,size,date,hour,nlap,veicolo,device\r\nrun..final.xrk,10,01/09/2026,10:00:00,1,CT,EVO5\r\n"
    )

    rows = aim_connector.parse_aim_session_csv_rows(csv_text)

    assert [r["filename"] for r in rows] == ["run..final.xrk"]


# ─── Device port setting ─────────────────────────────────────────────────────


def test_primary_connection_uses_the_port_from_settings(monkeypatch):
    ports: list[int] = []

    class _Client:
        connected = True
        _handshake_done = True

        def __init__(self, host, port, trace=None):
            self.host, self.port = host, port
            ports.append(port)

        async def connect(self):
            pass

        async def close(self):
            pass

    monkeypatch.setattr(aim_primary_hub, "AimLiveClient", _Client)
    settings_store.update({"aim_device_port": 2001})

    async def scenario():
        hub = aim_primary_hub.AimPrimaryHub()
        first = await hub.ensure_primary("10.0.0.1")
        again = await hub.ensure_primary("10.0.0.1")
        settings_store.update({"aim_device_port": 2002})
        moved = await hub.ensure_primary("10.0.0.1")
        return first, again, moved

    first, again, moved = asyncio.run(scenario())

    assert again is first  # same host and port: the open link is reused
    assert moved is not first  # a new port means a new connection
    assert ports == [2001, 2002]


# ─── Data routes name their session ──────────────────────────────────────────


def _two_sessions(monkeypatch):
    logs = {
        "one.xrk": make_log({"RPM": ([0, 10], [1.0, 2.0], "rpm")}),
        "two.xrk": make_log({"Speed": ([0, 10], [7.0, 8.0], "km/h")}),
    }

    def parse(path, *_a, **_k):
        return logs[path.name if hasattr(path, "name") else str(path)]

    def parse_upload(path, *_a, **_k):
        # Uploads are parsed from a temp file: ".upload-<hex>-<name>".
        return logs[str(path).rsplit("-", 1)[-1]]

    monkeypatch.setattr("routes.analysis.parse_file", lambda p, *a, **k: (
        parse_upload(p) if ".upload-" in str(p) else parse(p)
    ))
    ids = {}
    for name in logs:
        res = client.post("/api/upload", files={"file": (name, b"bytes", "application/octet-stream")})
        assert res.status_code == 200, res.text
        ids[name] = res.json()["sessionId"]
    return ids


def test_data_routes_answer_for_the_named_session_not_the_last_loaded(monkeypatch):
    # Arrange: "two" was loaded last, as if by another window.
    ids = _two_sessions(monkeypatch)

    # Act
    named = client.get("/api/data", params={"channels": "RPM,Speed", "session_id": ids["one.xrk"]})
    unnamed = client.get("/api/data", params={"channels": "RPM,Speed"})
    channels = client.get("/api/channels", params={"session_id": ids["one.xrk"]})

    # Assert
    assert list(named.json()) == ["RPM"]
    assert list(unnamed.json()) == ["Speed"]  # no id: the active session, as before
    assert [c["name"] for c in channels.json()["channels"]] == ["RPM"]


def test_named_session_is_reparsed_when_it_left_the_cache(monkeypatch):
    ids = _two_sessions(monkeypatch)
    session_cache.evict(ids["one.xrk"])

    res = client.get("/api/laps", params={"session_id": ids["one.xrk"]})

    assert res.status_code == 200
    assert client.get("/api/data", params={"channels": "Speed"}).json() != {}  # "two" is still active


def test_data_route_with_an_unknown_session_id_is_a_404(monkeypatch):
    _two_sessions(monkeypatch)

    assert client.get("/api/gps", params={"session_id": "nope"}).status_code == 404


# ─── Upload registers a session once ─────────────────────────────────────────


def test_get_or_add_session_adds_once():
    first, created_first = session_store.get_or_add_session("Run.xrk", source="manual_upload", track_name="A")
    second, created_second = session_store.get_or_add_session("run.xrk", source="manual_upload", track_name="B")

    assert (created_first, created_second) == (True, False)
    assert second["id"] == first["id"]
    assert [s["track_name"] for s in session_store.list_sessions()] == ["A"]


def test_get_or_add_session_is_one_step_under_concurrency():
    barrier = threading.Barrier(8)
    ids: list[str] = []

    def add():
        barrier.wait()
        ids.append(session_store.get_or_add_session("same.xrk", source="manual_upload")[0]["id"])

    threads = [threading.Thread(target=add) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(set(ids)) == 1
    assert len(session_store.list_sessions()) == 1


# ─── Background indexing and the session cache ───────────────────────────────


def test_background_parses_do_not_push_out_opened_sessions():
    cache = SessionCache(max_entries=3)
    for sid in ("opened-1", "opened-2", "opened-3"):
        cache.put(sid, object(), f"{sid}.xrk")

    for n in range(5):
        cache.put(f"pulled-{n}", object(), f"pulled-{n}.xrk", background=True)

    # One opened session made room; after that each pull replaced the last.
    assert sorted(cache.keys()) == ["opened-2", "opened-3", "pulled-4"]


def test_indexing_a_session_deleted_meanwhile_caches_nothing(tmp_path, monkeypatch):
    path = tmp_path / "a_0001.xrz"
    path.write_bytes(b"x" * 500)
    monkeypatch.setattr(aim_pull_indexer, "parse_file", lambda *_a, **_k: make_log({"RPM": ([0], [1.0], "rpm")}))
    job = aim_pull_indexer.IndexJob(
        session_id="gone", filename="a_0001.xrz", path=path, device_ip="10.0.0.1", size=500, download_s=0.1,
    )

    assert aim_pull_indexer.index_one(job) is False

    assert session_cache.get("gone") is None


# ─── Live queue ──────────────────────────────────────────────────────────────


def test_full_live_queue_sheds_snapshots_before_status_frames():
    async def scenario():
        queue = live_route._LiveQueue(maxsize=3)
        queue.put_nowait({"type": "status", "state": "reconnecting"})
        queue.put_nowait({"type": "snapshot", "seq": 1})
        queue.put_nowait({"type": "snapshot", "seq": 2})
        queue.drop_oldest()
        queue.put_nowait({"type": "status", "state": "live"})
        return [queue.get_nowait() for _ in range(queue.qsize())]

    items = asyncio.run(scenario())

    assert items == [
        {"type": "status", "state": "reconnecting"},
        {"type": "snapshot", "seq": 2},
        {"type": "status", "state": "live"},
    ]


# ─── Parser output muting ────────────────────────────────────────────────────


def test_muting_the_parser_does_not_swallow_other_threads_output(monkeypatch):
    from parsers import _suppress_libxrk_noise

    captured = io.StringIO()
    monkeypatch.setattr(sys, "stdout", captured)

    def other_thread():
        print("from another thread")

    with _suppress_libxrk_noise():
        print("libxrk chatter")
        t = threading.Thread(target=other_thread)
        t.start()
        t.join()

    assert captured.getvalue() == "from another thread\n"
    assert sys.stdout is captured


# ─── Pulls queue instead of sharing progress ─────────────────────────────────


def test_pull_lock_is_shared_within_a_loop_and_separate_across_loops():
    async def pair():
        return sessions_route._pull_lock(), sessions_route._pull_lock()

    a1, a2 = asyncio.run(pair())
    b1, _ = asyncio.run(pair())

    assert a1 is a2
    assert b1 is not a1


# ─── Health route ────────────────────────────────────────────────────────────


def test_health_route_identifies_the_backend():
    res = client.get("/api/health")

    assert res.status_code == 200
    assert res.json() == {"app": "quickscope"}
