"""Tests for AiM live protocol helpers and capture-derived fixtures.

Ground-truth pcaps (Race Studio 3):
  c:\\Users\\jesse\\Downloads\\Live.pcapng  (stream 1)
  c:\\Users\\jesse\\Downloads\\live_pedal.pcapng  (stream 45)
"""

from __future__ import annotations

import base64
import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
CAPTURES = ROOT / "docs" / "protocol" / "captures"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(CAPTURES))

from services.aim_live import (  # noqa: E402
    LIVE_FRAME_SIZE_113CH,
    STNC_ENUM_AUX,
    STNC_LIVE_POLL_A,
    STNC_LIVE_POLL_B,
    STNC_SETUP_SELECTORS,
    STNC_SYSTEM,
    _is_live_snapshot_payload,
    _q_hint_live_payload_size,
    _stcp_date_followup,
    _stnc_payload,
    decode_frame,
    encode_frame,
    parse_live_snapshot,
)
from parse_aim_stream import load_stream, parse_frames  # noqa: E402

FIXTURE_LIVE = CAPTURES / "fixtures" / "live_2026_follow_raw.txt"
FIXTURE_PEDAL = CAPTURES / "fixtures" / "live_pedal_2026_follow_raw.txt"


def test_stnc_system_payload_matches_live_capture() -> None:
    assert FIXTURE_LIVE.is_file()
    c2s, _ = load_stream(FIXTURE_LIVE)
    cap = next(
        f.payload
        for f in parse_frames(c2s, "C")
        if f.cmd == b"STNC"
        and int.from_bytes(f.payload[8:12], "little") == STNC_SYSTEM
    )
    assert _stnc_payload(STNC_SYSTEM) == cap


def test_encode_decode_roundtrip() -> None:
    payload = _stnc_payload(STNC_LIVE_POLL_A)
    wire = encode_frame(b"STNC", payload)
    frame, consumed = decode_frame(wire)
    assert consumed == len(wire)
    assert frame is not None
    assert frame.cmd == b"STNC"
    assert frame.payload == payload


def test_stcp_date_followup_is_68_bytes() -> None:
    from datetime import datetime

    follow = _stcp_date_followup()
    assert len(follow) == 68
    year = struct.unpack_from("<H", follow, 12)[0]
    assert 2020 <= year <= 2100


def test_stcp_date_followup_matches_capture_block1() -> None:
    from datetime import datetime

    cap = bytes.fromhex(
        "000000000000000000000000ea0700000900000012000000000000000e000000"
        "000000000000000000000000ea0700000900000011000000140000000e00000000000000"
    )
    follow = _stcp_date_followup(datetime(2026, 9, 18, 14, 0, 0))
    assert follow[:34] == cap[:34]


def test_stcp_date_followup_second_block_matches_first() -> None:
    from datetime import datetime

    follow = _stcp_date_followup(datetime(2026, 9, 19, 12, 56, 0))
    assert follow[34:] == follow[:34]


def test_live_fixture_handshake_stnc_order() -> None:
    assert FIXTURE_LIVE.is_file(), "missing live_2026_follow_raw.txt fixture"
    c2s, s2c = load_stream(FIXTURE_LIVE)
    cframes = parse_frames(c2s, "C")
    stnc_subs = [
        int.from_bytes(f.payload[8:12], "little")
        for f in cframes
        if f.cmd == b"STNC"
    ]
    assert stnc_subs[:10] == [
        STNC_SYSTEM,
        STNC_ENUM_AUX,
        STNC_SYSTEM,
        STNC_SYSTEM,
        *STNC_SETUP_SELECTORS,
    ]


def test_live_fixture_server_snapshot_size() -> None:
    _, s2c = load_stream(FIXTURE_LIVE)
    sframes = parse_frames(s2c, "S")
    live_frames = [f for f in sframes if f.cmd == b"STCP" and len(f.payload) == 691]
    assert len(live_frames) >= 20
    sizes = {len(f.payload) for f in live_frames}
    assert 691 in sizes
    assert 547 not in sizes


