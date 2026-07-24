"""FastAPI smoke tests (no XRK file required)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_list_sessions():
    res = client.get("/api/sessions")
    assert res.status_code == 200
    assert isinstance(res.json(), list)


def test_settings():
    res = client.get("/api/settings")
    assert res.status_code == 200
    assert isinstance(res.json(), dict)


def test_channels_without_loaded_session():
    res = client.get("/api/channels")
    assert res.status_code == 400
