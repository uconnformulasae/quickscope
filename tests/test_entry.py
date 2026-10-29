"""Tests for the PyInstaller entry point (uvicorn is stubbed out)."""

from __future__ import annotations

import entry


def test_main_uses_default_host_and_port(monkeypatch):
    calls = []
    monkeypatch.delenv("QUICKSCOPE_HOST", raising=False)
    monkeypatch.delenv("QUICKSCOPE_PORT", raising=False)
    monkeypatch.setattr(entry.uvicorn, "run", lambda app, **kw: calls.append((app, kw)))

    assert entry.main() == 0

    from main import app

    assert calls == [(app, {"host": "127.0.0.1", "port": 8000, "log_level": "info"})]


def test_main_reads_host_and_port_from_env(monkeypatch):
    calls = []
    monkeypatch.setenv("QUICKSCOPE_HOST", "0.0.0.0")
    monkeypatch.setenv("QUICKSCOPE_PORT", "8123")
    monkeypatch.setattr(entry.uvicorn, "run", lambda app, **kw: calls.append(kw))

    entry.main()

    assert calls == [{"host": "0.0.0.0", "port": 8123, "log_level": "info"}]
