"""Tests for AiM download trace and stall-ack behavior."""

from __future__ import annotations

import itertools
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from services.aim_connector import (
    _BATCH_PAYLOAD_BYTES,
    _IncrementalReassembler,
    _STCP_MICRO_ACK,
    _STCP_Q_ACK_OPCODE,
    _STCP_Q_ACK_OPCODE_OFFSET,
    _drain_download_frames,
    _extract_data_blocks,
    _make_download_progress_ack,
    _process_download_frame,
    _prompt_next_batch,
    _receive_file_data,
    _try_extract_file_size,
)
from services.aim_download_trace import AimDownloadTrace
from services.aim_live import decode_frame, encode_frame


def _file_block(file_offset: int, data: bytes) -> bytes:
    payload = struct.pack("<I", file_offset) + data
    return encode_frame(b"STCP", payload)


def _ack_payload_bytes(frame_bytes: bytes) -> int:
    frame, _ = decode_frame(frame_bytes)
    assert frame is not None
    assert len(frame.payload) == 4
    return struct.unpack("<I", frame.payload)[0]


class _RecordingSocket:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.timeouts_before_data = 0
        self._recv_calls = 0

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def settimeout(self, _timeout: float) -> None:
        return None

    def recv(self, _size: int) -> bytes:
        self._recv_calls += 1
        if self._recv_calls == 1:
            header = b"<hSTCP" + (4 + 100).to_bytes(4, "little") + b"\x00>"
            payload = (0).to_bytes(4, "little") + (b"a" * 100)
            trailer = b"<STCP" + (sum(payload) & 0xFFFF).to_bytes(2, "little") + b">"
            return header + payload + trailer
        self.timeouts_before_data += 1
        raise TimeoutError("timed out")


def test_try_extract_file_size_returns_zero_without_blocks():
    assert _try_extract_file_size(b"not-a-protocol-stream") == 0


def test_extract_data_blocks_places_blocks_by_absolute_offset():
    raw = _file_block(100, b"b" * 50) + _file_block(0, b"a" * 100) + _file_block(150, b"c" * 30)

    result = _extract_data_blocks(raw)

    assert result == b"a" * 100 + b"b" * 50 + b"c" * 30


def test_extract_data_blocks_trims_to_expected_size():
    raw = _file_block(0, b"x" * 200)
    assert len(_extract_data_blocks(raw, expected_size=150)) == 150


def test_replayed_blocks_after_resume_do_not_shift_or_corrupt_the_file():
    """QS_Pull_242.pcapng: a mid-batch ACK made the device replay from an
    earlier offset. Replays must overwrite the same bytes, not append."""
    file = bytes(i % 251 for i in range(1000))
    blocks = [(off, file[off:off + 100]) for off in range(0, 1000, 100)]
    replay = blocks[:6] + blocks[3:8] + blocks[5:]  # restarts at 300, then 500
    reassembler = _IncrementalReassembler()
    for off, data in replay:
        reassembler.feed(off, data)

    assert len(reassembler) == 1000
    assert reassembler.covered == 1000
    assert bytes(reassembler.file_data) == file
    assert reassembler.conflicts == 0


def test_reassembler_tracks_gaps_and_contiguous_prefix():
    r = _IncrementalReassembler()
    r.feed(0, b"a" * 100)
    r.feed(200, b"c" * 100)
    assert len(r) == 100
    assert r.covered == 200
    assert not r.is_complete(300)
    r.feed(100, b"b" * 100)
    assert len(r) == 300
    assert r.is_complete(300)


def test_make_download_progress_ack_encodes_byte_count():
    ack = _make_download_progress_ack(982320)
    assert _ack_payload_bytes(ack) == 982320
    assert ack != _STCP_MICRO_ACK


