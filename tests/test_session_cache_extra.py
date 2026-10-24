"""Edge cases for the session LRU beyond the basic eviction test."""

from __future__ import annotations

from services.session_cache import SessionCache


def test_active_id_cleared_when_active_entry_evicted_by_lru(tmp_path):
    cache = SessionCache(max_entries=1)
    cache.put("a", object(), "a.xrk")
    cache.set_active("a")
    cache.put("b", object(), "b.xrk")
    assert cache.active_id is None
    assert cache.keys() == ["b"]


def test_get_or_load_parses_once_per_file_version(tmp_path):
    cache = SessionCache()
    f = tmp_path / "a.xrk"
    f.write_bytes(b"v1")
    calls = []

    def loader():
        calls.append(1)
        return object()

    first = cache.get_or_load("a", f, loader)
    assert cache.get_or_load("a", f, loader) is first
    assert len(calls) == 1

    f.write_bytes(b"v2-longer")
    assert cache.get_or_load("a", f, loader) is not first
    assert len(calls) == 2


def test_get_valid_for_deleted_file_evicts_and_deactivates(tmp_path):
    cache = SessionCache()
    f = tmp_path / "a.xrk"
    f.write_bytes(b"x")
    cache.put("a", object(), "a.xrk", f)
    cache.set_active("a")
    f.unlink()
    assert cache.get_valid("a", f) is None
    assert cache.active_id is None


def test_rebind_file_attaches_fingerprint_and_updates_name(tmp_path):
    cache = SessionCache()
    f = tmp_path / "a.xrk"
    f.write_bytes(b"x")
    sentinel = object()
    cache.put("a", sentinel, "old.xrk")  # no fingerprint yet
    assert cache.get_valid("a", f) is None  # would evict; re-put for the next step
    cache.put("a", sentinel, "old.xrk")
    cache.rebind_file("a", f, "new.xrk")
    assert cache.get_valid("a", f) == (sentinel, "new.xrk")


def test_rebind_unknown_id_is_a_noop(tmp_path):
    f = tmp_path / "a.xrk"
    f.write_bytes(b"x")
    cache = SessionCache()
    cache.rebind_file("ghost", f)
    assert cache.keys() == []


def test_clear_and_evict():
    cache = SessionCache()
    cache.put("a", object(), "a")
    cache.put("b", object(), "b")
    cache.set_active("a")
    cache.evict("a")
    assert cache.keys() == ["b"] and cache.active_id is None
    cache.clear()
    assert cache.keys() == []
