"""Unit tests for parse_xrk DLL → libxrk fallback selection."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from libxrk.base import LogFile

from parsers import aim_dll, parse_xrk
from conftest import fixture_xrk


def _dummy_log() -> LogFile:
    import pyarrow as pa

    table = pa.table({"timecodes": [0], "RPM": [1.0]})
    return LogFile(
        channels={"RPM": table},
        laps=pa.table({"num": [], "start_time": [], "end_time": []}),
        metadata={},
        file_name="stub.xrk",
    )


def test_forced_libxrk_skips_dll(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("QUICKSCOPE_PARSER", "libxrk")
    calls: list[str] = []

    monkeypatch.setattr(aim_dll, "dll_available", lambda: (_ for _ in ()).throw(AssertionError("dll_available called")))
    monkeypatch.setattr(
        "parsers._parse_libxrk",
        lambda path: calls.append(str(path)) or _dummy_log(),
    )

    log = parse_xrk(Path("any.xrk"))
    assert isinstance(log, LogFile)
    assert calls == [str(Path("any.xrk"))]


@pytest.mark.skipif(sys.platform != "win32", reason="DLL fallback path only runs on Windows")
def test_falls_back_to_libxrk_when_dll_unavailable(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("QUICKSCOPE_PARSER", raising=False)
    monkeypatch.setattr(aim_dll, "dll_available", lambda: False)

    seen: list[str] = []
    monkeypatch.setattr(
        "parsers._parse_libxrk",
        lambda path: seen.append("libxrk") or _dummy_log(),
    )

    parse_xrk(Path("fallback.xrk"))
    assert seen == ["libxrk"]


@pytest.mark.skipif(sys.platform != "win32", reason="DLL fallback path only runs on Windows")
def test_falls_back_to_libxrk_when_dll_raises(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("QUICKSCOPE_PARSER", raising=False)
    monkeypatch.setattr(aim_dll, "dll_available", lambda: True)

    def _boom(path: Path) -> LogFile:
        raise RuntimeError("DLL parse failed")

    monkeypatch.setattr(aim_dll, "parse", _boom)

    seen: list[str] = []
    monkeypatch.setattr(
        "parsers._parse_libxrk",
        lambda path: seen.append("libxrk") or _dummy_log(),
    )

    parse_xrk(Path("fallback.xrk"))
    assert seen == ["libxrk"]


def test_forced_aim_dll_does_not_fallback(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("QUICKSCOPE_PARSER", "aim_dll")
    monkeypatch.setattr(aim_dll, "dll_available", lambda: True)
    monkeypatch.setattr(aim_dll, "parse", lambda path: (_ for _ in ()).throw(RuntimeError("DLL parse failed")))

    with pytest.raises(RuntimeError, match="DLL parse failed"):
        parse_xrk(Path("strict.xrk"))


def test_forced_libxrk_parses_fixture(monkeypatch: pytest.MonkeyPatch):
    xrk = fixture_xrk()
    if xrk is None:
        pytest.skip("No .xrk/.xrz fixture in tests/fixtures")

    monkeypatch.setenv("QUICKSCOPE_PARSER", "libxrk")
    log = parse_xrk(xrk)
    assert len(log.channels) >= 10
