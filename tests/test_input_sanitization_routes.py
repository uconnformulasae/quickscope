"""Route-level input sanitization: bad input gets a 4xx, never a 500 or a bad write."""

from __future__ import annotations

import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

from main import app
from routes import analysis
from services import live_layout_store, session_store, settings_store

client = TestClient(app)


# ─── Settings ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "body",
    [
        {"aim_device_ip": "evil.example.com"},
        {"aim_device_ip": "10.0.0.1; reboot"},
        {"aim_device_ip": 10},
        {"aim_device_port": 0},
        {"aim_device_port": 70000},
        {"aim_device_port": "abc"},
        {"aim_device_port": True},
        {"aim_wifi_ssid": "x" * 40},
        {"aim_wifi_ssid": ["list"]},
    ],
)
def test_settings_rejects_invalid_values_and_keeps_the_old_ones(body):
    before = client.get("/api/settings").json()
    res = client.put("/api/settings", json=body)
    assert res.status_code == 400
    assert isinstance(res.json()["detail"], str)
    assert client.get("/api/settings").json() == before


def test_settings_normalises_valid_values():
    res = client.put(
        "/api/settings",
        json={"aim_device_ip": " 192.168.4.1 ", "aim_device_port": "2001", "aim_wifi_ssid": " Car\nNet "},
    )
    assert res.status_code == 200
    assert res.json() == {"aim_device_ip": "192.168.4.1", "aim_device_port": 2001, "aim_wifi_ssid": "CarNet"}


def test_settings_unknown_keys_are_still_ignored_not_rejected():
    res = client.put("/api/settings", json={"railway_url": "x", "aim_device_port": 2000})
    assert res.status_code == 200
    assert "railway_url" not in res.json()


def test_hand_edited_bad_settings_fall_back_to_defaults_per_key():
    settings_store.SETTINGS_FILE.write_text(json.dumps({
        "aim_device_ip": "not an ip", "aim_device_port": "lots", "aim_wifi_ssid": "Mine",
    }))
    loaded = settings_store.load()
    assert loaded["aim_device_ip"] == settings_store.DEFAULTS["aim_device_ip"]
    assert loaded["aim_device_port"] == settings_store.DEFAULTS["aim_device_port"]
    assert loaded["aim_wifi_ssid"] == "Mine"


# ─── Upload ──────────────────────────────────────────────────────────────────


def test_upload_over_the_size_limit_is_rejected_and_nothing_is_left_on_disk(monkeypatch):
    monkeypatch.setattr(analysis, "MAX_UPLOAD_BYTES", 1024)
    res = client.post("/api/upload", files={"file": ("big.xrk", b"\0" * 4096, "application/octet-stream")})
    assert res.status_code == 413
    assert not any(session_store.SESSIONS_DIR.iterdir())


def test_upload_log_records_a_cleaned_bounded_filename():
    raw = "evil\n\x1b[31m" + "x" * 1000 + ".exe"
    res = client.post("/api/upload", files={"file": (raw, b"data", "application/octet-stream")})
    assert res.status_code == 400
    logged = client.get("/api/uploads/log").json()["entries"][0]["filename"]
    assert "\n" not in logged and "\x1b" not in logged
    assert len(logged) <= 255


# ─── Rename ──────────────────────────────────────────────────────────────────


def _make_session(name="run1.xrk"):
    path = session_store.session_file_path(name)
    path.write_bytes(b"xrk")
    return session_store.add_session(filename=name, source="manual_upload", local_path=str(path))


@pytest.mark.parametrize("bad", ["", "   ", "..", ".hidden", "\x00\x01"])
def test_rename_rejects_unusable_names(bad):
    entry = _make_session()
    res = client.post(f"/api/sessions/{entry['id']}/rename", json={"filename": bad})
    assert res.status_code == 400
    assert session_store.get_session(entry["id"])["filename"] == "run1.xrk"


def test_rename_rejects_non_string_filename():
    entry = _make_session()
    res = client.post(f"/api/sessions/{entry['id']}/rename", json={"filename": 5})
    assert res.status_code == 422


def test_rename_traversal_and_reserved_names_stay_inside_sessions_dir():
    entry = _make_session()
    res = client.post(f"/api/sessions/{entry['id']}/rename", json={"filename": "../../CON"})
    assert res.status_code == 200
    assert res.json()["filename"] == "_CON.xrk"
    assert (session_store.SESSIONS_DIR / "_CON.xrk").is_file()


def test_rename_rejects_absurdly_long_input():
    entry = _make_session()
    res = client.post(f"/api/sessions/{entry['id']}/rename", json={"filename": "x" * 10_000})
    assert res.status_code == 400


# ─── Export ──────────────────────────────────────────────────────────────────


class _FakeLog:
    """Just enough of a parsed log for /api/export."""

    def __init__(self, channels):
        self.channels = channels
        self.metadata = {}
        self.laps = None


def _channel_table(name, units=""):
    import pyarrow as pa

    field = pa.field(name, pa.float64(), metadata={b"units": units.encode()} if units else None)
    return pa.table(
        [pa.array([0, 100, 200], pa.int64()), pa.array([1.0, 2.0, 3.0])],
        schema=pa.schema([pa.field("timecodes", pa.int64()), field]),
    )


