"""aim_connector helpers: socket setup, discovery, session CSV, download framing.

Sockets are faked; nothing touches the network.
"""

from __future__ import annotations

import socket
import struct

import pytest

from services import aim_connector, aim_device_cache, settings_store
from services.aim_connector import (
    _ACK,
    _HANDSHAKE,
    _build_download_request,
    _extract_session_csv,
    _is_stcp_file_payload,
    _open_device_socket,
    _parse_discovery_reply,
    _send_and_await_frame,
    _send_and_recv,
    discover_device,
    download_aim_session,
    parse_aim_session_csv_rows,
)
from services.aim_live import decode_frame, encode_frame


@pytest.fixture(autouse=True)
def _no_cached_device(monkeypatch):
    monkeypatch.setattr(aim_device_cache, "_cached", None)


class ScriptedSocket:
    """recv() returns scripted chunks; an exception instance in the script is raised."""

    def __init__(self, chunks=()):
        self.chunks = list(chunks)
        self.sent: list[bytes] = []
        self.timeouts: list[float] = []
        self.closed = False
        self.shutdown_called = False

    def sendall(self, data):
        self.sent.append(data)

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def recv(self, _size):
        if not self.chunks:
            raise socket.timeout()
        item = self.chunks.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    def shutdown(self, _how):
        self.shutdown_called = True

    def close(self):
        self.closed = True


# ── settings / discovery ───────────────────────────────────────────────────


def test_data_port_comes_from_settings():
    assert aim_connector._get_data_port() == 2000
    settings_store.update({"aim_device_port": 2001})
    assert aim_connector._get_data_port() == 2001


def test_parse_discovery_reply_keeps_known_fields():
    info = _parse_discovery_reply("10.0.0.1", b"AiM-EVO5-00740-CT16\x00")

    assert info == {
        "ip": "10.0.0.1",
        "ssid": "AiM-EVO5-00740-CT16",
        "device_name": "",
        "model": "EVO5",
        "serial": "00740",
        "vehicle": "CT16",
    }


def test_discover_device_returns_info_and_records_cache(monkeypatch):
    monkeypatch.setattr(
        aim_connector, "probe_device_ips", lambda: ("10.0.0.3", b"AiM-EVO5-00740-CT16\x00")
    )

    info = discover_device()

    assert info is not None and info["ip"] == "10.0.0.3"
    cached = aim_device_cache.get_cached()
    assert cached is not None
    assert (cached.ip, cached.model, cached.serial) == ("10.0.0.3", "EVO5", "00740")


def test_discover_device_returns_none_when_no_reply(monkeypatch):
    monkeypatch.setattr(aim_connector, "probe_device_ips", lambda: None)

    assert discover_device() is None
    assert aim_device_cache.get_cached() is None


# ── _open_device_socket ────────────────────────────────────────────────────


class ConnectSocket:
    instances: list["ConnectSocket"] = []
    reachable: set[str] = set()

    def __init__(self, *_args):
        self.closed = False
        self.connected_to = None
        self.timeout = None
        ConnectSocket.instances.append(self)

    def setsockopt(self, *_args):
        pass

    def settimeout(self, timeout):
        self.timeout = timeout

    def connect(self, addr):
        if addr[0] not in ConnectSocket.reachable:
            raise ConnectionRefusedError(f"refused {addr[0]}")
        self.connected_to = addr

    def close(self):
        self.closed = True


@pytest.fixture
def connect_socket(monkeypatch):
    ConnectSocket.instances = []
    ConnectSocket.reachable = set()
    monkeypatch.setattr(aim_connector.socket, "socket", ConnectSocket)
    return ConnectSocket


def test_open_device_socket_uses_fresh_socket_per_candidate(connect_socket):
    connect_socket.reachable = {"192.168.137.1"}

    sock, ip = _open_device_socket(timeout=3)

    assert ip == "192.168.137.1"
    assert sock.connected_to == ("192.168.137.1", 2000)
    assert sock.timeout == 3
    # 10.0.0.1 tried first on its own socket, which was closed after failing
    assert len(connect_socket.instances) == 2
    assert connect_socket.instances[0].closed
    assert not sock.closed
    assert aim_device_cache.get_cached().ip == "192.168.137.1"


def test_open_device_socket_raises_last_error_when_all_fail(connect_socket):
    with pytest.raises(ConnectionRefusedError, match="192.168.4.1"):
        _open_device_socket()

    assert all(s.closed for s in connect_socket.instances)


# ── _send_and_recv / _send_and_await_frame ─────────────────────────────────


