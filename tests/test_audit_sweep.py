"""Regression tests for the 2026-11 audit sweep.

Each test pins one finding from the audit: a path that had no coverage and
either lost data, returned a wrong answer, or let another site drive the app.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from conftest import circuit_samples, make_log
from main import app
from services import lap_detection, session_store
from services.session_cache import session_cache
from state import state

client = TestClient(app)


def _upload(c, name="run1.xrk", content=b"bytes"):
    return c.post("/api/upload", files={"file": (name, content, "application/octet-stream")})


# ─── Host / Origin enforcement ───────────────────────────────────────────────


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8000", "192.168.1.50:8000", ""])
def test_http_rejects_a_foreign_host(host):
    """DNS rebinding reaches the backend under the attacker's hostname."""
    res = client.get("/api/sessions", headers={"Host": host})
    assert res.status_code == 403


@pytest.mark.parametrize("host", ["localhost:8000", "127.0.0.1:8000", "127.0.0.1", "[::1]:8000"])
def test_http_accepts_this_machine(host):
    assert client.get("/api/sessions", headers={"Host": host}).status_code == 200


@pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://localhost.evil.example"])
def test_cross_site_upload_is_rejected_before_it_touches_disk(origin, isolated_data_dir):
    """A multipart POST is a "simple" request: CORS never preflights it."""
    res = client.post(
        "/api/upload",
        files={"file": ("run1.xrk", b"bytes", "application/octet-stream")},
        headers={"Origin": origin},
    )
    assert res.status_code == 403
    assert list((isolated_data_dir / "sessions").iterdir()) == []


@pytest.mark.parametrize("origin", ["app://quickscope", "http://localhost:5173", "http://127.0.0.1:8000"])
def test_requests_from_the_ui_origins_pass(origin):
    assert client.get("/api/sessions", headers={"Origin": origin}).status_code == 200


def test_allowed_hosts_env_opts_other_machines_in(monkeypatch):
    lan = {"Host": "192.168.1.50:8000", "Origin": "http://192.168.1.50:5173"}
    assert client.get("/api/sessions", headers=lan).status_code == 403
    monkeypatch.setenv("QUICKSCOPE_ALLOWED_HOSTS", "testserver, 192.168.1.50")
    assert client.get("/api/sessions", headers=lan).status_code == 200


def test_live_ws_rejects_a_foreign_host():
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/api/live/ws", headers={"host": "evil.example"}):
            pass
    assert exc.value.code == 1008


# ─── Filename collisions ─────────────────────────────────────────────────────


def test_case_variant_upload_replaces_the_same_session(client_with_synthetic_log, isolated_data_dir):
    """Windows and default macOS volumes treat A.xrk and a.xrk as one file."""
    first = _upload(client_with_synthetic_log, "run1.xrk", b"one").json()
    second = _upload(client_with_synthetic_log, "RUN1.XRK", b"two").json()

    assert second["sessionId"] == first["sessionId"]
    sessions = client_with_synthetic_log.get("/api/sessions").json()
    assert [s["filename"] for s in sessions] == ["run1.xrk"]
    files = sorted(p.name for p in (isolated_data_dir / "sessions").iterdir())
    assert files == ["run1.xrk"]
    assert (isolated_data_dir / "sessions" / "run1.xrk").read_bytes() == b"two"


def test_rename_to_a_case_variant_of_another_session_conflicts(client_with_synthetic_log):
    _upload(client_with_synthetic_log, "a.xrk")
    b = _upload(client_with_synthetic_log, "b.xrk").json()

    res = client_with_synthetic_log.post(
        f"/api/sessions/{b['sessionId']}/rename", json={"filename": "A.xrk"},
    )
    assert res.status_code == 409


def test_rename_never_overwrites_a_file_the_index_does_not_know(
    client_with_synthetic_log, isolated_data_dir,
):
    sid = _upload(client_with_synthetic_log, "a.xrk").json()["sessionId"]
    stray = isolated_data_dir / "sessions" / "stray.xrk"
    stray.write_bytes(b"someone's data")

    res = client_with_synthetic_log.post(f"/api/sessions/{sid}/rename", json={"filename": "stray.xrk"})

    assert res.status_code == 409
    assert stray.read_bytes() == b"someone's data"
    assert session_store.get_session(sid)["filename"] == "a.xrk"


