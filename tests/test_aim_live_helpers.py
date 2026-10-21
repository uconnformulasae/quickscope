"""Pure helpers in aim_live: frame codec errors, payload classifiers, discovery.

Complements test_aim_live.py, which needs pcap captures for most cases.
"""

from __future__ import annotations

import asyncio
import base64
import struct

import pytest

from services import aim_device_cache, aim_live
from services.aim_live import (
    LIVE_FRAME_MIN_DECOY_CEIL,
    LIVE_FRAME_MIN_NO_LAYOUT,
    STNC_ENUM_AUX,
    STNC_LIVE_POLL_A,
    STNC_SYSTEM,
    Frame,
    _describe_frame,
    _is_live_snapshot_payload,
    _live_min_len,
    _q_hint_live_payload_size,
    _stnc_payload,
    decode_frame,
    encode_frame,
    parse_identity,
    parse_live_snapshot,
    user_visible_error,
)
from services.aim_live_layout import ChannelField


@pytest.fixture(autouse=True)
def _no_cached_device(monkeypatch):
    monkeypatch.setattr(aim_device_cache, "_cached", None)


# ── user_visible_error ─────────────────────────────────────────────────────


def test_user_visible_error_uses_exception_text():
    assert user_visible_error(OSError("  no route to host ")) == "no route to host"


def test_user_visible_error_explains_bare_timeout():
    assert "TCP port 2000" in user_visible_error(TimeoutError())


def test_user_visible_error_names_type_when_no_detail():
    assert user_visible_error(ConnectionResetError()).startswith("ConnectionResetError")


# ── encode/decode ──────────────────────────────────────────────────────────


def test_encode_frame_rejects_non_four_byte_cmd():
    with pytest.raises(ValueError, match="4 bytes"):
        encode_frame(b"STC", b"")


def test_decode_frame_reads_flag_and_offset():
    buf = b"xx" + encode_frame(b"STNC", b"abc", flag=7)

    frame, consumed = decode_frame(buf, 2)

    assert frame == Frame(cmd=b"STNC", flag=7, payload=b"abc", trailer=sum(b"abc"))
    assert consumed == len(buf) - 2


def test_decode_frame_needs_more_data():
    frame = encode_frame(b"STCP", b"\x00" * 10)

    assert decode_frame(frame[:5]) == (None, 0)
    assert decode_frame(frame[:-1]) == (None, 0)


def _corrupt(frame: bytes, index: int, value: bytes) -> bytes:
    return frame[:index] + value + frame[index + len(value) :]


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda f: _corrupt(f, 0, b"<x"), "bad header magic"),
        (lambda f: _corrupt(f, 2, b"\x01"), "non-ASCII cmd"),
        (lambda f: _corrupt(f, 6, struct.pack("<I", 70000)), "exceeds maximum"),
        (lambda f: _corrupt(f, 11, b"!"), "bad header end"),
        (lambda f: _corrupt(f, 16, b"!"), "bad trailer start"),
        (lambda f: _corrupt(f, 17, b"STNC"), "cmd mismatch"),
        (lambda f: _corrupt(f, 21, b"\xff\xff"), "checksum mismatch"),
        (lambda f: _corrupt(f, 23, b"!"), "bad trailer end"),
    ],
)
def test_decode_frame_rejects_malformed_bytes(mutate, message):
    frame = encode_frame(b"STCP", b"\x01\x02\x03\x04")

    with pytest.raises(ValueError, match=message):
        decode_frame(mutate(frame))


# ── STNC payloads ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("sub_cmd", [STNC_SYSTEM, STNC_ENUM_AUX])
def test_stnc_enum_payloads_set_at_marker(sub_cmd):
    payload = _stnc_payload(sub_cmd)

    assert len(payload) == 64
    assert struct.unpack_from("<I", payload, 8)[0] == sub_cmd
    assert payload[16] == 0x40
    assert payload[24] == 0x41


def test_stnc_poll_payload_has_no_enum_marker():
    payload = _stnc_payload(STNC_LIVE_POLL_A)

    assert payload[16] == 0
    assert payload[24] == 0x41


# ── live payload classification ────────────────────────────────────────────


def _field(offset: int, width: int) -> ChannelField:
    return ChannelField(name="X", live_offset=offset, width=width, scale=1.0, offset=0.0, type_code=0)


def test_live_min_len_without_layout_uses_floor():
    assert _live_min_len(None) == LIVE_FRAME_MIN_NO_LAYOUT


def test_live_min_len_uses_layout_extent():
    assert _live_min_len([_field(100, 2), _field(600, 4)]) == 604


def test_live_min_len_never_drops_to_decoy_size():
    assert _live_min_len([_field(12, 2)]) == LIVE_FRAME_MIN_DECOY_CEIL + 1