def test_send_and_recv_collects_continuation_until_idle():
    sock = ScriptedSocket([b"abc", b"def", socket.timeout()])

    assert _send_and_recv(sock, b"MSG", "label", read_timeout=1.5) == b"abcdef"
    assert sock.sent == [b"MSG"]
    assert sock.timeouts == [1.5, 0.5]


def test_send_and_recv_stops_on_peer_close():
    sock = ScriptedSocket([b"abc", b""])

    assert _send_and_recv(sock, b"MSG", "label") == b"abc"


def test_send_and_recv_returns_empty_on_timeout():
    sock = ScriptedSocket([socket.timeout()])

    assert _send_and_recv(sock, b"MSG", "label") == b""


def test_send_and_await_frame_returns_once_frame_complete():
    frame = encode_frame(b"STCP", b"\x01\x02\x03\x04")
    sock = ScriptedSocket([frame[:5], frame[5:], b"never read"])

    assert _send_and_await_frame(sock, b"HELLO", "handshake", timeout=2) == frame
    assert sock.chunks == [b"never read"]


def test_send_and_await_frame_stops_on_invalid_bytes():
    sock = ScriptedSocket([b"\xff" * 20, b"never read"])

    assert _send_and_await_frame(sock, b"HELLO", "handshake") == b"\xff" * 20


def test_send_and_await_frame_returns_partial_on_timeout():
    sock = ScriptedSocket([b"<hST", socket.timeout()])

    assert _send_and_await_frame(sock, b"HELLO", "handshake") == b"<hST"


def test_send_and_await_frame_stops_on_peer_close():
    sock = ScriptedSocket([b""])

    assert _send_and_await_frame(sock, b"HELLO", "handshake") == b""


# ── session list CSV ───────────────────────────────────────────────────────


def test_extract_session_csv_finds_header_and_stops_at_next_frame():
    raw = (
        b"<hSTNC....>junk"
        b"name,size,date,hour,nlap,veicolo,device\r\n"
        b"a_0001.xrk,1000,19/10/2026,10:00:00,3,CT16,EVO5\r\n"
        b"a_0002.xrk,2000,19/10/2026,11:00:00,0,CT16,EVO5"
        b"<STCP\x01\x02>"
    )

    csv_text = _extract_session_csv(raw)

    assert csv_text is not None
    assert csv_text.splitlines() == [
        "name,size,date,hour,nlap,veicolo,device",
        "a_0001.xrk,1000,19/10/2026,10:00:00,3,CT16,EVO5",
        "a_0002.xrk,2000,19/10/2026,11:00:00,0,CT16,EVO5",
    ]


def test_extract_session_csv_returns_none_without_header():
    assert _extract_session_csv(b"<hSTNC no csv here>") is None


def test_parse_session_csv_rows_maps_fields_and_skips_bad_rows():
    csv_text = (
        "name,size,date,hour,nlap,veicolo,device\n"
        "a_0001.xrk,1000,19/10/2026,10:00:00,3,CT16,EVO5\n"
        ",5,,,,,\n"  # no name → skipped
        "a_0002.xrk,notanumber,19/10/2026,11:00:00,1,CT16,EVO5\n"  # bad size → skipped
        "a_0003.xrk,,19/10/2026,12:00:00,,CT16,EVO5\n"  # blanks → 0
    )

    rows = parse_aim_session_csv_rows(csv_text)

    assert rows == [
        {
            "filename": "a_0001.xrk",
            "size": 1000,
            "date": "19/10/2026",
            "hour": "10:00:00",
            "lap_count": 3,
            "vehicle": "CT16",
            "device_name": "EVO5",
        },
        {
            "filename": "a_0003.xrk",
            "size": 0,
            "date": "19/10/2026",
            "hour": "12:00:00",
            "lap_count": 0,
            "vehicle": "CT16",
            "device_name": "EVO5",
        },
    ]


# ── download framing ───────────────────────────────────────────────────────


def test_build_download_request_is_valid_stnc_frame_with_path():
    request = _build_download_request("1:/mem/a_0242.xrz")

    frame, consumed = decode_frame(request)
    assert consumed == len(request)
    assert frame is not None and frame.cmd == b"STNC"
    assert len(frame.payload) == 64
    assert frame.payload[8] == 0x02
    assert frame.payload[10] == 0x04
    assert frame.payload[0x18] == ord("A")
    assert frame.payload[0x20:0x40].rstrip(b"\x00") == b"1:/mem/a_0242.xrz"


