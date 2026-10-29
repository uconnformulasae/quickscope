"""
User live-dashboard layouts, persisted in ./data/live_layouts.json.

Layouts are stored as opaque JSON: the frontend owns the widget schema
(client/src/components/live/layout-schema.ts) and validates on load, so
this module only checks what it needs to index and bound the file.
Built-in layouts live in the client and are never written here.
"""

import json
import os
import threading
import time
from pathlib import Path

_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR = Path(os.environ.get("QUICKSCOPE_DATA_DIR", _DEFAULT_DATA_DIR))
LAYOUTS_FILE = DATA_DIR / "live_layouts.json"

MAX_LAYOUT_BYTES = 256 * 1024
MAX_LAYOUTS = 200
VEHICLES = ("ev", "ic")

_lock = threading.Lock()


class LayoutError(ValueError):
    """Layout rejected (bad shape or too large); message is user-visible."""


def _empty() -> dict:
    return {
        "layouts": [],
        "selection": {"active": {}, "pinned": None, "last_used": None},
    }


def _load_unlocked() -> dict:
    path = LAYOUTS_FILE
    if not path.exists():
        return _empty()
    try:
        with open(path, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("layouts"), list):
            raise ValueError("live layouts file has the wrong shape")
    except (ValueError, UnicodeDecodeError):
        # Keep the unreadable file for recovery and start fresh.
        try:
            os.replace(path, path.with_name(f"{path.name}.{int(time.time())}.corrupt"))
        except OSError:
            pass
        return _empty()
    sel = data.get("selection") if isinstance(data.get("selection"), dict) else {}
    active = sel.get("active") if isinstance(sel.get("active"), dict) else {}
    return {
        "layouts": [l for l in data["layouts"] if isinstance(l, dict) and isinstance(l.get("id"), str)],
        "selection": {
            "active": {k: v for k, v in active.items() if k in VEHICLES and isinstance(v, str)},
            "pinned": sel.get("pinned") if isinstance(sel.get("pinned"), str) else None,
            "last_used": sel.get("last_used") if isinstance(sel.get("last_used"), str) else None,
        },
    }


def _save_unlocked(data: dict) -> None:
    path = LAYOUTS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # atomic: a crash mid-write can't leave a truncated file


def load() -> dict:
    with _lock:
        return _load_unlocked()


def _check_layout(layout_id: str, layout: object) -> dict:
    if not isinstance(layout, dict):
        raise LayoutError("Layout must be a JSON object")
    if layout.get("id") != layout_id:
        raise LayoutError("Layout id does not match the URL")
    if layout_id.startswith("builtin-"):
        raise LayoutError("Built-in layouts can't be overwritten; save a copy instead")
    if not isinstance(layout.get("name"), str) or not layout["name"].strip():
        raise LayoutError("Layout needs a name")
    if layout.get("vehicle") not in VEHICLES:
        raise LayoutError('Layout vehicle must be "ev" or "ic"')
    if not isinstance(layout.get("widgets"), list):
        raise LayoutError("Layout needs a widgets list")
    if len(json.dumps(layout)) > MAX_LAYOUT_BYTES:
        raise LayoutError(f"Layout is larger than {MAX_LAYOUT_BYTES // 1024} KB")
    return layout


def put_layout(layout_id: str, layout: object) -> dict:
    layout = _check_layout(layout_id, layout)
    with _lock:
        data = _load_unlocked()
        idx = next((i for i, l in enumerate(data["layouts"]) if l["id"] == layout_id), None)
        if idx is None:
            if len(data["layouts"]) >= MAX_LAYOUTS:
                raise LayoutError(f"Too many saved layouts (max {MAX_LAYOUTS})")
            data["layouts"].append(layout)
        else:
            data["layouts"][idx] = layout
        _save_unlocked(data)
        return layout


def delete_layout(layout_id: str) -> bool:
    with _lock:
        data = _load_unlocked()
        before = len(data["layouts"])
        data["layouts"] = [l for l in data["layouts"] if l["id"] != layout_id]
        if len(data["layouts"]) == before:
            return False
        # Don't leave the selection pointing at a layout that no longer exists.
        sel = data["selection"]
        sel["active"] = {k: v for k, v in sel["active"].items() if v != layout_id}
        if sel["pinned"] == layout_id:
            sel["pinned"] = None
        if sel["last_used"] == layout_id:
            sel["last_used"] = None
        _save_unlocked(data)
        return True


def update_selection(partial: dict) -> dict:
    with _lock:
        data = _load_unlocked()
        sel = data["selection"]
        if isinstance(partial.get("active"), dict):
            sel["active"] = {
                k: v for k, v in partial["active"].items() if k in VEHICLES and isinstance(v, str)
            }
        for key in ("pinned", "last_used"):
            if key in partial and (partial[key] is None or isinstance(partial[key], str)):
                sel[key] = partial[key]
        _save_unlocked(data)
        return sel
