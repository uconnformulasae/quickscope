"""Log download on the primary TCP, as Race Studio does it (RS3_PULL_241/242).

The server side is replayed through a real ``asyncio.StreamReader``; the
client's writes are recorded so ACK values can be compared with the capture.
"""

from __future__ import annotations

import asyncio
import hashlib
import struct
import time
from pathlib import Path

import pytest

from services.aim_connector import (
    AimFileReceiver,
    BufferedSink,
    build_download_request,
    file_size_from_info_payload,
)
from services.aim_live import (
    STNC_GET_SESSIONS,
    AimLiveClient,
    _STNC_FILE_REQUEST,
    decode_frame,
    encode_frame,
)
from services.aim_primary_hub import AimLiveActiveError, AimPrimaryHub
from test_aim_download import _COMPLETE_PULLS, _iter_frames, _load_pcap_server_stream

_BATCH = 982_320


class _RecordingWriter:
    def __init__(self) -> None:
        self.frames: list[bytes] = []

    def write(self, data: bytes) -> None:
        offset = 0
        while offset < len(data):
            frame, consumed = decode_frame(data, offset)
            assert frame is not None, "client wrote a partial frame"
            self.frames.append(data[offset : offset + consumed])
            offset += consumed

    async def drain(self) -> None:
        return None

    def is_closing(self) -> bool:
        return False

    def close(self) -> None:
        return None

    async def wait_closed(self) -> None:
        return None

    def stcp4_values(self) -> list[int]:
        values = []
        for raw in self.frames:
            frame, _ = decode_frame(raw)
            if frame.cmd == b"STCP" and len(frame.payload) == 4:
                values.append(struct.unpack("<I", frame.payload)[0])
        return values


def _run_on_primary(server_bytes: bytes, action, *, eof: bool = True):  # noqa: ANN001
    """Run ``await action(client)`` against a primary fed ``server_bytes``."""

    async def scenario():
        client, writer = _primary_client(server_bytes, eof=eof)
        return await action(client), writer

    return asyncio.run(scenario())


def _primary_client(server_bytes: bytes, *, eof: bool = True) -> tuple[AimLiveClient, _RecordingWriter]:
    """Must be called inside a running loop (``StreamReader`` binds to it)."""
    client = AimLiveClient(host="10.0.0.1")
    reader = asyncio.StreamReader(limit=1 << 24)
    reader.feed_data(server_bytes)
    if eof:
        reader.feed_eof()
    writer = _RecordingWriter()
    client._reader, client._writer = reader, writer
    client._handshake_done = True
    return client, writer


def _control(sub_cmd: int, op: str, size: int = 0) -> bytes:
    payload = bytearray(64)
    payload[8:12] = struct.pack("<I", sub_cmd)
    payload[16:20] = struct.pack("<I", size)
    payload[24] = ord(op)
    return encode_frame(b"STCP", bytes(payload))


def _block(offset: int, data: bytes) -> bytes:
    return encode_frame(b"STCP", struct.pack("<I", offset) + data)


def _file_reply(data: bytes, block: int = 300) -> bytes:
    return (
        _control(_STNC_FILE_REQUEST, "I")
        + _control(_STNC_FILE_REQUEST, "Q", len(data))
        + b"".join(_block(off, data[off : off + block]) for off in range(0, len(data), block))
    )


def _file_request_reply_onward(server_stream: bytes) -> bytes:
    """Server bytes from the device's ``I`` reply to the file request on."""
    for offset, frame in _iter_frames(server_stream):
        pl = frame.payload
        if (
            frame.cmd == b"STCP"
            and len(pl) == 64
            and struct.unpack_from("<I", pl, 8)[0] == _STNC_FILE_REQUEST
        ):
            return server_stream[offset:]
    raise AssertionError("no file request reply in capture")


def test_build_download_request_matches_rs3_file_request_stnc():
    frame, _ = decode_frame(build_download_request("a_0241.xrz"))

    assert frame.cmd == b"STNC"
    assert struct.unpack_from("<I", frame.payload, 8)[0] == _STNC_FILE_REQUEST
    assert frame.payload[0x20:0x40].rstrip(b"\x00") == b"1:/mem/a_0241.xrz"


def test_file_size_from_info_payload_reads_q_size():
    payload = decode_frame(_control(_STNC_FILE_REQUEST, "Q", 3_149_824))[0].payload

    assert file_size_from_info_payload(payload) == 3_149_824
    assert file_size_from_info_payload(b"short") == 0


def test_file_receiver_with_buffered_sink_queues_batch_ack_and_keeps_trailing_bytes(monkeypatch):
    # Arrange: scaled-down batch so a 1,200 B file needs one boundary ack.
    monkeypatch.setattr("services.aim_connector._BATCH_PAYLOAD_BYTES", 600)
    data = bytes(range(200)) * 6
    trailing = _control(STNC_GET_SESSIONS, "I")
    sink = BufferedSink()
    receiver = AimFileReceiver(len(data), sink)

    blocks = [_block(off, data[off : off + 100]) for off in range(0, 1200, 100)]

    # Act
    receiver.feed(b"".join(blocks[:6]))
    first_ack = sink.take()
    receiver.feed(b"".join(blocks[6:]) + trailing)

    # Assert
    ack, _ = decode_frame(first_ack)
    assert struct.unpack("<I", ack.payload)[0] == 600
    assert sink.take() == b""  # no ack owed for the final batch
    assert receiver.is_complete
    assert receiver.result() == data
    assert receiver.frame_buffer == trailing


