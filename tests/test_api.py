"""FastAPI smoke tests (no XRK file required)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from main import app
from services import settings_store

client = TestClient(app)


def test_list_sessions_on_a_fresh_data_dir_is_empty():
    res = client.get("/api/sessions")
    assert res.status_code == 200
    assert res.json() == []  # isolated, empty data dir


def test_settings_returns_exactly_the_defaults_on_a_fresh_data_dir():
    res = client.get("/api/settings")
    assert res.status_code == 200
    assert res.json() == settings_store.DEFAULTS


def test_cors_trusts_the_local_ui_but_not_null_or_other_sites():
    """Origin: null comes from any site's sandboxed iframe, so it must not be
    trusted; the packaged app uses app://quickscope instead."""
    def allowed(origin):
        res = client.get("/api/sessions", headers={"Origin": origin})
        return res.headers.get("access-control-allow-origin") == origin

    assert allowed("app://quickscope")
    assert allowed("http://localhost:5173")
    assert allowed("http://127.0.0.1:8000")
    assert not allowed("null")
    assert not allowed("https://evil.example")
    assert not allowed("app://evil")


def test_channels_without_loaded_session():
    res = client.get("/api/channels")
    assert res.status_code == 400