def test_failed_rename_leaves_file_and_index_in_step(
    client_with_synthetic_log, isolated_data_dir, monkeypatch,
):
    sid = _upload(client_with_synthetic_log, "a.xrk").json()["sessionId"]

    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(session_store, "save_json", boom)
    res = client_with_synthetic_log.post(f"/api/sessions/{sid}/rename", json={"filename": "b.xrk"})

    assert res.status_code == 500
    assert (isolated_data_dir / "sessions" / "a.xrk").exists()
    assert not (isolated_data_dir / "sessions" / "b.xrk").exists()
    assert state.filename == "a.xrk"


# ─── Active session vs. the LRU cache ────────────────────────────────────────


def test_active_session_survives_other_sessions_filling_the_cache(client_with_synthetic_log):
    """Exporting or pulling other sessions used to unload the one on screen."""
    active = _upload(client_with_synthetic_log, "active.xrk").json()["sessionId"]
    for i in range(6):
        session_cache.put(f"other-{i}", object(), f"other-{i}.xrk")

    assert state.session_id == active
    res = client_with_synthetic_log.get("/api/data", params={"channels": "RPM"})
    assert res.status_code == 200 and len(res.json()["RPM"]["values"]) == 9001


# ─── GPS time base ───────────────────────────────────────────────────────────

_GPS_START_MS = 20_000


def _late_gps_log():
    """GPS gets its first fix 20 s into the session; no device lap markers."""
    ts, lat, lon = circuit_samples(3, 30, 10)
    ts = [t + _GPS_START_MS for t in ts]
    rpm_ts = list(range(0, 120_001, 100))
    return make_log({
        "RPM": (rpm_ts, [3000.0] * len(rpm_ts), "rpm"),
        "GPS Latitude": (ts, lat, "deg"),
        "GPS Longitude": (ts, lon, "deg"),
        "GPS Speed": (ts, [15.0] * len(ts), "m/s"),
    })


def test_gps_laps_stay_on_session_time_when_gps_starts_late():
    log = _late_gps_log()

    def channel(name):
        from state import channel_data
        return channel_data(name, log.channels[name])

    laps, source = lap_detection.detect_laps(log, channel)

    assert source == "gps_auto" and len(laps) >= 2
    # Laps are ~30 s apart starting from the first fix, on the session clock.
    assert laps[0]["startTime"] >= _GPS_START_MS
    assert laps[0]["endTime"] - laps[0]["startTime"] == pytest.approx(30_000, abs=1_500)


def test_gps_trail_uses_session_time(monkeypatch):
    log = _late_gps_log()
    state.activate("s1", log, "late.xrk")

    gps = client.get("/api/gps").json()["gps"]

    assert gps["timestamps"][0] == _GPS_START_MS
    assert len(gps["timestamps"]) == len(gps["lat"]) == len(gps["lon"]) == len(gps["speed"])
    assert gps["speed"][0] == 15.0 and gps["speedUnits"] == "m/s"


# ─── Downloads with non-ASCII names ──────────────────────────────────────────


def test_non_ascii_session_name_exports_instead_of_500(client_with_synthetic_log):
    sid = _upload(client_with_synthetic_log, "run1.xrk").json()["sessionId"]
    session_store.update_session(sid, aim_session_id="Zürich_été")

    res = client_with_synthetic_log.get(f"/api/sessions/{sid}/export", params={"channels": "RPM"})

    assert res.status_code == 200
    disposition = res.headers["content-disposition"]
    assert "filename*=UTF-8''Z%C3%BCrich_%C3%A9t%C3%A9_export.csv" in disposition
    assert 'filename="Z_rich__t__export.csv"' in disposition
    assert res.text.splitlines()[0] == "Time (s),RPM (rpm)"


