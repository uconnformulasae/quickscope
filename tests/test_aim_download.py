"""Tests for AiM download trace and stall-ack behavior."""

from __future__ import annotations

import shutil
import struct
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from services.aim_connector import (
    _BATCH_PAYLOAD_BYTES,
    _STCP_MICRO_ACK,
    _STCP_Q_ACK_OPCODE,
    _STCP_Q_ACK_OPCODE_OFFSET,
    _detect_duplicate_batch_content,
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


def test_extract_data_blocks_appends_when_batch_offsets_reset():
    batch_one = _file_block(0, b"a" * 100) + _file_block(50, b"b" * 50)
    batch_two = _file_block(0, b"c" * 80)
    raw = batch_one + batch_two

    result = _extract_data_blocks(raw)

    assert len(result) == 180
    assert result[:50] == b"a" * 50
    assert result[50:100] == b"b" * 50
    assert result[100:180] == b"c" * 80


def test_extract_data_blocks_trims_to_expected_size():
    raw = _file_block(0, b"x" * 200)
    assert len(_extract_data_blocks(raw, expected_size=150)) == 150


def test_extract_data_blocks_skips_first_batch_retransmission():
    batch_one = _file_block(0, b"a" * 200)
    duplicate = _file_block(0, b"a" * 200)
    batch_two = _file_block(0, b"b" * 100)
    raw = batch_one + duplicate + batch_two

    result = _extract_data_blocks(raw)

    assert len(result) == 300
    assert result[:200] == b"a" * 200
    assert result[200:] == b"b" * 100


def test_detect_duplicate_batch_content_flags_repeated_chunks():
    chunk = b"Z" * _BATCH_PAYLOAD_BYTES
    assert _detect_duplicate_batch_content(chunk + chunk) is True
    assert _detect_duplicate_batch_content(chunk + b"Y" * _BATCH_PAYLOAD_BYTES) is False
    interleaved = chunk + (b"\x00" * _BATCH_PAYLOAD_BYTES) + chunk
    assert _detect_duplicate_batch_content(interleaved) is True


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


def test_receive_file_data_sends_progress_stall_ack_on_timeout(tmp_path, monkeypatch):
    trace_dir = tmp_path / "logs"
    monkeypatch.setattr(
        "services.aim_download_trace._LOG_DIR",
        trace_dir,
    )
    sock = _RecordingSocket()
    trace = AimDownloadTrace("test.xrz", 500)

    with patch(
        "services.aim_connector.time.monotonic",
        side_effect=[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 1000],
    ):
        try:
            _receive_file_data(sock, 500, trace)
        except RuntimeError:
            pass

    progress_acks = [
        item for item in sock.sent if _ack_payload_bytes(item) == 100
    ]
    assert progress_acks
    trace.close(status="test")
    assert trace.path.exists()


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
