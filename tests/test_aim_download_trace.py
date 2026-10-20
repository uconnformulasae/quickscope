"""AimDownloadTrace: JSON-lines timeline written during AiM file downloads."""

from __future__ import annotations

import json

import pytest

from services import aim_download_trace
from services.aim_download_trace import AimDownloadTrace
from services.aim_live import Frame, encode_frame


@pytest.fixture
def log_dir(tmp_path, monkeypatch):
    path = tmp_path / "logs"
    monkeypatch.setattr(aim_download_trace, "_LOG_DIR", path)
    return path


def _events(trace: AimDownloadTrace) -> list[dict]:
    return [json.loads(line) for line in trace.path.read_text().splitlines()]


def test_trace_file_name_is_sanitised_and_starts_with_session_start(log_dir):
    trace = AimDownloadTrace("bad name/../x.xrz", expected_size=1234)
    trace.close(status="ok")

    assert trace.path.parent == log_dir
    assert "/" not in trace.path.name.split("_", 1)[1]
    assert trace.path.name.endswith("_bad_name_.._x.xrz.log")
    events = _events(trace)
    assert events[0]["event"] == "session_start"
    assert events[0]["filename"] == "bad name/../x.xrz"
    assert events[0]["expected_size"] == 1234
    assert events[-1] == {**events[-1], "event": "session_end", "status": "ok"}


def test_two_traces_for_same_file_do_not_overwrite(log_dir):
    a = AimDownloadTrace("x.xrz")
    b = AimDownloadTrace("x.xrz")
    a.close(status="ok")
    b.close(status="ok")

    assert a.path != b.path


def test_log_flushes_after_twenty_lines(log_dir):
    trace = AimDownloadTrace("x.xrz")
    for i in range(19):
        trace.log("recv", n=i)

    # session_start + 19 recv = 20 lines → flushed without close()
    assert len(trace.path.read_text().splitlines()) == 20
    trace.close(status="ok")


def test_log_frame_records_cmd_length_and_opcode(log_dir):
    trace = AimDownloadTrace("x.xrz")
    payload = bytearray(64)
    payload[24] = ord("D")
    trace.log_frame(Frame(cmd=b"STCP", flag=0, payload=bytes(payload), trailer=0), ack_sent=True)
    trace.log_frame(Frame(cmd=b"STCP", flag=0, payload=b"\x00" * 10, trailer=0))
    payload[24] = 5
    trace.log_frame(Frame(cmd=b"STCP", flag=0, payload=bytes(payload), trailer=0))
    trace.close(status="ok")

    frames = [e for e in _events(trace) if e["event"] == "frame"]
    assert frames[0]["cmd"] == "STCP"
    assert frames[0]["payload_len"] == 64
    assert frames[0]["ack_sent"] is True
    assert frames[0]["opcode"] == "D"
    assert "opcode" not in frames[1]
    assert frames[2]["opcode"] == 5


def test_analyze_raw_stream_counts_frames_and_records_tail(log_dir):
    raw = encode_frame(b"STCP", b"a" * 8) + encode_frame(b"STCP", b"b" * 8) + encode_frame(
        b"CNFG", b"c" * 4
    )
    trace = AimDownloadTrace("x.xrz")
    trace.analyze_raw_stream(raw, extracted=16, expected=20)
    trace.close(status="ok")

    analysis = next(e for e in _events(trace) if e["event"] == "stream_analysis")
    assert analysis["frame_counts"] == {"STCP:8": 2, "CNFG:4": 1}
    assert analysis["raw_bytes"] == len(raw)
    assert analysis["extracted_bytes"] == 16
    assert analysis["expected_bytes"] == 20
    assert analysis["tail_hex"] == raw.hex()


def test_analyze_raw_stream_skips_garbage_to_next_header(log_dir):
    good = encode_frame(b"STCP", b"z" * 4)
    raw = b"<hXXXX\xff\xff\xff\xff\x00>junk" + good
    trace = AimDownloadTrace("x.xrz")
    trace.analyze_raw_stream(raw, extracted=0, expected=0)
    trace.close(status="ok")

    events = _events(trace)
    analysis = next(e for e in events if e["event"] == "stream_analysis")
    assert analysis["frame_counts"].get("STCP:4") == 1


def test_analyze_raw_stream_tail_is_capped_at_256_bytes(log_dir):
    raw = b"\x00" * 1000
    trace = AimDownloadTrace("x.xrz")
    trace.analyze_raw_stream(raw, extracted=0, expected=0)
    trace.close(status="ok")

    analysis = next(e for e in _events(trace) if e["event"] == "stream_analysis")
    assert len(bytes.fromhex(analysis["tail_hex"])) == 256