def test_pedal_fixture_snapshots_vary() -> None:
    assert FIXTURE_PEDAL.is_file(), "missing live_pedal_2026_follow_raw.txt fixture"
    _, s2c = load_stream(FIXTURE_PEDAL)
    sframes = parse_frames(s2c, "S")
    live_payloads = [
        f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == 691
    ]
    assert len(live_payloads) >= 10
    unique_hashes = {hash(p) for p in live_payloads}
    assert len(unique_hashes) >= 2, "expected TPS pedal motion to change snapshot bytes"


def test_parse_live_snapshot_691() -> None:
    _, s2c = load_stream(FIXTURE_LIVE)
    sframes = parse_frames(s2c, "S")
    payload = next(
        f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == 691
    )
    snap = parse_live_snapshot(payload)
    assert snap.subsystem.startswith("Syst") or snap.subsystem.startswith("Sys")
    decoded = base64.b64decode(snap.raw_b64)
    assert len(decoded) == 691


def test_kkk_tagged_691_is_live_snapshot() -> None:
    """RS3 steady state: 691 B frames use kkk tag (Live.pcapng / RS3_live_1min)."""
    _, s2c = load_stream(FIXTURE_LIVE)
    sframes = parse_frames(s2c, "S")
    payload = next(
        f.payload
        for f in sframes
        if f.cmd == b"STCP"
        and len(f.payload) == 691
        and f.payload[4:8] == b"kkk\x01"
    )
    assert _is_live_snapshot_payload(payload)
    snap = parse_live_snapshot(payload)
    assert len(base64.b64decode(snap.raw_b64)) == 691


def test_12_byte_kkk_heartbeat_not_live_snapshot() -> None:
    _, s2c = load_stream(FIXTURE_LIVE)
    sframes = parse_frames(s2c, "S")
    hb = next(f.payload for f in sframes if f.cmd == b"STCP" and len(f.payload) == 12)
    assert hb[4:8].startswith(b"kkk")
    assert not _is_live_snapshot_payload(hb)


def test_707_syst_is_live_snapshot() -> None:
    """RS3-5-47 / 113ch EVO5: steady telemetry is 707 B (Q hint 703), not 691."""
    payload = bytearray(LIVE_FRAME_SIZE_113CH)
    payload[4:8] = b"Syst"
    assert _is_live_snapshot_payload(bytes(payload))
    assert _q_hint_live_payload_size(703) == LIVE_FRAME_SIZE_113CH


def test_q_ack_live_hint_from_fixture() -> None:
    _, s2c = load_stream(FIXTURE_LIVE)
    sframes = parse_frames(s2c, "S")
    hints = [
        struct.unpack("<I", f.payload[16:20])[0]
        for f in sframes
        if f.cmd == b"STCP"
        and len(f.payload) == 64
        and f.payload[24] == ord("Q")
    ]
    assert 687 in hints  # 687 + 4 = 691-byte live snapshot


def test_rs3_first_system_enum_client_prefix() -> None:
    """Live.pcapng stream 1: hello, STNC 0x10010, 68 B date, 4 B ack."""
    assert FIXTURE_LIVE.is_file()
    c2s, _ = load_stream(FIXTURE_LIVE)
    cframes = parse_frames(c2s, "C")
    assert cframes[0].cmd == b"STCP" and len(cframes[0].payload) == 8
    assert cframes[1].cmd == b"STNC"
    assert int.from_bytes(cframes[1].payload[8:12], "little") == STNC_SYSTEM
    assert cframes[2].cmd == b"STCP" and len(cframes[2].payload) == 68
    assert cframes[3].cmd == b"STCP" and len(cframes[3].payload) == 4


def test_rs3_aux_enum_sends_date_without_immediate_micro_ack() -> None:
    """Live.pcapng: STNC 0x10006 then 68 B date, next client frame is STNC."""
    c2s, _ = load_stream(FIXTURE_LIVE)
    cframes = parse_frames(c2s, "C")
    assert int.from_bytes(cframes[4].payload[8:12], "little") == STNC_ENUM_AUX
    assert len(cframes[5].payload) == 68
    assert cframes[6].cmd == b"STNC"
    assert len(cframes[6].payload) == 64