def test_build_download_request_truncates_long_paths_to_32_bytes():
    frame, _ = decode_frame(_build_download_request("1:/mem/" + "x" * 64))

    assert frame.payload[0x20:0x40] == (b"1:/mem/" + b"x" * 64)[:32]


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (b"\x00\x00\x00\x00", False),  # micro ACK
        (b"\x00\x00\x00\x00\x01", True),  # offset + 1 data byte
        (b"\x00" * 24 + b"Q" + b"\x00" * 39, False),  # 64-byte Q control frame
        (b"\x00" * 24 + b"A" + b"\x00" * 39, False),  # 64-byte handshake frame
        (b"\x00" * 24 + b"Z" + b"\x00" * 39, True),  # 64 bytes, unknown opcode → data
        (b"\x00\x00\x00\x00\x01\x00\x00\x00" + b"\x00" * 16 + b"Q" + b"\x00" * 39, True),
    ],
)
def test_is_stcp_file_payload(payload, expected):
    assert _is_stcp_file_payload(payload) is expected


# ── download_aim_session orchestration ─────────────────────────────────────


def test_download_skips_existing_complete_file(tmp_path, monkeypatch):
    existing = tmp_path / "a.xrz"
    existing.write_bytes(b"x" * 100)
    monkeypatch.setattr(
        aim_connector, "_open_device_socket", lambda **_k: pytest.fail("should not connect")
    )
    progress: list[tuple[int, int]] = []

    out = download_aim_session("a.xrz", tmp_path, 100, lambda r, t: progress.append((r, t)))

    assert out == existing
    assert progress == [(100, 100)]


def test_download_skip_without_expected_size_reports_local_size(tmp_path, monkeypatch):
    (tmp_path / "a.xrz").write_bytes(b"x" * 42)
    monkeypatch.setattr(
        aim_connector, "_open_device_socket", lambda **_k: pytest.fail("should not connect")
    )
    progress: list[tuple[int, int]] = []

    download_aim_session("a.xrz", tmp_path, 0, lambda r, t: progress.append((r, t)))

    assert progress == [(42, 42)]


def _info_responses(total_size: int) -> bytes:
    info = bytearray(168)
    struct.pack_into("<I", info, 84 + 12 + 0x10, total_size)
    return bytes(info)


def test_download_runs_handshake_request_ack_and_writes_file(tmp_path, monkeypatch):
    handshake_reply = encode_frame(b"STCP", b"\x00" * 8)
    sock = ScriptedSocket([handshake_reply, _info_responses(5)])
    monkeypatch.setattr(aim_connector, "_open_device_socket", lambda **_k: (sock, "10.0.0.1"))
    received_sizes: list[int] = []

    def fake_receive(s, total, trace, on_progress=None):
        received_sizes.append(total)
        return b"hello"

    monkeypatch.setattr(aim_connector, "_receive_file_data", fake_receive)

    out = download_aim_session("a.xrz", tmp_path / "dest", 0)

    assert out == tmp_path / "dest" / "a.xrz"
    assert out.read_bytes() == b"hello"
    assert received_sizes == [5]
    assert sock.sent[0] == _HANDSHAKE
    assert decode_frame(sock.sent[1])[0].cmd == b"STNC"
    assert sock.sent[2] == _ACK
    assert sock.shutdown_called and sock.closed
    assert list((tmp_path / "dest").glob("*.tmp")) == []


def test_download_replaces_incomplete_local_file(tmp_path, monkeypatch):
    (tmp_path / "a.xrz").write_bytes(b"x" * 3)
    sock = ScriptedSocket([encode_frame(b"STCP", b"\x00" * 8)])  # no info frames
    monkeypatch.setattr(aim_connector, "_open_device_socket", lambda **_k: (sock, "10.0.0.1"))
    received_sizes: list[int] = []

    def fake_receive(s, total, trace, on_progress=None):
        received_sizes.append(total)
        return b"0123456789"

    monkeypatch.setattr(aim_connector, "_receive_file_data", fake_receive)

    out = download_aim_session("a.xrz", tmp_path, 10)

    # Short info reply → falls back to the session-list size
    assert received_sizes == [10]
    assert out.read_bytes() == b"0123456789"


def test_download_error_closes_socket_and_leaves_no_file(tmp_path, monkeypatch):
    sock = ScriptedSocket([encode_frame(b"STCP", b"\x00" * 8), _info_responses(5)])
    monkeypatch.setattr(aim_connector, "_open_device_socket", lambda **_k: (sock, "10.0.0.1"))

    def boom(*_a, **_k):
        raise RuntimeError("stalled")

    monkeypatch.setattr(aim_connector, "_receive_file_data", boom)

    with pytest.raises(RuntimeError, match="stalled"):
        download_aim_session("a.xrz", tmp_path, 0)

    assert sock.closed
    assert not (tmp_path / "a.xrz").exists()