def test_prompt_next_batch_sends_progress_ack_at_exact_batch_boundary():
    sock = _RecordingSocket()
    early_threshold = _BATCH_PAYLOAD_BYTES - 32_744
    acked, sent = _prompt_next_batch(
        sock,
        extracted_size=early_threshold,
        acked_through=0,
        trace=None,
    )
    assert sent == 0
    assert acked == 0
    assert sock.sent == []

    acked, sent = _prompt_next_batch(
        sock,
        extracted_size=_BATCH_PAYLOAD_BYTES,
        acked_through=0,
        trace=None,
    )
    assert sent == 1
    assert acked == _BATCH_PAYLOAD_BYTES
    assert len(sock.sent) == 1
    assert _ack_payload_bytes(sock.sent[0]) == _BATCH_PAYLOAD_BYTES

    acked2, sent2 = _prompt_next_batch(
        sock,
        extracted_size=_BATCH_PAYLOAD_BYTES,
        acked_through=acked,
        trace=None,
    )
    assert sent2 == 0
    assert acked2 == _BATCH_PAYLOAD_BYTES


def test_process_download_frame_sends_micro_ack_on_q_ack_frame_in_live_mode():
    sock = _RecordingSocket()
    q_payload = bytearray(64)
    q_payload[_STCP_Q_ACK_OPCODE_OFFSET] = _STCP_Q_ACK_OPCODE

    class _Frame:
        cmd = b"STCP"
        payload = bytes(q_payload)

    assert _process_download_frame(sock, _Frame(), reply_to_control=True) is True
    assert sock.sent == [_STCP_MICRO_ACK]


def test_process_download_frame_ignores_q_ack_during_download():
    sock = _RecordingSocket()
    q_payload = bytearray(64)
    q_payload[_STCP_Q_ACK_OPCODE_OFFSET] = _STCP_Q_ACK_OPCODE

    class _Frame:
        cmd = b"STCP"
        payload = bytes(q_payload)

    assert _process_download_frame(sock, _Frame(), reply_to_control=False) is False
    assert sock.sent == []


def test_drain_download_frames_replies_to_q_ack_in_live_mode():
    sock = _RecordingSocket()
    q_payload = bytearray(64)
    q_payload[_STCP_Q_ACK_OPCODE_OFFSET] = _STCP_Q_ACK_OPCODE
    q_frame = encode_frame(b"STCP", bytes(q_payload))

    remaining, acks = _drain_download_frames(sock, q_frame, reply_to_control=True)
    assert remaining == b""
    assert acks == 1


def test_drain_download_frames_ignores_q_ack_during_download():
    sock = _RecordingSocket()
    q_payload = bytearray(64)
    q_payload[_STCP_Q_ACK_OPCODE_OFFSET] = _STCP_Q_ACK_OPCODE
    q_frame = encode_frame(b"STCP", bytes(q_payload))

    remaining, acks = _drain_download_frames(sock, q_frame, reply_to_control=False)
    assert remaining == b""
    assert acks == 0
    assert sock.sent == []


def test_receive_file_data_short_pause_sends_no_mid_batch_ack(tmp_path, monkeypatch):
    """A pause shorter than _STALL_RESUME_S (normal after WiFi loss) must not
    ACK -- that is what corrupted QS_Pull_242."""
    monkeypatch.setattr("services.aim_download_trace._LOG_DIR", tmp_path / "logs")
    sock = _RecordingSocket()
    trace = AimDownloadTrace("test.xrz", 500)

    ticks = itertools.chain(
        (i * 0.05 for i in range(60)),  # 3s of silence: a normal TCP-recovery pause
        itertools.repeat(1000.0),  # then the idle limit trips
    )
    with patch("services.aim_connector.time.monotonic", side_effect=lambda: next(ticks)):
        with pytest.raises(RuntimeError):
            _receive_file_data(sock, 500, trace)

    assert sock.sent == []
    trace.close(status="test")


