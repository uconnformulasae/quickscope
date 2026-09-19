"""Session LRU cache for parsed logs."""

from pathlib import Path

from services.session_cache import SessionCache


def test_lru_evicts_oldest(tmp_path):
    cache = SessionCache(max_entries=2)
    f1 = tmp_path / "a.xrk"
    f2 = tmp_path / "b.xrk"
    f3 = tmp_path / "c.xrk"
    for f in (f1, f2, f3):
        f.write_bytes(b"x")

    cache.put("a", object(), "a.xrk", f1)
    cache.put("b", object(), "b.xrk", f2)
    cache.get("a")  # touch a
    cache.put("c", object(), "c.xrk", f3)

    assert cache.get("b") is None
    assert cache.get("a") is not None
    assert cache.get("c") is not None


def test_get_valid_invalidates_on_file_change(tmp_path):
    cache = SessionCache()
    xrk = tmp_path / "lap.xrk"
    xrk.write_bytes(b"v1")
    sentinel = object()
    cache.put("id1", sentinel, "lap.xrk", xrk)

    assert cache.get_valid("id1", xrk) is not None

    xrk.write_bytes(b"v2-changed")
    assert cache.get_valid("id1", xrk) is None
    assert cache.get("id1") is None
