"""Unit tests for backend/sanitize.py — the shared input sanitizers."""

from __future__ import annotations

import pytest

import sanitize
from sanitize import (
    InvalidInput,
    clean_text,
    csv_safe_cell,
    sanitize_filename,
    validate_channel_payload,
    validate_device_ip,
    validate_device_port,
    validate_layout_id,
    validate_wifi_ssid,
)


# ─── clean_text ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("  Lap 3  ", "Lap 3"),
        ("a\x00b", "ab"),
        ("line1\nline2\r\n", "line1line2"),
        ("tab\there", "tabhere"),
        ("\x1b[31mred\x1b[0m", "[31mred[0m"),
        ("rtl\u202eoverride", "rtloverride"),
        ("zero\u200bwidth", "zerowidth"),
        ("Café ⚡ 速度", "Café ⚡ 速度"),
    ],
)
def test_clean_text_strips_control_and_invisible_characters(raw, expected):
    assert clean_text(raw, max_len=100) == expected


def test_clean_text_rejects_non_strings():
    with pytest.raises(InvalidInput):
        clean_text(123, max_len=10)  # type: ignore[arg-type]


def test_clean_text_rejects_too_long_unless_truncating():
    with pytest.raises(InvalidInput):
        clean_text("x" * 11, max_len=10)
    assert clean_text("x" * 11, max_len=10, truncate=True) == "x" * 10


# ─── sanitize_filename ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("run1.xrk", "run1.xrk"),
        ("  run1.xrk  ", "run1.xrk"),
        ("../../etc/passwd", "passwd"),
        ("..\\..\\windows\\system32\\run.xrk", "run.xrk"),  # same on every OS
        ("run\x00.xrk", "run.xrk"),
        ("evil\u202egpj.xrk", "evilgpj.xrk"),
        ("CON.xrk", "_CON.xrk"),
        ("nul", "_nul"),
        ("com1.xrz", "_com1.xrz"),
        ("LPT9.xrk", "_LPT9.xrk"),
        ("console.xrk", "console.xrk"),  # only exact reserved stems
        ("run.xrk.", "run.xrk"),  # Windows silently drops trailing dots
        ("run.xrk...", "run.xrk"),
    ],
)
def test_sanitize_filename_hardening(raw, expected):
    assert sanitize_filename(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "/", ".", "..", ".hidden", "...", "\x00\x01", 42, None])
def test_sanitize_filename_rejects_unusable_names(raw):
    with pytest.raises(ValueError):
        sanitize_filename(raw)  # type: ignore[arg-type]


def test_sanitize_filename_caps_length_and_keeps_extension():
    out = sanitize_filename("a" * 500 + ".xrk")
    assert len(out) <= sanitize.MAX_FILENAME_LEN
    assert out.endswith(".xrk")
    assert out.startswith("aaa")


def test_invalid_input_is_a_value_error():
    """Existing callers catch ValueError; InvalidInput must stay compatible."""
    assert issubclass(InvalidInput, ValueError)


# ─── device settings ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("10.0.0.1", "10.0.0.1"),
        (" 192.168.4.1 ", "192.168.4.1"),
        ("::1", "::1"),
        ("fe80:0:0:0:0:0:0:1", "fe80::1"),
    ],
)
def test_validate_device_ip_accepts_ip_literals(raw, expected):
    assert validate_device_ip(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "", "evil.example.com", "10.0.0.256", "10.0.0", "10.0.0.1:2000",
        "10.0.0.1; rm -rf /", "http://10.0.0.1", "10.0.0.1\n", 1234, None, [],
    ],
)
def test_validate_device_ip_rejects_everything_else(raw):
    with pytest.raises(InvalidInput):
        validate_device_ip(raw)


@pytest.mark.parametrize("raw, expected", [(2000, 2000), (1, 1), (65535, 65535), ("2000", 2000), (2000.0, 2000)])
def test_validate_device_port_accepts_valid_ports(raw, expected):
    assert validate_device_port(raw) == expected


@pytest.mark.parametrize("raw", [0, -1, 65536, 2000.5, "abc", "", True, False, None, "1e3", float("nan")])
def test_validate_device_port_rejects_invalid_ports(raw):
    with pytest.raises(InvalidInput):
        validate_device_port(raw)


@pytest.mark.parametrize(
    "raw, expected",
    [("AiM-EVO5-00740-UConn-EV", "AiM-EVO5-00740-UConn-EV"), ("", ""), ("  My WiFi ", "My WiFi")],
)
def test_validate_wifi_ssid_accepts_normal_names(raw, expected):
    assert validate_wifi_ssid(raw) == expected


@pytest.mark.parametrize("raw", ["x" * 33, "é" * 17, None, 5])  # 32-byte 802.11 limit
def test_validate_wifi_ssid_rejects_oversized_or_non_string(raw):
    with pytest.raises(InvalidInput):
        validate_wifi_ssid(raw)


def test_validate_wifi_ssid_strips_control_characters():
    assert validate_wifi_ssid("AiM\x00\nNet") == "AiMNet"


# ─── CSV formula injection ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Engine RPM (rpm)", "Engine RPM (rpm)"),
        ("=HYPERLINK(\"http://x\",\"y\")", "'=HYPERLINK(\"http://x\",\"y\")"),
        ("+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"),
        ("-2+3", "'-2+3"),
        ("@SUM(A1)", "'@SUM(A1)"),
        ("\t=1", "'\t=1"),
        ("\r=1", "'\r=1"),
        ("＝1", "'＝1"),  # full-width equals is also evaluated by some spreadsheets
        ("", ""),
    ],
)
def test_csv_safe_cell_neutralises_formula_prefixes(raw, expected):
    assert csv_safe_cell(raw) == expected


# ─── layout ids ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("raw", ["layout-1a2b3c4d", "w-abc", "builtin-ev-default", "A_b-9"])
def test_validate_layout_id_accepts_client_ids(raw):
    assert validate_layout_id(raw) == raw


@pytest.mark.parametrize("raw", ["", "a" * 65, "../x", "a b", "a/b", "<script>", "id\n", None, 3])
def test_validate_layout_id_rejects_other_ids(raw):
    with pytest.raises(InvalidInput):
        validate_layout_id(raw)


# ─── derived-channel payload ─────────────────────────────────────────────────


def test_validate_channel_payload_accepts_the_client_shape():
    payload = {"RPM": {"timestamps": [0, 10], "values": [1.0, None]}}
    assert validate_channel_payload(payload) is payload


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"RPM": [1, 2]},
        {"RPM": {"timestamps": [0]}},
        {"RPM": {"timestamps": "0,1", "values": [1, 2]}},
        {"RPM": {"timestamps": [0, 1], "values": [1]}},
        {"x" * 300: {"timestamps": [], "values": []}},
    ],
)
def test_validate_channel_payload_rejects_malformed_payloads(payload):
    with pytest.raises(InvalidInput):
        validate_channel_payload(payload)


def test_validate_channel_payload_caps_channel_count():
    payload = {f"c{i}": {"timestamps": [], "values": []} for i in range(sanitize.MAX_DERIVED_CHANNELS + 1)}
    with pytest.raises(InvalidInput):
        validate_channel_payload(payload)