# ─── AiM device ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (TimeoutError(), "did not answer in time"),
        (OSError("No route to host"), "Could not connect"),
        (RuntimeError("live handshake must complete before session list"), "Could not connect"),
    ],
)
def test_aim_list_failures_are_reported_not_500(monkeypatch, exc, expected):
    class _Hub:
        async def list_sessions(self, host=None):  # noqa: ANN001
            raise exc

    monkeypatch.setattr("routes.sessions.aim_connector.discover_device", lambda: None)
    monkeypatch.setattr("routes.sessions.get_aim_primary_hub", lambda: _Hub())

    res = client.get("/api/aim/sessions")

    assert res.status_code == 200
    assert res.json()["ok"] is False and expected in res.json()["error"]


def test_aim_list_while_live_says_live_is_active_not_check_wifi(monkeypatch):
    from services.aim_primary_hub import AimLiveActiveError

    class _Hub:
        async def list_sessions(self, host=None):  # noqa: ANN001
            raise AimLiveActiveError("Cannot list AiM sessions while live view is active.")

    monkeypatch.setattr("routes.sessions.aim_connector.discover_device", lambda: None)
    monkeypatch.setattr("routes.sessions.get_aim_primary_hub", lambda: _Hub())

    error = client.get("/api/aim/sessions").json()["error"]

    assert "live view is active" in error and "WiFi" not in error


def test_aim_list_skips_udp_discovery_when_the_device_is_already_known(monkeypatch):
    from services import aim_device_cache

    class _Hub:
        primary_connected = True

        async def list_sessions(self, host=None):  # noqa: ANN001
            self.host = host
            return []

    hub = _Hub()
    probes = []
    monkeypatch.setattr("routes.sessions.aim_connector.discover_device", lambda: probes.append(1))
    monkeypatch.setattr("routes.sessions.get_aim_primary_hub", lambda: hub)
    aim_device_cache.record_identity("10.0.0.7", model="EVO5")
    try:
        assert client.get("/api/aim/sessions").json()["ok"] is True
        assert client.get("/api/aim/status").json()["device"]["ip"] == "10.0.0.7"
    finally:
        aim_device_cache.clear_cache_for_tests()

    assert probes == [] and hub.host == "10.0.0.7"


def test_client_is_not_connected_once_the_device_closes_its_end():
    """``writer.is_closing()`` stays False after a peer close; the reader knows."""
    from services.aim_live import AimLiveClient

    class _Writer:
        def is_closing(self):
            return False

    async def scenario():
        c = AimLiveClient(host="10.0.0.1")
        c._reader, c._writer = asyncio.StreamReader(), _Writer()
        open_link = c.connected
        c._reader.feed_eof()
        return open_link, c.connected

    assert asyncio.run(scenario()) == (True, False)


def test_hub_drops_the_primary_after_a_failed_session_list():
    from services.aim_primary_hub import AimPrimaryHub

    class _Client:
        connected = True
        _handshake_done = True
        host = "10.0.0.1"
        closed = False

        async def fetch_session_list(self):
            raise ConnectionError("AiM device closed the connection")

        async def close(self):
            self.closed = True

    async def scenario():
        hub, dead = AimPrimaryHub(), _Client()
        hub._client = dead
        with pytest.raises(ConnectionError):
            await hub.list_sessions("10.0.0.1")
        return hub._client, dead.closed

    assert asyncio.run(scenario()) == (None, True)


def test_reassembler_ignores_a_block_far_beyond_the_file():
    """One corrupt offset near 4 GB used to allocate ~4 GB of padding."""
    from services.aim_connector import _IncrementalReassembler

    r = _IncrementalReassembler(total_size=1000)
    r.feed(0, b"a" * 500)
    r.feed(0xFFFF_0000, b"b" * 500)
    r.feed(500, b"c" * 500)

    assert r.rejected == 1
    assert len(r.file_data) == 1000 and r.is_complete(1000)


def test_keepalive_ignores_replies_from_other_hosts():
    from services.aim_device_cache import clear_cache_for_tests, get_cached
    from services.aim_keepalive import AimKeepalive

    reply = b"\xec\x00\x00\x00" + b"\x00" * 120 + b"AiM-EVO5-00740-UConn-EV" + b"\x00" * 97
    clear_cache_for_tests()
    keepalive = AimKeepalive("10.0.0.1")

    keepalive._on_reply(reply, "10.0.0.66")
    assert get_cached() is None and keepalive.reply_count == 0

    keepalive._on_reply(reply, "10.0.0.1")
    assert get_cached().ip == "10.0.0.1" and keepalive.reply_count == 1
    clear_cache_for_tests()


