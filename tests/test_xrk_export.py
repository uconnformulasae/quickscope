"""Tests for XRZ → XRK export preparation."""

from __future__ import annotations

import zlib
from pathlib import Path

import pytest

from services.xrk_export import (
    export_xrk_filename,
    is_zlib_xrz_payload,
    quickscope_export_basename,
    read_xrk_export_bytes,
)


def test_export_xrk_filename_replaces_xrz():
    assert export_xrk_filename("a_0242.xrz") == "a_0242.xrk"
    assert export_xrk_filename("run1.xrk") == "run1.xrk"
    assert export_xrk_filename("a_0242.xrz", "Endurance") == "Endurance.xrk"


def test_quickscope_export_basename():
    assert quickscope_export_basename("a_0042.xrk", "Endurance") == "Endurance"
    assert quickscope_export_basename("run1.xrk", "") == "run1"
    assert quickscope_export_basename("pulled.xrz", None) == "pulled"


def test_is_zlib_xrz_payload():
    assert is_zlib_xrz_payload(zlib.compress(b"data"))
    assert not is_zlib_xrz_payload(b"not zlib")


def test_read_xrk_export_bytes_decompresses_xrz(tmp_path: Path):
    payload = b"uncompressed-xrk-payload"
    xrz = tmp_path / "session.xrz"
    xrz.write_bytes(zlib.compress(payload))

    out, name = read_xrk_export_bytes(xrz, "session.xrz")
    assert out == payload
    assert name == "session.xrk"


def test_read_xrk_export_bytes_passes_through_xrk(tmp_path: Path):
    xrk = tmp_path / "session.xrk"
    xrk.write_bytes(b"already-xrk")

    out, name = read_xrk_export_bytes(xrk)
    assert out == b"already-xrk"
    assert name == "session.xrk"


def test_read_xrk_export_bytes_bad_xrz(tmp_path: Path):
    bad = tmp_path / "bad.xrz"
    bad.write_bytes(b"\x78\x9cnot valid zlib")

    with pytest.raises(ValueError, match="decompress"):
        read_xrk_export_bytes(bad)