def test_receive_file_data_resume_ack_after_long_silence(tmp_path, monkeypatch):
    monkeypatch.setattr("services.aim_download_trace._LOG_DIR", tmp_path / "logs")
    sock = _RecordingSocket()
    trace = AimDownloadTrace("test.xrz", 500)

    ticks = itertools.count(0, 1.0)  # 1s per clock read: silence crosses 8s quickly
    with patch("services.aim_connector.time.monotonic", side_effect=lambda: next(ticks)):
        with pytest.raises(RuntimeError):
            _receive_file_data(sock, 500, trace)

    assert [_ack_payload_bytes(item) for item in sock.sent][:1] == [100]
    trace.close(status="test")


def test_receive_file_data_multi_batch_with_replay_yields_exact_file():
    """Batch-boundary ACKs, a mid-stream replay from an earlier offset, and
    exact-size completion (QS_Pull_242 shape, scaled down by patching the
    batch size)."""
    file = bytes((i * 7) % 253 for i in range(1200))
    blk = 100
    blocks = [_file_block(off, file[off:off + blk]) for off in range(0, 1200, blk)]
    # batch 1: 0..600, then device replays from 300 (an early ACK), batch continues.
    raw = b"".join(blocks[:6] + blocks[3:9] + blocks[9:])

    with patch("services.aim_connector._BATCH_PAYLOAD_BYTES", 600):
        sock = _FixedChunkReplaySocket(raw, 777)
        result = _receive_file_data(sock, 1200, trace=None)

    assert result == file
    acks = [_ack_payload_bytes(item) for item in sock.sent]
    assert acks and acks[0] == 600


@pytest.mark.skipif(
    shutil.which("tshark") is None
    and not Path(r"C:\Program Files\Wireshark\tshark.exe").exists(),
    reason="tshark not available",
)
def test_wireshark_a0116_capture_uses_cumulative_progress_acks():
    repo_root = Path(__file__).resolve().parents[1]
    pcap = repo_root / "116CaptureWireshark.pcapng"
    if not pcap.exists():
        pytest.skip("116CaptureWireshark.pcapng not present")

    tshark = shutil.which("tshark") or r"C:\Program Files\Wireshark\tshark.exe"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
        follow_path = Path(handle.name)
    try:
        with follow_path.open("w", encoding="utf-8") as handle:
            subprocess.run(
                [tshark, "-r", str(pcap), "-q", "-z", "follow,tcp,raw,38"],
                stdout=handle,
                check=True,
            )
        text = follow_path.read_text(encoding="utf-8")
    finally:
        follow_path.unlink(missing_ok=True)

    ack_values: list[int] = []
    in_data = False
    for raw_line in text.splitlines():
        if raw_line.startswith("======="):
            in_data = not in_data
            continue
        if not in_data or raw_line.startswith(("Follow:", "Filter:", "Node 0:", "Node 1:")):
            continue
        if raw_line.startswith("\t"):
            continue
        chunk = bytes.fromhex(raw_line.strip())
        idx = 0
        while True:
            idx = chunk.find(b"<hSTCP", idx)
            if idx < 0:
                break
            plen = int.from_bytes(chunk[idx + 6 : idx + 10], "little")
            payload = chunk[idx + 12 : idx + 12 + plen]
            if len(payload) == 4:
                ack_values.append(struct.unpack("<I", payload)[0])
            idx += 1

    assert 982320 in ack_values
    assert 1964640 in ack_values


