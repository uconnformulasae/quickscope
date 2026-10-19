"""Live dashboard layout store, device channel cache, and their routes."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from main import app
from services import live_channel_cache, live_layout_store
from services.live_layout_store import LayoutError

client = TestClient(app)


def _layout(layout_id: str = "layout-1", **overrides) -> dict:
    return {
        "id": layout_id,
        "name": "Driver view",
        "vehicle": "ev",
        "version": 1,
        "grid": [{"i": "w-1", "x": 0, "y": 0, "w": 6, "h": 4}],
        "widgets": [{"id": "w-1", "type": "stats", "title": "Pack", "channels": [{"name": "Pack_Voltage"}]}],
        **overrides,
    }


# ─── live_layout_store ───────────────────────────────────────────────────────


def test_empty_store_has_no_layouts_and_blank_selection():
    assert live_layout_store.load() == {
        "layouts": [],
        "selection": {"active": {}, "pinned": None, "last_used": None},
    }


def test_put_get_replace_delete_roundtrip():
    live_layout_store.put_layout("layout-1", _layout())
    assert live_layout_store.load()["layouts"][0]["name"] == "Driver view"

    live_layout_store.put_layout("layout-1", _layout(name="Renamed"))
    layouts = live_layout_store.load()["layouts"]
    assert [l["name"] for l in layouts] == ["Renamed"]

    assert live_layout_store.delete_layout("layout-1") is True
    assert live_layout_store.delete_layout("layout-1") is False
    assert live_layout_store.load()["layouts"] == []


def test_delete_clears_selection_references():
    live_layout_store.put_layout("layout-1", _layout())
    live_layout_store.update_selection({"active": {"ev": "layout-1"}, "pinned": "layout-1", "last_used": "layout-1"})
    live_layout_store.delete_layout("layout-1")
    assert live_layout_store.load()["selection"] == {"active": {}, "pinned": None, "last_used": None}


@pytest.mark.parametrize(
    "layout_id, layout, message",
    [
        ("layout-1", _layout("other"), "does not match"),
        ("builtin-ev", _layout("builtin-ev"), "Built-in"),
        ("layout-1", _layout(name="  "), "name"),
        ("layout-1", _layout(vehicle="hybrid"), "vehicle"),
        ("layout-1", _layout(widgets="nope"), "widgets"),
        ("layout-1", _layout(note="x" * (live_layout_store.MAX_LAYOUT_BYTES + 1)), "larger than"),
    ],
)
def test_put_rejects_bad_layouts(layout_id, layout, message):
    with pytest.raises(LayoutError, match=message):
        live_layout_store.put_layout(layout_id, layout)
    assert live_layout_store.load()["layouts"] == []


def test_selection_ignores_unknown_vehicles_and_bad_values():
    sel = live_layout_store.update_selection({"active": {"ev": "a", "hybrid": "b", "ic": 3}, "pinned": 7})
    assert sel == {"active": {"ev": "a"}, "pinned": None, "last_used": None}


def test_corrupt_layouts_file_is_set_aside_not_fatal():
    live_layout_store.DATA_DIR.mkdir(parents=True, exist_ok=True)
    live_layout_store.LAYOUTS_FILE.write_text("{not json")
    assert live_layout_store.load()["layouts"] == []
    assert list(live_layout_store.DATA_DIR.glob("live_layouts.json.*.corrupt"))


def test_save_is_atomic_and_leaves_no_temp_file():
    live_layout_store.put_layout("layout-1", _layout())
    assert not list(live_layout_store.DATA_DIR.glob("*.tmp"))
    assert json.loads(live_layout_store.LAYOUTS_FILE.read_text())["layouts"][0]["id"] == "layout-1"


# ─── live_channel_cache ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "vehicle, kind",
    [("UConn-IC", "ic"), ("IC", "ic"), ("UConn-EV", "ev"), ("Electric", "ev"), ("", "ev"), (None, "ev")],
)
def test_vehicle_kind_matches_client_rule(vehicle, kind):
    assert live_channel_cache.vehicle_kind(vehicle) == kind


def test_record_merges_and_only_writes_when_set_grows():
    assert live_channel_cache.record("UConn-EV", "740", {"RPM", "Pack_Voltage"}) is True
    mtime = live_channel_cache.CHANNELS_FILE.stat().st_mtime_ns

    # Subset of what we already know: no write.
    assert live_channel_cache.record("UConn-EV", "740", {"RPM"}) is False
    assert live_channel_cache.CHANNELS_FILE.stat().st_mtime_ns == mtime

    # A session missing some channels still keeps the earlier ones.
    assert live_channel_cache.record("UConn-EV", "740", {"RPM", "Motor_Temp"}) is True
    cached = live_channel_cache.get("ev")
    assert cached["channels"] == ["Motor_Temp", "Pack_Voltage", "RPM"]
    assert cached["vehicle"] == "UConn-EV"
    assert cached["serial"] == "740"


def test_record_keeps_cars_separate():
    live_channel_cache.record("UConn-IC", "1", {"S8_RPM"})
    live_channel_cache.record("UConn-EV", "2", {"Pack_Voltage"})
    assert live_channel_cache.get("ic")["channels"] == ["S8_RPM"]
    assert live_channel_cache.get("ev")["channels"] == ["Pack_Voltage"]


def test_get_unknown_vehicle_returns_empty_list():
    assert live_channel_cache.get("ic") == {
        "vehicle_kind": "ic", "vehicle": None, "serial": None, "seen_at": None, "channels": [],
    }


# ─── routes ──────────────────────────────────────────────────────────────────


def test_layout_routes_roundtrip():
    assert client.get("/api/live/layouts").json()["layouts"] == []

    res = client.put("/api/live/layouts/layout-1", json=_layout())
    assert res.status_code == 200

    res = client.put("/api/live/layout-selection", json={"active": {"ev": "layout-1"}, "last_used": "layout-1"})
    assert res.json() == {"active": {"ev": "layout-1"}, "pinned": None, "last_used": "layout-1"}

    body = client.get("/api/live/layouts").json()
    assert [l["id"] for l in body["layouts"]] == ["layout-1"]
    assert body["selection"]["last_used"] == "layout-1"

    assert client.delete("/api/live/layouts/layout-1").status_code == 200
    assert client.delete("/api/live/layouts/layout-1").status_code == 404


def test_put_layout_route_returns_400_with_reason():
    res = client.put("/api/live/layouts/builtin-ev", json=_layout("builtin-ev"))
    assert res.status_code == 400
    assert "Built-in" in res.json()["detail"]


def test_channels_route_validates_vehicle():
    live_channel_cache.record("UConn-IC", "1", {"S8_RPM"})
    assert client.get("/api/live/channels?vehicle=ic").json()["channels"] == ["S8_RPM"]
    assert client.get("/api/live/channels?vehicle=hybrid").status_code == 422