@pytest.fixture
def loaded_formula_session():
    from state import state

    name = "=HYPERLINK(\"http://evil\")"  # no comma: ?channels= is comma-separated
    state.log = _FakeLog({name: _channel_table(name, units="@cmd"), "RPM": _channel_table("RPM")})
    state.filename = "run.xrk"
    state.session_id = "s1"
    return name


def _export_rows(res):
    assert res.status_code == 200, res.text
    return list(csv.reader(io.StringIO(res.text)))


def test_export_neutralises_formula_channel_names(loaded_formula_session):
    res = client.get("/api/export", params={"channels": f"{loaded_formula_session},RPM"})
    header = _export_rows(res)[0]
    assert header[0] == "Time (s)"
    assert all(not cell.startswith(("=", "+", "-", "@")) for cell in header)
    assert header[1] == "'=HYPERLINK(\"http://evil\") (@cmd)"


def test_export_cleans_units_from_the_convert_param(loaded_formula_session):
    convert = json.dumps({"RPM": {"unit": "=1+1\n" + "x" * 100, "scale": 2, "offset": 0}})
    header = _export_rows(client.get("/api/export", params={"channels": "RPM", "convert": convert}))[0]
    assert "\n" not in header[1]
    assert header[1].startswith("RPM (=1+1")  # mid-cell '=' is inert
    assert len(header[1]) <= len("RPM ()") + 32


@pytest.mark.parametrize("scale", ["NaN", "Infinity", "-Infinity"])
def test_export_rejects_non_finite_conversions(loaded_formula_session, scale):
    convert = '{"RPM": {"unit": "x", "scale": %s}}' % scale
    res = client.get("/api/export", params={"channels": "RPM", "convert": convert})
    assert res.status_code == 400


def test_export_numeric_cells_are_not_prefixed(loaded_formula_session):
    convert = json.dumps({"RPM": {"unit": "x", "scale": -1, "offset": 0}})
    rows = _export_rows(client.get("/api/export", params={"channels": "RPM", "convert": convert}))
    assert rows[1][1] == "-1.00000"


# ─── Derived channels ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "channels",
    [
        [],
        {"RPM": [1, 2, 3]},
        {"RPM": {"timestamps": [0, 1]}},
        {"RPM": {"timestamps": [0, 1], "values": [1]}},
    ],
)
def test_derived_rejects_malformed_channel_payloads(channels):
    res = client.post("/api/derived/evaluate", json={"expression": "result = None", "channels": channels})
    assert res.status_code in (400, 422)


def test_derived_skips_non_numeric_result_timestamps_instead_of_500():
    res = client.post(
        "/api/derived/evaluate",
        json={
            "expression": "result = {'timestamps': ['a', 1, None], 'values': [1, 2, 3]}",
            "channels": {},
        },
    )
    assert res.status_code == 200
    assert res.json() == {"timestamps": [1.0], "values": [2.0]}


@pytest.mark.parametrize("bad_result", ["5", "'abc'", "None"])
def test_derived_rejects_scalar_result_arrays_instead_of_500(bad_result):
    res = client.post(
        "/api/derived/evaluate",
        json={"expression": f"result = {{'timestamps': {bad_result}, 'values': [1]}}", "channels": {}},
    )
    assert res.status_code == 400


# ─── Live layouts ────────────────────────────────────────────────────────────


def _layout(layout_id="layout-1234abcd", **overrides):
    return {"id": layout_id, "name": "Pit wall", "vehicle": "ev", "widgets": [], **overrides}


@pytest.mark.parametrize("bad_id", ["a b", "<img>", "x" * 65, "id%0A"])
def test_layout_put_rejects_bad_ids(bad_id):
    res = client.put(f"/api/live/layouts/{bad_id}", json=_layout(bad_id))
    assert res.status_code == 400
    assert live_layout_store.load()["layouts"] == []


def test_layout_name_is_cleaned_and_bounded():
    res = client.put("/api/live/layouts/layout-1", json=_layout("layout-1", name=" Pit\x00 wall\n "))
    assert res.status_code == 200
    assert res.json()["name"] == "Pit wall"

    res = client.put("/api/live/layouts/layout-2", json=_layout("layout-2", name="x" * 500))
    assert res.status_code == 400


def test_layout_name_that_is_only_control_characters_is_rejected():
    res = client.put("/api/live/layouts/layout-1", json=_layout("layout-1", name="\x00\n\t"))
    assert res.status_code == 400


def test_layout_selection_ignores_invalid_ids():
    client.put("/api/live/layout-selection", json={"pinned": "layout-1"})
    sel = client.put(
        "/api/live/layout-selection",
        json={"active": {"ev": "../evil", "ic": "layout-2"}, "pinned": "x" * 500, "last_used": "layout-3"},
    ).json()
    assert sel["active"] == {"ic": "layout-2"}
    assert sel["pinned"] == "layout-1"  # bad value ignored, old value kept
    assert sel["last_used"] == "layout-3"