def _load_pcap_server_stream(repo_root: Path) -> bytes:
    pcap = repo_root / "116CaptureWireshark.pcapng"
    tshark = shutil.which("tshark") or r"C:\Program Files\Wireshark\tshark.exe"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
        follow_path = Path(handle.name)
    try:
        with follow_path.open("w", encoding="utf-8") as handle:
            subprocess.run(
                [tshark, "-r", str(pcap), "-q", "-z", "follow,tcp,raw,38"],
                stdout=handle,
                check=True,
            )
        text = follow_path.read_text(encoding="utf-8")
    finally:
        follow_path.unlink(missing_ok=True)

    s2c = bytearray()
    in_data = False
    server_is_indented = True
    for raw_line in text.splitlines():
        if raw_line.startswith("Node 0:") and ":2000" in raw_line:
            server_is_indented = False
        elif raw_line.startswith("Node 1:") and ":2000" in raw_line:
            server_is_indented = True
    in_data = False
    for raw_line in text.splitlines():
        if raw_line.startswith("======="):
            in_data = not in_data
            continue
        if not in_data or raw_line.startswith(("Follow:", "Filter:", "Node 0:", "Node 1:")):
            continue
        is_indented = raw_line.startswith("\t")
        is_server = is_indented if server_is_indented else not is_indented
        hex_text = raw_line.strip()
        if not hex_text or not all(c in "0123456789abcdefABCDEF" for c in hex_text):
            continue
        chunk = bytes.fromhex(hex_text)
        if is_server:
            s2c.extend(chunk)
    return bytes(s2c)


class _FixedChunkReplaySocket:
    """Like a real trickling TCP socket: recv() ignores the caller's
    requested size and hands back its own fixed-size slices, regardless of
    where AiM protocol frame boundaries fall."""

    def __init__(self, stream: bytes, chunk_size: int) -> None:
        self._stream = stream
        self._chunk_size = chunk_size
        self._offset = 0
        self.sent: list[bytes] = []

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def settimeout(self, _timeout: float) -> None:
        return None

    def recv(self, _requested_size: int) -> bytes:
        if self._offset >= len(self._stream):
            return b""
        chunk = self._stream[self._offset : self._offset + self._chunk_size]
        self._offset += len(chunk)
        return chunk


@pytest.mark.parametrize("chunk_size", [536, 1072])
def test_receive_file_data_incremental_matches_legacy_reassembly(chunk_size):
    """Regression test for the incremental reassembler (perf fix): feed a
    synthetic multi-batch STCP file stream through `_receive_file_data()` in
    small chunks whose boundaries don't line up with frame boundaries, and
    check the result is byte-identical to `_extract_data_blocks()` run once
    over the whole stream -- the same algorithm, used as the final
    authoritative check after the incremental hot path finishes.
    """
    batch_one = b"".join(
        _file_block(off, bytes([off % 251]) * 200) for off in range(0, 2000, 200)
    )
    batch_two = _file_block(2000, b"Z" * 300)
    raw = batch_one + batch_two
    expected = _extract_data_blocks(raw)

    sock = _FixedChunkReplaySocket(raw, chunk_size)
    file_data = _receive_file_data(sock, len(expected), trace=None)

    assert file_data == expected


class _ReplaySocket:
    """Replays server bytes from a capture and records client progress ACKs."""

    def __init__(self, server_stream: bytes) -> None:
        self._stream = server_stream
        self._offset = 0
        self.sent: list[bytes] = []

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def settimeout(self, _timeout: float) -> None:
        return None

    def recv(self, size: int) -> bytes:
        if self._offset >= len(self._stream):
            return b""
        chunk = self._stream[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk


@pytest.mark.skipif(
    shutil.which("tshark") is None
    and not Path(r"C:\Program Files\Wireshark\tshark.exe").exists(),
    reason="tshark not available",
)
def test_receive_file_data_replays_wireshark_a0116_server_stream():
    repo_root = Path(__file__).resolve().parents[1]
    pcap = repo_root / "116CaptureWireshark.pcapng"
    if not pcap.exists():
        pytest.skip("116CaptureWireshark.pcapng not present")

    server_stream = _load_pcap_server_stream(repo_root)
    sock = _ReplaySocket(server_stream)
    file_data = _receive_file_data(sock, 2482176, trace=None)

    assert len(file_data) == 2482176
    progress_acks = sorted(
        {_ack_payload_bytes(item) for item in sock.sent if b"<hSTCP" in item}
    )
    assert 982320 in progress_acks
    assert 1964640 in progress_acks