def test_live_payload_requires_zero_prefix_and_non_layout_tag():
    base = b"\x00\x00\x00\x00Syst" + b"\x00" * 600

    assert _is_live_snapshot_payload(base)
    assert not _is_live_snapshot_payload(b"\x01" + base[1:])
    assert not _is_live_snapshot_payload(b"\x00\x00\x00\x00hhhh" + b"\x00" * 600)
    assert not _is_live_snapshot_payload(base[:300])


def test_q_hint_predicts_live_payload_size_only_in_live_range():
    assert _q_hint_live_payload_size(600) == 604
    assert _q_hint_live_payload_size(100) is None  # control-sized
    assert _q_hint_live_payload_size(3500) is None  # enum / layout blob


# ── _describe_frame ────────────────────────────────────────────────────────


def test_describe_frame_variants():
    stnc = Frame(cmd=b"STNC", flag=0, payload=_stnc_payload(STNC_SYSTEM), trailer=0)
    other = Frame(cmd=b"CNFG", flag=0, payload=b"abc", trailer=0)
    ctl = bytearray(64)
    ctl[24] = ord("Q")
    struct.pack_into("<I", ctl, 16, 600)
    q = Frame(cmd=b"STCP", flag=0, payload=bytes(ctl), trailer=0)
    hb = Frame(cmd=b"STCP", flag=0, payload=b"\x00\x00\x00\x00kkk\x00\x00\x00\x00\x00", trailer=0)
    live = Frame(cmd=b"STCP", flag=0, payload=b"\x00\x00\x00\x00Syst" + b"\x00" * 600, trailer=0)
    small = Frame(cmd=b"STCP", flag=0, payload=b"\x00" * 20, trailer=0)

    assert _describe_frame(stnc) == "STNC sub=0x00010010"
    assert _describe_frame(other) == "CNFG len=3"
    assert _describe_frame(q) == "STCP len=64 op=Q next_len_hint=600 (->604B payload)"
    assert _describe_frame(hb) == "STCP len=12 heartbeat tag='kkk'"
    assert _describe_frame(live) == "STCP LIVE len=608 tag='Syst'"
    assert _describe_frame(small) == "STCP len=20"


# ── identity / discovery ───────────────────────────────────────────────────


def test_parse_identity_extracts_model_serial_vehicle():
    ident = parse_identity("10.0.0.1", b"\x00" * 8 + b"AiM-EVO5-00740-UConn EV\x00\x00")

    assert (ident.ip, ident.model, ident.serial, ident.vehicle) == (
        "10.0.0.1",
        "EVO5",
        "00740",
        "UConn EV",
    )


def test_parse_identity_without_match_keeps_ip_only():
    ident = parse_identity("10.0.0.1", b"nothing useful")

    assert (ident.model, ident.serial, ident.vehicle) == ("", "", "")


def test_discover_probes_candidates_and_records_identity(monkeypatch):
    monkeypatch.setattr(
        aim_live, "probe_device_ips", lambda timeout=2.0: ("10.0.0.8", b"AiM-EVO5-1-Car\x00")
    )

    ident = asyncio.run(aim_live.discover(timeout=0.1))

    assert ident is not None and ident.ip == "10.0.0.8"
    cached = aim_device_cache.get_cached()
    assert (cached.ip, cached.model, cached.serial, cached.vehicle) == ("10.0.0.8", "EVO5", "1", "Car")


def test_discover_single_ip_uses_udp_probe(monkeypatch):
    from services import aim_discovery

    probed: list[str] = []

    def fake_probe(ip, timeout=2.0):
        probed.append(ip)
        return b"AiM-MXS-9-Kart\x00"

    monkeypatch.setattr(aim_discovery, "udp_probe", fake_probe)
    monkeypatch.setattr(
        aim_live, "probe_device_ips", lambda timeout=2.0: pytest.fail("no candidate sweep")
    )

    ident = asyncio.run(aim_live.discover(ip="192.168.1.1"))

    assert probed == ["192.168.1.1"]
    assert ident.model == "MXS"


def test_discover_returns_none_without_reply(monkeypatch):
    monkeypatch.setattr(aim_live, "probe_device_ips", lambda timeout=2.0: None)

    assert asyncio.run(aim_live.discover()) is None
    assert aim_device_cache.get_cached() is None


def test_discover_single_ip_returns_none_without_reply(monkeypatch):
    from services import aim_discovery

    monkeypatch.setattr(aim_discovery, "udp_probe", lambda ip, timeout=2.0: None)

    assert asyncio.run(aim_live.discover(ip="10.0.0.1")) is None


# ── parse_live_snapshot ────────────────────────────────────────────────────


def test_parse_live_snapshot_header_without_layout():
    payload = b"\x00\x00\x00\x00Syst" + struct.pack("<I", 123456) + b"\x01" * 20

    snap = parse_live_snapshot(payload)

    assert snap.subsystem == "Syst"
    assert snap.timestamp_ms == 123456
    assert snap.channels == {}
    assert base64.b64decode(snap.raw_b64) == payload


def test_parse_live_snapshot_rejects_short_payload():
    with pytest.raises(ValueError, match="too short"):
        parse_live_snapshot(b"\x00" * 11)
