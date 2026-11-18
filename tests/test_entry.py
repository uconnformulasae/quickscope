"""Tests for the PyInstaller entry point (uvicorn is stubbed out)."""

from __future__ import annotations

import subprocess
import sys
import threading

import pytest

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


@pytest.mark.skipif(sys.platform != "win32", reason="Windows watches the parent PID, POSIX watches stdin")
def test_wait_for_process_exit_returns_once_the_process_ends():
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    returned = threading.Event()
    waiter = threading.Thread(target=lambda: (entry._wait_for_process_exit(proc.pid), returned.set()), daemon=True)
    try:
        waiter.start()
        assert not returned.wait(1.0), "returned while the process was still running"

        proc.kill()

        assert returned.wait(10.0), "did not return after the process exited"
    finally:
        proc.kill()
        proc.wait()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only code path")
def test_wait_for_process_exit_returns_at_once_for_a_missing_process():
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()

    entry._wait_for_process_exit(proc.pid)