@pytest.mark.parametrize("capture,expected_size,sha1_prefix", _COMPLETE_PULLS[:1] + _COMPLETE_PULLS[2:])
def test_download_file_replays_rs3_pull_on_primary_tcp(tmp_path, capture, expected_size, sha1_prefix):
    # Arrange
    server = _file_request_reply_onward(_load_pcap_server_stream(capture))
    filename = "a_0241.xrz" if "241" in capture else "a_0242.xrz"

    # Act
    path, writer = _run_on_primary(
        server, lambda client: client.download_file(filename, tmp_path, expected_size)
    )

    # Assert: same file RS3 saved, and the same client frames RS3 sent.
    data = path.read_bytes()
    assert len(data) == expected_size
    assert hashlib.sha1(data).hexdigest().startswith(sha1_prefix)
    request, _ = decode_frame(writer.frames[0])
    assert struct.unpack_from("<I", request.payload, 8)[0] == _STNC_FILE_REQUEST
    assert writer.stcp4_values() == [0, *range(_BATCH, expected_size, _BATCH)]


def test_download_file_twice_on_one_stream_keeps_files_separate(tmp_path):
    # Arrange: two files back to back on the same socket.
    first, second = b"A" * 1000, b"B" * 700

    async def both(client):
        one = await client.download_file("a_0001.xrz", tmp_path)
        two = await client.download_file("a_0002.xrz", tmp_path)
        return one, two

    # Act
    (one, two), _writer = _run_on_primary(_file_reply(first) + _file_reply(second), both)

    # Assert
    assert one.read_bytes() == first
    assert two.read_bytes() == second


def test_download_file_raises_when_device_rejects_the_request(tmp_path):
    with pytest.raises(RuntimeError, match="rejected"):
        _run_on_primary(
            _control(_STNC_FILE_REQUEST, "E"),
            lambda client: client.download_file("missing.xrz", tmp_path),
        )
    assert not (tmp_path / "missing.xrz").exists()


def test_download_file_reuses_complete_local_file_without_touching_the_socket(tmp_path):
    (tmp_path / "a_0001.xrz").write_bytes(b"x" * 500)
    path, writer = _run_on_primary(
        b"", lambda client: client.download_file("a_0001.xrz", tmp_path, 500)
    )

    assert path.read_bytes() == b"x" * 500
    assert writer.frames == []


def test_session_list_finishes_as_soon_as_announced_csv_length_arrives():
    # Arrange: socket stays open (no EOF) -- the old code waited out a 2 s idle.
    csv = b"name,size,date,hour,\na_0241.xrz,3149824,01/09/2026,14:30:00,\n"
    server = _control(STNC_GET_SESSIONS, "I") + _control(STNC_GET_SESSIONS, "Q", len(csv)) + _block(0, csv)
    # Act
    started = time.monotonic()
    rows, _writer = _run_on_primary(
        server, lambda client: client.fetch_session_list(timeout=15), eof=False
    )

    # Assert
    assert time.monotonic() - started < 1.0
    assert [r["filename"] for r in rows] == ["a_0241.xrz"]


class _FakePrimary:
    def __init__(self, *, fail_on: str | None = None) -> None:
        self.calls: list[str] = []
        self.fail_on = fail_on
        self.connected = True
        self._handshake_done = True
        self.host = "10.0.0.1"

    async def fetch_session_list(self) -> list[dict]:
        self.calls.append("list")
        return [{"filename": "a_0241.xrz", "size": 3}, {"filename": "a_0242.xrz", "size": 3}]

    async def download_file(self, filename, dest_dir: Path, expected_size=0, on_progress=None):
        self.calls.append(f"download:{filename}:{expected_size}")
        if filename == self.fail_on:
            raise ConnectionError("AiM device closed the connection")
        path = dest_dir / filename
        path.write_bytes(b"abc")
        return path

    async def close(self) -> None:
        self.calls.append("close")


def _hub_with(client: _FakePrimary) -> AimPrimaryHub:
    hub = AimPrimaryHub()

    async def _ensure(host=None, **_k):  # noqa: ANN001
        hub._client = client
        return client

    hub.ensure_primary = _ensure
    return hub


def test_hub_pull_reuses_listed_sessions_and_relists_after_each_file(tmp_path):
    client = _FakePrimary()
    hub = _hub_with(client)
    done: list[str] = []

    async def scenario():
        await hub.list_sessions()
        return await hub.download_sessions(
            ["a_0241.xrz", "a_0242.xrz"],
            lambda _name: tmp_path,
            on_file_done=lambda name, path, secs, meta: done.append(name),
        )

    result = asyncio.run(scenario())

    assert client.calls == [
        "list",  # picker list; the pull goes straight to the file request
        "download:a_0241.xrz:3",
        "list",
        "download:a_0242.xrz:3",
        "list",
    ]
    assert done == result.downloaded == ["a_0241.xrz", "a_0242.xrz"]
    assert result.remaining == [] and result.error is None
    assert not hub._lock.locked()


def test_hub_pull_closes_primary_and_reports_remaining_on_failure(tmp_path):
    client = _FakePrimary(fail_on="a_0242.xrz")
    hub = _hub_with(client)

    result = asyncio.run(hub.download_sessions(["a_0241.xrz", "a_0242.xrz"], lambda _n: tmp_path))

    assert result.downloaded == ["a_0241.xrz"]
    assert result.remaining == ["a_0242.xrz"]
    assert isinstance(result.error, ConnectionError)
    assert client.calls[-1] == "close"
    assert hub._client is None


def test_hub_pull_refuses_while_live_view_is_active(tmp_path):
    hub = _hub_with(_FakePrimary())
    hub._live_active = True

    with pytest.raises(AimLiveActiveError):
        asyncio.run(hub.download_sessions(["a_0241.xrz"], lambda _n: tmp_path))