def test_snapshot_base64_is_only_built_on_demand():
    from services.aim_live import parse_live_snapshot

    payload = b"\x00" * 4 + b"Syst" + (1234).to_bytes(4, "little") + b"\x01" * 100
    snap = parse_live_snapshot(payload)

    assert snap.raw == payload and "raw_b64" not in vars(snap)
    import base64
    assert base64.b64decode(snap.raw_b64) == payload


# ─── Shared AiM framing ──────────────────────────────────────────────────────


def test_download_handshake_frames_match_the_race_studio_capture():
    """The download path builds its hello/ack from the live client's payloads;
    the device drops anything that isn't byte-for-byte what RS3 sends."""
    from services.aim_connector import _ACK, _HANDSHAKE

    assert _HANDSHAKE.hex() == "3c685354435008000000003e00000000060800003c535443500e003e"
    assert _ACK.hex() == "3c685354435004000000003e000000003c5354435000003e"


@pytest.mark.parametrize(
    "noise",
    [b"garbage", b"<x<y<", b"<h bad header....", b"\x00" * 30 + b"<", b"<<<<hh<"],
)
def test_resync_lands_where_dropping_one_byte_at_a_time_would(noise):
    """Every reader skips noise with the same helper; it must reach the same
    frame the old byte-by-byte loop reached."""
    from services.aim_live import decode_frame, encode_frame, resync_offset

    frame = encode_frame(b"STCP", b"\x01\x02\x03\x04")
    buf, pos = noise + frame + b"tail", 0
    for _ in range(len(buf)):
        try:
            decoded, consumed = decode_frame(buf, pos)
            break
        except ValueError:
            pos = resync_offset(buf, pos)
    assert decoded is not None and decoded.payload == b"\x01\x02\x03\x04"
    assert pos == len(noise) and consumed == len(frame)


def test_resync_keeps_a_possible_split_header_and_drops_plain_noise():
    from services.aim_live import resync_offset

    assert resync_offset(b"noise", 0) == 5          # nothing to keep
    assert resync_offset(b"noise<", 0) == 5         # "<" may be half of "<h"
    assert resync_offset(b"xx<hSTCP", 0) == 2       # next candidate frame


def test_one_rule_decides_which_host_to_dial(monkeypatch):
    from services import aim_device_cache
    from services.aim_discovery import resolve_device_host
    from services.aim_primary_hub import AimPrimaryHub

    assert resolve_device_host() == "10.0.0.1"                 # Settings default
    aim_device_cache.record_identity("10.0.0.7")
    assert resolve_device_host() == "10.0.0.7"                 # last seen wins
    assert resolve_device_host("192.168.4.1") == "192.168.4.1"  # explicit wins
    assert AimPrimaryHub().resolve_host(None) == "10.0.0.7"


def test_failed_download_trace_still_describes_the_stream_without_keeping_it(tmp_path):
    """The raw stream is no longer held in memory; the trace gets the same
    summary (size, frame mix, last bytes) from running counters."""
    import json

    from services.aim_connector import AimFileReceiver, BufferedSink
    from services.aim_download_trace import AimDownloadTrace
    from services.aim_live import encode_frame

    block = encode_frame(b"STCP", (0).to_bytes(4, "little") + b"d" * 300)
    trace = AimDownloadTrace("a_0001.xrz", 1000)
    receiver = AimFileReceiver(1000, BufferedSink(), trace)
    receiver.feed(block[:100])
    receiver.feed(block[100:])

    assert not hasattr(receiver, "_raw_data")
    with pytest.raises(RuntimeError, match="Incomplete download"):
        receiver.result()
    trace.close(status="error")
    events = [json.loads(line) for line in trace.path.read_text().splitlines()]
    summary = next(e for e in events if e["event"] == "stream_analysis")
    assert summary["raw_bytes"] == len(block)
    assert summary["frame_counts"] == {"STCP:304": 1}
    assert summary["tail_hex"] == block[-256:].hex()
