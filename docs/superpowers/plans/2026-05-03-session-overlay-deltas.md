# Multi-Session Overlay & Deltas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the user to load up to N sessions onto the QuickScope `TelemetryChart`, with one designated as the **primary** and the rest as **overlays**. Channels visible in the primary are also drawn for each overlay (matched by `shortName`), in the same hue but with a distinguishing dash pattern. The cursor reads values across all sessions, and the delta panel shows pairwise differences (primary vs each overlay). Within-session A/B delta cursoring continues to work orthogonally.

**Architecture:**
- **Backend:** Replace the singleton `state.log` with a per-id LRU cache of parsed `aim_xrk` logs (cap = 4). Existing routes keep operating on an "active" entry (the most recently `/load`ed). New endpoints accept `?session_id=` to read other entries without disturbing the active. CLAUDE.md §12 invariant is updated to reflect the change.
- **Frontend state:** Extend `AppState` with an `overlays: OverlayState[]` array carrying parsed metadata, samples Map, lap markers, and per-overlay alignment configuration. The chart receives the primary `XRKSession` plus a parallel `overlays` prop.
- **Chart rendering:** `TelemetryChart` and `chart-draw.ts` learn about overlays. For each visible primary channel, every overlay that has a same-`shortName` channel produces an additional trace drawn in the same color but with a `setLineDash` pattern keyed by overlay index (overlay #1 dashed, #2 dotted, #3 dash-dot, beyond → solid+slight tint with a perf warning). Each overlay's samples are time-shifted by its computed alignment offset before pixel mapping.
- **Cursor + delta panel:** One cursor x-position is shared across all sessions. The delta panel becomes denser: per channel, columns for primary + each overlay value at the cursor, plus a Δ column for each overlay vs primary. If the user has placed cursor B (within-session A/B mode), each cell duplicates into A-row / B-row groups.
- **Entry point:** `SessionBrowser` gains multi-select (Shift-click / Cmd-click on rows + a checkbox column). The Load button becomes "Load 1 + N overlays". A small toolbar indicator inside the chart view ("Overlays: 2 ▾") opens a popover for toggle/realign/remove.

**Tech Stack:** TypeScript, React, FastAPI/Python, Canvas2D. No new runtime dependencies.

---

## Pre-flight notes for the implementer

- **Worktree:** This plan is executed in `/Users/manthan/Documents/development/quickscope-session-overlay-deltas/` on branch `feature/session-overlay-deltas`. Never run git commands against `/Users/manthan/Documents/development/quickscope/` — that's a different teammate's checkout.
- **Bash cwd does not persist** between tool invocations. Every command in this plan uses absolute paths.
- **No test framework exists** in this repo. CLAUDE.md §11 prescribes `npm run check` (tsc) for code correctness and manual browser testing for UI. Where a small Python ad-hoc check is the cheapest way to verify pure logic, this plan uses `python3 -c "..."` smoke runs from the backend dir; **do not** introduce pytest.
- **Backend dev:** `./start.sh` from the repo root — Python on `:8000`, Vite on `:5000`. Check `:5000` in browser. Note: only ONE teammate at a time can run `./start.sh` (shared ports). If someone else's dev server is up, kill it or coordinate via `team-lead`.
- **Type hygiene:** `npm run check` is the gate. Fix all errors before commit. No `any`.
- **Commits:** Imperative subject. **No `Co-Authored-By: Claude` line** (CLAUDE.md §10).
- **Performance discipline (CLAUDE.md §6.6) is non-negotiable.** Never `setState` from a mouse-move handler. Use refs for transient state. Always set `needsDrawRef.current = true` when something changes.

---

## File Structure

### Backend (new files)
- `backend/services/session_cache.py` — `SessionCache` class: per-id LRU cache of parsed `aim_xrk` logs. Module-level singleton `session_cache`. Used by routes.

### Backend (modified files)
- `backend/state.py` — `SessionState` becomes a thin facade over `session_cache` for "active" id. Adds `get_log(session_id)` resolver used by new endpoints.
- `backend/routes/sessions.py` — `/sessions/{id}/load` warms cache and sets active.
- `backend/routes/analysis.py` — adds `/sessions/{id}/data`, `/sessions/{id}/channels`, `/sessions/{id}/laps`, `/sessions/{id}/info` for overlay reads. Existing endpoints unchanged.
- `CLAUDE.md` — update §5.2, §12, §15 to reflect the cache.

### Frontend (new files)
- `client/src/lib/overlay-types.ts` — `OverlayAlignment`, `OverlayState`, `OverlaySamples` types.
- `client/src/lib/overlay-alignment.ts` — pure helpers: `computeAlignmentOffsetMs(...)`, `applyOffset(samples, offsetMs)`.
- `client/src/components/OverlayPopover.tsx` — small popover showing overlay list with toggle/realign/remove controls.
- `client/src/components/OverlayPicker.tsx` — multi-select state for `SessionBrowser` (extracted to reduce SessionBrowser growth).

### Frontend (modified files)
- `client/src/lib/api.ts` — add `fetchSessionInfo(id)`, `fetchSessionChannelData(id, names)`, `fetchSessionLaps(id)`.
- `client/src/lib/useXRKStore.ts` — add `overlays`, `addOverlay`, `removeOverlay`, `toggleOverlayVisibility`, `updateOverlayAlignment` to `AppState`.
- `client/src/lib/chart-utils.ts` — extend `DrawContext` with `overlays`. Add `OverlayDrawData` interface.
- `client/src/lib/chart-draw.ts` — `drawStrips` draws one trace per (channel × overlay), each with its `setLineDash` pattern and time offset.
- `client/src/lib/chart-cursors.ts` — delta panel rendering rewritten to handle multi-session columns.
- `client/src/components/TelemetryChart.tsx` — accept `overlays` prop, thread into `DrawContext`. Toolbar gets "Overlays: N ▾" indicator that opens `OverlayPopover`.
- `client/src/components/SessionBrowser.tsx` — multi-select rows with checkboxes; "Load" button respects multi-select.
- `client/src/App.tsx` — wire the `overlays` flow end-to-end.

---

## Phase 1 — Backend cache

### Task 1.1: Create `SessionCache` with LRU semantics

**Files:**
- Create: `backend/services/session_cache.py`

- [ ] **Step 1: Write the cache module**

```python
# backend/services/session_cache.py
"""Per-id LRU cache of parsed aim_xrk logs.

Replaces the prior single-session model in state.SessionState. Sessions are
keyed by session_id (UUID from session_store). When the cache exceeds
MAX_ENTRIES, the least-recently-accessed entry is evicted. Thread-safe via
threading.Lock — callers may be FastAPI handlers (asyncio) but parses run in
asyncio.to_thread, so the lock is honest.

Usage:
    log = session_cache.get_or_load(session_id, lambda: parse_file(path))
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Callable, Optional


MAX_ENTRIES = 4


class SessionCache:
    def __init__(self, max_entries: int = MAX_ENTRIES):
        self._max = max_entries
        self._lock = threading.Lock()
        # OrderedDict: most-recently-used at the end
        self._entries: "OrderedDict[str, tuple[object, str]]" = OrderedDict()
        # Active id (the session whose data the legacy non-id endpoints read)
        self._active_id: Optional[str] = None

    @property
    def active_id(self) -> Optional[str]:
        with self._lock:
            return self._active_id

    def set_active(self, session_id: str) -> None:
        with self._lock:
            if session_id in self._entries:
                # Bump to MRU
                self._entries.move_to_end(session_id)
            self._active_id = session_id

    def clear_active(self) -> None:
        with self._lock:
            self._active_id = None

    def get(self, session_id: str) -> Optional[tuple[object, str]]:
        """Return (log, filename) for session_id without parsing. Bumps MRU."""
        with self._lock:
            entry = self._entries.get(session_id)
            if entry is not None:
                self._entries.move_to_end(session_id)
            return entry

    def put(self, session_id: str, log: object, filename: str) -> None:
        with self._lock:
            self._entries[session_id] = (log, filename)
            self._entries.move_to_end(session_id)
            while len(self._entries) > self._max:
                evicted_id, _ = self._entries.popitem(last=False)
                if evicted_id == self._active_id:
                    self._active_id = None

    def evict(self, session_id: str) -> None:
        with self._lock:
            self._entries.pop(session_id, None)
            if self._active_id == session_id:
                self._active_id = None

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._active_id = None

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._entries.keys())


session_cache = SessionCache()
```

- [ ] **Step 2: Smoke-test the cache logic**

Run from the worktree's `backend/` directory:

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas/backend && python3 -c "
from services.session_cache import SessionCache
c = SessionCache(max_entries=3)
c.put('a', 'log_a', 'a.xrk'); c.put('b', 'log_b', 'b.xrk'); c.put('c', 'log_c', 'c.xrk')
assert c.keys() == ['a', 'b', 'c'], c.keys()
c.get('a')  # bumps a to MRU
c.put('d', 'log_d', 'd.xrk')  # evicts b (LRU)
assert c.keys() == ['c', 'a', 'd'], c.keys()
c.set_active('a')
assert c.active_id == 'a'
c.evict('a')
assert c.active_id is None
assert c.keys() == ['c', 'd']
print('OK')
"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add backend/services/session_cache.py && git commit -m "Add per-id LRU SessionCache for parsed XRK logs

Replaces the implicit assumption that one log lives in state.SessionState
with an explicit, bounded cache. The next commit rewires SessionState as a
thin facade over the cache so existing endpoints continue to work."
```

---

### Task 1.2: Make `SessionState` a facade over `session_cache`

**Files:**
- Modify: `backend/state.py`

- [ ] **Step 1: Replace `SessionState` and add resolver**

Replace lines 28-46 of `backend/state.py` (the `class SessionState` block and the `state = SessionState()` line) with:

```python
# ─── In-memory state (active session for analysis) ──────────────────────────
#
# History note: prior versions of QuickScope kept exactly one parsed XRK in
# memory at a time on `state.log`. With the multi-session overlay feature,
# that became too restrictive; we now hold up to MAX_ENTRIES parsed logs in
# session_cache, and SessionState is a thin facade over it that tracks which
# entry is the "active" one for the legacy (no-id) endpoints. New endpoints
# accept a session_id query param to read non-active entries.
from services.session_cache import session_cache


class SessionState:
    """Facade exposing the active log on the cache as `state.log`.

    Existing routes (/api/data, /api/channels, /api/laps, /api/gps, /api/export,
    /api/derived/evaluate) read state.log unchanged. /sessions/{id}/load sets
    the active id; uploads also set it.
    """

    @property
    def log(self):
        sid = session_cache.active_id
        if sid is None:
            return None
        entry = session_cache.get(sid)
        return entry[0] if entry else None

    @log.setter
    def log(self, value):
        # Legacy callers still write to state.log directly (e.g. upload route
        # before the session_id is known). Park the log under a synthetic id;
        # the upload handler is responsible for replacing it once it has a
        # real session_id from session_store.
        if value is None:
            session_cache.clear_active()
            return
        # Use existing active id if any, otherwise stash under "__pending__".
        sid = session_cache.active_id or "__pending__"
        session_cache.put(sid, value, self._filename or "")
        session_cache.set_active(sid)

    @property
    def filename(self):
        sid = session_cache.active_id
        if sid is None:
            return self._filename
        entry = session_cache.get(sid)
        return entry[1] if entry else self._filename

    @filename.setter
    def filename(self, value):
        self._filename = value

    @property
    def session_id(self):
        return session_cache.active_id

    @session_id.setter
    def session_id(self, value):
        if value is None:
            session_cache.clear_active()
        else:
            # Promote pending log to the real id if it exists
            pending = session_cache.get("__pending__")
            if pending is not None and value != "__pending__":
                log, fn = pending
                session_cache.evict("__pending__")
                session_cache.put(value, log, fn)
            session_cache.set_active(value)

    def __init__(self):
        self._filename = None

    def clear(self):
        sid = session_cache.active_id
        if sid is not None:
            session_cache.evict(sid)
        session_cache.evict("__pending__")
        self._filename = None

    @property
    def loaded(self) -> bool:
        return self.log is not None


state = SessionState()


def get_log(session_id: str | None):
    """Resolve a session_id to its parsed log, or None.

    Used by the new overlay endpoints. Does not change the active session.
    """
    if not session_id:
        return state.log
    entry = session_cache.get(session_id)
    return entry[0] if entry else None
```

- [ ] **Step 2: Verify backend still imports cleanly**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas/backend && python3 -c "
from state import state, get_log
assert state.log is None
assert state.loaded is False
state.filename = 'foo.xrk'
state.log = 'fake_log'
assert state.log == 'fake_log', state.log
assert state.loaded
state.session_id = 'real-uuid-1'
assert state.log == 'fake_log'  # promoted from __pending__
assert get_log('real-uuid-1') == 'fake_log'
assert get_log(None) == 'fake_log'
assert get_log('nonexistent') is None
state.clear()
assert state.log is None
print('OK')
"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add backend/state.py && git commit -m "SessionState becomes facade over session_cache

state.log/filename/session_id now read from the active entry in
session_cache. Existing routes are unchanged: they still touch state.log,
which transparently resolves the active log on the cache. A new get_log()
resolver lets the overlay endpoints in a later commit read non-active logs."
```

---

### Task 1.3: Wire `/sessions/{id}/load` to populate the cache

**Files:**
- Modify: `backend/routes/sessions.py:25-45`

- [ ] **Step 1: Replace the load handler**

Replace the `load_session` function in `backend/routes/sessions.py` (lines 25-45):

```python
@router.post("/sessions/{session_id}/load")
async def load_session(session_id: str):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    local_path = entry.get("local_path")
    if not local_path or not Path(local_path).exists():
        raise HTTPException(400, "Session file not available locally. Pull it first.")

    # If we already have this session in cache, just promote it to active
    from services.session_cache import session_cache
    cached = session_cache.get(session_id)
    if cached is not None:
        session_cache.set_active(session_id)
        log, _ = cached
        return extract_session_info(log, entry["filename"])

    try:
        log = await asyncio.to_thread(parse_file, local_path)
    except Exception:
        logger.exception("Failed to parse session file")
        raise HTTPException(500, "Failed to parse session file")

    session_cache.put(session_id, log, entry["filename"])
    session_cache.set_active(session_id)
    state._filename = entry["filename"]
    return extract_session_info(log, entry["filename"])
```

(Note: `parse_file` is already imported via `from state import ... parse_file ...` at the top of `sessions.py`. `asyncio` is imported at line 3.)

- [ ] **Step 2: Verify `npm run check` still passes (sanity for the chain)**

Skip — this is Python only. Move on.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add backend/routes/sessions.py && git commit -m "Load endpoint warms session_cache and avoids re-parsing

A second click on the same session in SessionBrowser now reuses the cached
parse instead of re-reading the file. Same behavior for users; faster, and
crucially leaves any other cached sessions alone (necessary for overlay to
load multiple sessions without evicting the primary)."
```

---

### Task 1.4: Add overlay-read endpoints

**Files:**
- Modify: `backend/routes/analysis.py` — add 4 new handlers after `/data` (around line 145)

- [ ] **Step 1: Add the four endpoints**

After the existing `/api/data` handler in `backend/routes/analysis.py` (after line 145), add:

```python
# ─── Per-session overlay reads (do NOT change active state) ─────────────────


def _resolve_log(session_id: str):
    """Resolve session_id → parsed log, parsing on cache miss. Does not change active."""
    from services.session_cache import session_cache

    entry = session_cache.get(session_id)
    if entry is not None:
        return entry[0], entry[1]

    record = session_store.get_session(session_id)
    if not record:
        raise HTTPException(404, "Session not found")
    local_path = record.get("local_path")
    if not local_path:
        raise HTTPException(400, "Session file not available locally")
    try:
        log = parse_file(local_path)
    except Exception:
        logger.exception("Failed to parse session %s", session_id)
        raise HTTPException(500, "Failed to parse session file")
    session_cache.put(session_id, log, record["filename"])
    return log, record["filename"]


@router.get("/sessions/{session_id}/info")
async def get_session_info(session_id: str):
    log, filename = await asyncio.to_thread(_resolve_log, session_id)
    return extract_session_info(log, filename)


@router.get("/sessions/{session_id}/channels")
async def get_session_channels(session_id: str):
    log, _ = await asyncio.to_thread(_resolve_log, session_id)
    channels = []
    for i, (name, table) in enumerate(sorted(log.channels.items())):
        cm = channel_meta(name, table)
        channels.append({
            "name": name,
            "units": cm["units"],
            "sampleCount": table.num_rows,
            "color": CHART_COLORS[i % len(CHART_COLORS)],
            "index": i,
        })
    return {"channels": channels}


@router.get("/sessions/{session_id}/data")
async def get_session_channel_data(session_id: str, channels: str = Query(...)):
    log, _ = await asyncio.to_thread(_resolve_log, session_id)
    names = [n.strip() for n in channels.split(",") if n.strip()]
    result = {}
    for name in names:
        if name in log.channels:
            result[name] = channel_data(name, log.channels[name])
    return result


@router.get("/sessions/{session_id}/laps")
async def get_session_laps(session_id: str):
    log, _ = await asyncio.to_thread(_resolve_log, session_id)

    def _channel_data(name: str):
        if name in log.channels:
            return channel_data(name, log.channels[name])
        return None

    laps, source = lap_detection.detect_laps(log, _channel_data)
    return {"laps": laps, "source": source}
```

Add `import asyncio` at the top of the file if it isn't there (check line 1-10; if missing, add `import asyncio` after `import time`).

- [ ] **Step 2: Verify imports resolve**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas/backend && python3 -c "
from routes import analysis
print(sorted(r.path for r in analysis.router.routes))
"
```

Expected output includes:
```
['/api/channels', '/api/data', '/api/derived/evaluate', '/api/export', '/api/gps', '/api/laps', '/api/sessions/{session_id}/channels', '/api/sessions/{session_id}/data', '/api/sessions/{session_id}/info', '/api/sessions/{session_id}/laps', '/api/upload', '/api/uploads/log']`
```
(Order may vary; the four new `/api/sessions/{session_id}/...` routes must appear.)

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add backend/routes/analysis.py && git commit -m "Add per-session overlay-read endpoints

GET /api/sessions/{id}/info, /channels, /data, /laps mirror the existing
non-id endpoints but operate on a specified session via session_cache,
without disturbing the active session. Used by the frontend overlay layer
to fetch metadata and samples for non-primary sessions."
```

---

### Task 1.5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — §5.2, §12, §15

- [ ] **Step 1: Update §5.2 (Singleton session state)**

In `CLAUDE.md`, find the §5.2 block beginning with `### 5.2 Singleton session state (`state.py`)` and replace its body (the `class SessionState` excerpt and the paragraph below it) with:

```markdown
### 5.2 Per-id LRU session cache (`state.py` + `services/session_cache.py`)

```python
class SessionCache:
    def get(session_id) -> (log, filename) | None
    def put(session_id, log, filename)
    def set_active(session_id)
    @property active_id

session_cache = SessionCache(max_entries=4)
```

The backend keeps **up to four parsed sessions in memory** simultaneously
(driven by the multi-session overlay feature). One is the **active** session;
existing routes (`/api/data`, `/api/channels`, `/api/laps`, `/api/gps`,
`/api/export`, `/api/derived/evaluate`) all operate on the active log via
`state.log`, which is now a property that reads `session_cache.active_id`.
New per-id routes (`/sessions/{id}/info`, `/data`, `/channels`, `/laps`) read
non-active entries without disturbing the active. LRU eviction kicks in past
four entries.
```

- [ ] **Step 2: Update §12 (Gotchas)**

In §12, replace the bullet starting with `**Single backend session**:` with:

```markdown
- **Bounded multi-session cache**: Up to 4 parsed XRK logs live in `session_cache`.
  One is the "active" session; the legacy non-id endpoints read it via the
  `state.log` facade. Per-id endpoints (`/sessions/{id}/info|data|channels|laps`)
  exist for the overlay feature. LRU eviction at 5+. Use `session_cache.get()`
  for reads that should not disturb the active id.
```

- [ ] **Step 3: Update §15 (Where to look for things)**

In the §15 table, find the row `| Channel parsing / metadata | backend/state.py + backend/routes/analysis.py |` and add a new row above it:

```markdown
| Session cache (LRU)         | `backend/services/session_cache.py`                                    |
```

- [ ] **Step 4: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add CLAUDE.md && git commit -m "CLAUDE.md: document session_cache and the per-id overlay endpoints

Updates §5.2 (replaces single-session SessionState description), §12 (gotchas),
and §15 (where to look for things)."
```

---

## Phase 2 — Frontend types + API + alignment helpers

### Task 2.1: Add overlay types

**Files:**
- Create: `client/src/lib/overlay-types.ts`

- [ ] **Step 1: Write the file**

```typescript
// client/src/lib/overlay-types.ts
import type { XRKSession, ChannelSample } from './xrk-parser';

/** How an overlay's timeline maps onto the primary's timeline. */
export type OverlayAlignment =
  | { kind: 'raw' }
  | { kind: 'lap'; primaryLap: number; overlayLap: number }
  | { kind: 'manual'; offsetMs: number };

export interface OverlayState {
  /** Backend session_id (UUID). Stable across reloads. */
  id: string;
  /** Display name (filename minus extension). */
  label: string;
  /** Parsed metadata + channel index. samples are lazy-loaded like the primary. */
  session: XRKSession;
  /** True when the user wants the overlay drawn. False = hidden but kept loaded. */
  visible: boolean;
  /** Time-alignment configuration. */
  alignment: OverlayAlignment;
  /** Samples cached client-side, keyed by primary's channelId
   *  (mapped via shortName-equality). Channels not present in the overlay
   *  simply have no entry. */
  samples: Map<number, ChannelSample[]>;
}

/** Map a primary channel id to the overlay's matching channel id (by shortName).
 *  Returns -1 if no match. */
export function findOverlayChannelId(
  primary: XRKSession,
  overlay: XRKSession,
  primaryChannelId: number,
): number {
  const primaryDef = primary.channels.get(primaryChannelId);
  if (!primaryDef) return -1;
  for (const [oid, odef] of overlay.channels) {
    if (odef.shortName === primaryDef.shortName) return oid;
  }
  return -1;
}

/** Returns true when the matched overlay channel has different units than primary. */
export function hasUnitsMismatch(
  primary: XRKSession,
  overlay: XRKSession,
  primaryChannelId: number,
): boolean {
  const oid = findOverlayChannelId(primary, overlay, primaryChannelId);
  if (oid === -1) return false;
  const pUnits = (primary.channels.get(primaryChannelId)?.units || '').trim();
  const oUnits = (overlay.channels.get(oid)?.units || '').trim();
  return pUnits !== oUnits;
}
```

- [ ] **Step 2: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/lib/overlay-types.ts && git commit -m "Add overlay-types: OverlayState, OverlayAlignment, channel-match helpers"
```

---

### Task 2.2: Add alignment helpers

**Files:**
- Create: `client/src/lib/overlay-alignment.ts`

- [ ] **Step 1: Write the helpers**

```typescript
// client/src/lib/overlay-alignment.ts
import type { ChannelSample, LapMarker, XRKSession } from './xrk-parser';
import type { OverlayAlignment } from './overlay-types';

/** Compute the time offset (ms) to add to overlay timestamps so they align
 *  with the primary's timeline.
 *
 *  - 'raw'    → 0
 *  - 'manual' → user-provided offset
 *  - 'lap'    → primary.lapMarkers[primaryLap].timestamp - overlay.lapMarkers[overlayLap].timestamp
 *
 *  Returns 0 if the alignment can't be resolved (e.g. lap index out of range). */
export function computeAlignmentOffsetMs(
  primary: XRKSession,
  overlay: XRKSession,
  alignment: OverlayAlignment,
): number {
  switch (alignment.kind) {
    case 'raw':
      return 0;
    case 'manual':
      return alignment.offsetMs;
    case 'lap': {
      const p = primary.lapMarkers[alignment.primaryLap];
      const o = overlay.lapMarkers[alignment.overlayLap];
      if (!p || !o) return 0;
      return p.timestamp - o.timestamp;
    }
  }
}

/** Index of the fastest lap (smallest end-start gap) in a session.
 *  Returns -1 if fewer than 2 lap markers (need start+end pair). */
export function fastestLapIndex(lapMarkers: LapMarker[]): number {
  if (lapMarkers.length < 2) return -1;
  let bestIdx = 0;
  let bestDur = Infinity;
  for (let i = 0; i + 1 < lapMarkers.length; i++) {
    const dur = lapMarkers[i + 1].timestamp - lapMarkers[i].timestamp;
    if (dur > 0 && dur < bestDur) { bestDur = dur; bestIdx = i; }
  }
  return bestIdx;
}

/** Default alignment: best-lap-aligned if both have ≥ 2 lap markers,
 *  else raw. */
export function defaultAlignment(
  primary: XRKSession,
  overlay: XRKSession,
): OverlayAlignment {
  const p = fastestLapIndex(primary.lapMarkers);
  const o = fastestLapIndex(overlay.lapMarkers);
  if (p === -1 || o === -1) return { kind: 'raw' };
  return { kind: 'lap', primaryLap: p, overlayLap: o };
}

/** Apply offset (ms) to every sample's timestamp. Allocates a new array;
 *  non-destructive. Returns the same reference if offset is zero
 *  (cheap fast-path for the common 'raw' case). */
export function applyOffset(samples: ChannelSample[], offsetMs: number): ChannelSample[] {
  if (offsetMs === 0 || samples.length === 0) return samples;
  const out = new Array<ChannelSample>(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = { timestamp: samples[i].timestamp + offsetMs, value: samples[i].value };
  }
  return out;
}
```

- [ ] **Step 2: Verify**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/lib/overlay-alignment.ts && git commit -m "Add overlay-alignment helpers (raw/manual/lap, fastest-lap default)"
```

---

### Task 2.3: Add API client functions

**Files:**
- Modify: `client/src/lib/api.ts` — append to the existing analysis section (after `fetchChannelData`, around line 322)

- [ ] **Step 1: Add the three functions**

Append to `client/src/lib/api.ts` (after the closing of `fetchChannelData`, approximately line 322 — just before `export async function fetchGPS()`):

```typescript
// ─── Per-session overlay reads (don't change active session) ────────────────

export async function fetchSessionInfo(sessionId: string): Promise<SessionInfo> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/info`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Session info failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchSessionChannelData(
  sessionId: string,
  channels: string[],
): Promise<Map<string, { timestamps: number[]; values: number[] }>> {
  if (channels.length === 0) return new Map();
  const res = await fetch(
    `${API_BASE}/api/sessions/${sessionId}/data?channels=${encodeURIComponent(channels.join(','))}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch session channel data: ${res.status}`);
  }
  const data: ChannelDataResponse = await res.json();
  const map = new Map<string, { timestamps: number[]; values: number[] }>();
  for (const [name, channelData] of Object.entries(data)) {
    map.set(name, channelData);
  }
  return map;
}

export async function fetchSessionLaps(sessionId: string): Promise<LapsResponse> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/laps`);
  if (!res.ok) throw new Error(`Failed to fetch session laps: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/lib/api.ts && git commit -m "API client: fetchSessionInfo/SessionChannelData/SessionLaps for overlays"
```

---

## Phase 3 — App state for overlays

### Task 3.1: Extend `useXRKStore` with overlay state

**Files:**
- Modify: `client/src/lib/useXRKStore.ts`

- [ ] **Step 1: Add the overlay slice**

Add to `client/src/lib/useXRKStore.ts`:

1. Imports near the top (after existing imports):

```typescript
import type { OverlayState, OverlayAlignment } from './overlay-types';
import { defaultAlignment } from './overlay-alignment';
import { fetchSessionInfo, fetchSessionChannelData, fetchSessionLaps } from './api';
import type { SessionInfo } from './api';
```

2. Add `overlays: OverlayState[];` to `AppState` (in the interface declaration around lines 36-73, anywhere after `derivedChannels: DerivedChannel[]`).

3. In `useAppState()`'s initial state object (around lines 201-221), add `overlays: [],` to the `useState<AppState>` initial.

4. Replace `setSession`'s body (around line 226-239) so it ALSO clears overlays:

```typescript
  const setSession = useCallback((session: XRKSession, fileName: string) => {
    setState(prev => ({
      ...prev,
      session,
      fileName,
      isLoading: false,
      loadError: null,
      parseProgress: null,
      activeChannels: [],
      derivedChannels: [],
      viewRange: null,
      overlays: [],
    }));
    setDerivedSamplesMap(new Map());
  }, []);
```

5. In `clearSession()` (around lines 328-340), add `overlays: [],` to the spread.

6. Add overlay actions before `return {` at the end of `useAppState()`:

```typescript
  // ─── Overlay actions ────────────────────────────────────────────────────

  const buildOverlaySession = useCallback(async (info: SessionInfo): Promise<XRKSession> => {
    const channels = new Map<number, ChannelDef>();
    for (const ch of info.channels) {
      channels.set(ch.index, {
        index: ch.index,
        shortName: ch.name,
        longName: ch.name,
        sampleRateRaw: ch.sampleRateHz > 0 ? Math.round(1e6 / ch.sampleRateHz) : 0,
        sampleRateHz: ch.sampleRateHz,
        units: ch.units,
        color: ch.color,
        fileSampleCount: ch.sampleCount,
      });
    }
    const samples = new Map<number, ChannelSample[]>();
    for (const ch of info.channels) samples.set(ch.index, []);
    return {
      metadata: {
        vehicle: info.metadata.vehicle || 'Unknown',
        driver: info.metadata.driver || 'Unknown',
        date: info.metadata.date || 'Unknown',
        time: info.metadata.time || 'Unknown',
        venue: info.metadata.venue || 'Unknown',
        championship: info.metadata.championship || 'Unknown',
        sessionType: info.metadata.sessionType || 'Unknown',
      },
      channels,
      samples,
      lapMarkers: [],
      lapSource: 'none',
      durationMs: info.durationMs,
      totalSamples: info.totalSamples,
    };
  }, []);

  const addOverlay = useCallback(async (
    sessionId: string,
    label: string,
  ): Promise<{ error: string } | { id: string }> => {
    const primary = state.session;
    if (!primary) return { error: 'Load a primary session first' };
    if (state.overlays.some(o => o.id === sessionId)) return { error: 'Already an overlay' };

    try {
      const info = await fetchSessionInfo(sessionId);
      const overlaySession = await buildOverlaySession(info);
      // Pull lap markers (best-effort; alignment fallback handles 'none')
      try {
        const laps = await fetchSessionLaps(sessionId);
        if (laps.laps.length > 0) {
          overlaySession.lapMarkers = laps.laps.map(l => ({
            timestamp: l.startTime, lapNumber: l.lapNumber,
          }));
          const last = laps.laps[laps.laps.length - 1];
          overlaySession.lapMarkers.push({ timestamp: last.endTime, lapNumber: last.lapNumber + 1 });
          overlaySession.lapSource = laps.source;
        }
      } catch { /* leave lapMarkers empty */ }

      const overlay: OverlayState = {
        id: sessionId,
        label,
        session: overlaySession,
        visible: true,
        alignment: defaultAlignment(primary, overlaySession),
        samples: new Map(),
      };
      setState(prev => ({ ...prev, overlays: [...prev.overlays, overlay] }));
      return { id: sessionId };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Failed to add overlay' };
    }
  }, [state.session, state.overlays, buildOverlaySession]);

  const removeOverlay = useCallback((sessionId: string) => {
    setState(prev => ({ ...prev, overlays: prev.overlays.filter(o => o.id !== sessionId) }));
  }, []);

  const toggleOverlayVisibility = useCallback((sessionId: string) => {
    setState(prev => ({
      ...prev,
      overlays: prev.overlays.map(o => o.id === sessionId ? { ...o, visible: !o.visible } : o),
    }));
  }, []);

  const updateOverlayAlignment = useCallback((sessionId: string, alignment: OverlayAlignment) => {
    setState(prev => ({
      ...prev,
      overlays: prev.overlays.map(o => o.id === sessionId ? { ...o, alignment } : o),
    }));
  }, []);

  /** Lazy-fetch overlay channel samples by primary channel id. Resolves by
   *  shortName equality. No-op if already present or no match. */
  const ensureOverlayChannelLoaded = useCallback(async (
    sessionId: string,
    primaryChannelId: number,
  ): Promise<void> => {
    const primary = state.session;
    if (!primary) return;
    const overlay = state.overlays.find(o => o.id === sessionId);
    if (!overlay) return;
    const primaryDef = primary.channels.get(primaryChannelId);
    if (!primaryDef) return;

    // Find matching overlay channel by shortName
    let overlayChId = -1;
    for (const [oid, odef] of overlay.session.channels) {
      if (odef.shortName === primaryDef.shortName) { overlayChId = oid; break; }
    }
    if (overlayChId === -1) return; // no match — silent
    if (overlay.samples.has(overlayChId) && overlay.samples.get(overlayChId)!.length > 0) return;

    try {
      const dataMap = await fetchSessionChannelData(sessionId, [primaryDef.shortName]);
      const data = dataMap.get(primaryDef.shortName);
      if (!data) return;
      const samples: ChannelSample[] = data.timestamps.map((t, i) => ({ timestamp: t, value: data.values[i] }));
      setState(prev => ({
        ...prev,
        overlays: prev.overlays.map(o => {
          if (o.id !== sessionId) return o;
          const next = new Map(o.samples);
          next.set(overlayChId, samples);
          return { ...o, samples: next };
        }),
      }));
    } catch (e) {
      console.error('Failed to fetch overlay channel data:', e);
    }
  }, [state.session, state.overlays]);
```

7. Add to the returned object at the end of `useAppState()`:

```typescript
    addOverlay,
    removeOverlay,
    toggleOverlayVisibility,
    updateOverlayAlignment,
    ensureOverlayChannelLoaded,
```

- [ ] **Step 2: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/lib/useXRKStore.ts && git commit -m "useXRKStore: add overlays state with add/remove/toggle/realign actions

Includes ensureOverlayChannelLoaded for lazy channel data fetching keyed by
shortName equality between primary and overlay sessions."
```

---

## Phase 4 — Chart rendering changes (the load-bearing part)

### Task 4.1: Extend `DrawContext` and add stroke-pattern helper

**Files:**
- Modify: `client/src/lib/chart-utils.ts`

- [ ] **Step 1: Add types**

In `client/src/lib/chart-utils.ts`, add after the existing imports (around line 6):

```typescript
import type { OverlayState } from './overlay-types';
```

Add a constant near the other constants (around line 87):

```typescript
/** setLineDash patterns by overlay index. Index 0 = primary (solid).
 *  Past 3 we run out of patterns and reuse solid+lighter — surfaces a
 *  perf warning to the user. */
export const OVERLAY_DASH_PATTERNS: number[][] = [
  [],            // primary: solid
  [8, 4],        // overlay #1: dashed
  [2, 4],        // overlay #2: dotted
  [8, 4, 2, 4],  // overlay #3: dash-dot
  [],            // overlay #4+: solid (with tint applied at draw)
];

export function dashForOverlayIndex(idx: number): number[] {
  return OVERLAY_DASH_PATTERNS[Math.min(idx, OVERLAY_DASH_PATTERNS.length - 1)];
}
```

Extend `DrawContext` (around line 32-52) by adding:

```typescript
  /** Visible overlays at draw time. Index 0 = first overlay (primary is implicit). */
  overlays: OverlayDrawData[];
```

Define `OverlayDrawData` after `DrawContext`:

```typescript
/** Per-overlay data prepared for the draw call. */
export interface OverlayDrawData {
  id: string;
  /** 1-indexed: overlay #1 → index 1, overlay #2 → index 2, etc.
   *  (Primary is implicit index 0.) */
  index: number;
  /** Time offset in ms applied to overlay timestamps before pixel mapping. */
  offsetMs: number;
  /** Per-primary-channelId, the overlay's matching channel samples (post-shift).
   *  Only populated for channels currently visible in the primary AND present
   *  in the overlay (matched by shortName). */
  samplesByPrimaryId: Map<number, import('./xrk-parser').ChannelSample[]>;
}
```

- [ ] **Step 2: Verify**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/lib/chart-utils.ts && git commit -m "chart-utils: add OverlayDrawData and dashForOverlayIndex helper"
```

---

### Task 4.2: Draw overlay traces in `chart-draw.ts`

**Files:**
- Modify: `client/src/lib/chart-draw.ts`

- [ ] **Step 1: Add overlay trace pass to `drawStrips`**

In `client/src/lib/chart-draw.ts`, find the line trace block in `drawStrips` (around line 178-191):

```typescript
    // Line trace
    if (ds.length > 1) {
      ctx.strokeStyle = strip.color;
      ctx.lineWidth = 2.0;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (const s of ds) {
        const x = dc.timeToX(s.timestamp / 1000, xRange, plotW);
        const y = valToY(s.value);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
```

After this block, add:

```typescript
    // Overlay traces — same channel id (matched), each with its own
    // dash pattern + time offset, drawn on the same Y-axis.
    if (dc.overlays.length > 0) {
      for (const ov of dc.overlays) {
        const ovSamples = ov.samplesByPrimaryId.get(strip.channelId);
        if (!ovSamples || ovSamples.length === 0) continue;
        // Visible-range filter (already applies the offset in samples)
        const ovVisible = dc.getVisibleSamples(strip.channelId, ovSamples, xRange, plotW);
        if (ovVisible.length < 2) continue;
        const ovDs = minMaxTrace(ovVisible, (tSec) => dc.timeToX(tSec, xRange, plotW), plotW);

        const dash = (await Promise.resolve(0), (await Promise.resolve(0))); // placeholder removed below
      }
    }
```

Wait — replace that whole block with the correct version:

```typescript
    // Overlay traces — same channel id (matched), each with its own
    // dash pattern + time offset, drawn on the same Y-axis as the primary.
    if (dc.overlays.length > 0) {
      for (const ov of dc.overlays) {
        const ovSamples = ov.samplesByPrimaryId.get(strip.channelId);
        if (!ovSamples || ovSamples.length === 0) continue;
        const ovVisible = dc.getVisibleSamples(strip.channelId, ovSamples, xRange, plotW);
        if (ovVisible.length < 2) continue;
        const ovDs = minMaxTrace(ovVisible, (tSec) => dc.timeToX(tSec, xRange, plotW), plotW);

        ctx.save();
        ctx.strokeStyle = ov.index >= 4 ? brightenColor(strip.color, 0.35) : strip.color;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = 'round';
        ctx.setLineDash(dashForOverlayIndex(ov.index));
        ctx.globalAlpha = ov.index >= 4 ? 0.7 : 1.0;
        ctx.beginPath();
        let started = false;
        for (const s of ovDs) {
          const x = dc.timeToX(s.timestamp / 1000, xRange, plotW);
          const y = valToY(s.value);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
```

- [ ] **Step 2: Update imports at the top of the file**

In the imports block (lines 5-11), change:

```typescript
import {
  MONO_FONT, AXIS_WIDTH,
  BOTTOM_AXIS_HEIGHT,
  niceAxisTicks, formatValue, formatTimeSec, clamp, brightenColor, minMaxTrace,
} from './chart-utils';
```

to add `dashForOverlayIndex`:

```typescript
import {
  MONO_FONT, AXIS_WIDTH,
  BOTTOM_AXIS_HEIGHT,
  niceAxisTicks, formatValue, formatTimeSec, clamp, brightenColor, minMaxTrace,
  dashForOverlayIndex,
} from './chart-utils';
```

Also extend `computeOverlayYRanges` so overlay channel values widen the Y range when in overlay chart-mode (and when in separate mode, widen the per-strip range too — but the per-strip Y-range is computed inside `drawStrips`, so we instead adjust there). Add at the start of `drawStrips`'s per-strip loop, right after `const visible = ...` line (around line 110), before `computeStripYRange`:

```typescript
    // Fold overlay sample ranges into the strip's visible-data array used for
    // Y-range so the trace doesn't get clipped above/below the visible region.
    let visibleForRange: ChannelSample[] = visible;
    if (dc.overlays.length > 0) {
      const merged: ChannelSample[] = visible.slice();
      for (const ov of dc.overlays) {
        const ovSamples = ov.samplesByPrimaryId.get(strip.channelId);
        if (!ovSamples || ovSamples.length === 0) continue;
        const ovVis = dc.getVisibleSamples(strip.channelId, ovSamples, xRange, plotW);
        for (const s of ovVis) merged.push(s);
      }
      visibleForRange = merged;
    }
```

Then change the line `const [yMin, yMax] = computeStripYRange(dc, strip, visible, def.units || '');` to use `visibleForRange`:

```typescript
    const [yMin, yMax] = computeStripYRange(dc, strip, visibleForRange, def.units || '');
```

Similarly, in `computeOverlayYRanges` (lines 16-61), the loop that gathers per-unit min/max — update so it also folds overlay samples. Replace the for-of strip loop body (lines 19-39) with:

```typescript
  for (const strip of dc.strips) {
    const data = dc.channelDataMap.get(strip.channelId);
    if (!data) continue;
    const units = data.def.units || '';
    const visible = data.allSamples.length > 0
      ? dc.getVisibleSamples(strip.channelId, data.allSamples, dc.xRange, dc.plotW)
      : [];
    let mn = Infinity, mx = -Infinity;
    for (const s of visible) {
      if (s.value < mn) mn = s.value;
      if (s.value > mx) mx = s.value;
    }
    // Fold overlays into the unit's range
    for (const ov of dc.overlays) {
      const ovSamples = ov.samplesByPrimaryId.get(strip.channelId);
      if (!ovSamples || ovSamples.length === 0) continue;
      const ovVis = dc.getVisibleSamples(strip.channelId, ovSamples, dc.xRange, dc.plotW);
      for (const s of ovVis) {
        if (s.value < mn) mn = s.value;
        if (s.value > mx) mx = s.value;
      }
    }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    const existing = unitMinMax.get(units);
    if (existing) {
      existing.min = Math.min(existing.min, mn);
      existing.max = Math.max(existing.max, mx);
    } else {
      unitMinMax.set(units, { min: mn, max: mx });
    }
  }
```

- [ ] **Step 2: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/lib/chart-draw.ts && git commit -m "chart-draw: render overlay traces with dash patterns and folded Y-range

Per-strip Y-range now folds in overlay samples so dashed traces aren't clipped.
In overlay chart-mode the shared per-unit range does the same."
```

---

### Task 4.3: Plumb overlays through `TelemetryChart`

**Files:**
- Modify: `client/src/components/TelemetryChart.tsx`

- [ ] **Step 1: Add `overlays` prop and prepare draw data**

In `client/src/components/TelemetryChart.tsx`:

1. Update the import in the prop file. Open `client/src/lib/chart-utils.ts` and find `TelemetryChartProps` (around line 10-20). Add a new field:

```typescript
export interface TelemetryChartProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  viewRange: TimeRange | null;
  onViewRangeChange: (range: TimeRange | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
  cursorTime?: number | null;
  onCursorTimeChange?: (t: number | null) => void;
  chartMode?: ChartMode;
  /** Multi-session overlays. Empty array when no overlays loaded. */
  overlays?: OverlayState[];
}
```

Add `import type { OverlayState } from './overlay-types';` near the top of `chart-utils.ts`.

2. Open `TelemetryChart.tsx`. In its destructured props (line 16-26), add `overlays = []`:

```tsx
export function TelemetryChart({
  session,
  activeChannels,
  viewRange,
  onViewRangeChange,
  derivedChannels,
  derivedSamplesMap,
  cursorTime,
  onCursorTimeChange,
  chartMode = 'separate',
  overlays = [],
}: TelemetryChartProps) {
```

3. Add imports at the top of `TelemetryChart.tsx`:

```tsx
import { computeAlignmentOffsetMs, applyOffset } from '../lib/overlay-alignment';
import { findOverlayChannelId } from '../lib/overlay-types';
import type { OverlayDrawData } from '../lib/chart-utils';
```

4. Compute `OverlayDrawData[]` with `useMemo`. Insert after `channelDataMap` is defined (after line 85):

```tsx
  // Build per-overlay draw data: time-shifted samples keyed by primary channel id
  const overlayDrawData = useMemo<OverlayDrawData[]>(() => {
    const out: OverlayDrawData[] = [];
    overlays.forEach((ov, i) => {
      if (!ov.visible) return;
      const offsetMs = computeAlignmentOffsetMs(session, ov.session, ov.alignment);
      const samplesByPrimaryId = new Map<number, ChannelSample[]>();
      for (const ac of visibleChannels) {
        const ovChId = findOverlayChannelId(session, ov.session, ac.channelId);
        if (ovChId === -1) continue;
        const raw = ov.samples.get(ovChId);
        if (!raw || raw.length === 0) continue;
        samplesByPrimaryId.set(ac.channelId, applyOffset(raw, offsetMs));
      }
      out.push({ id: ov.id, index: i + 1, offsetMs, samplesByPrimaryId });
    });
    return out;
  }, [overlays, visibleChannels, session]);
```

5. Pass `overlays: overlayDrawData` into the `DrawContext` literal in `draw()` (find `const dc: DrawContext = {` around line 283):

```tsx
    const dc: DrawContext = {
      ctx, w, h, lm, rm, plotW, xRange, xTicks, strips,
      channelDataMap, chartMode, sharedYRanges,
      timeToX, getVisibleSamples, overlayAxisLayout, session,
      smoothedYRanges: smoothedYRanges.current,
      needsDrawRef,
      colors,
      overlays: overlayDrawData,
    };
```

6. Add `overlayDrawData` to the `draw` callback's dep array (around line 307):

```tsx
  }, [session, sessionDuration, channelDataMap, visibleChannels, computeStripLayouts, timeToX, getVisibleSamples, leftMargin, rightMargin, chartMode, overlayAxisLayout, overlayDrawData]);
```

7. Add a "redraw on overlay change" effect after the existing `[channelDataMap, visibleChannels, viewRange, chartMode]` effect (around line 366-368):

```tsx
  useEffect(() => {
    needsDrawRef.current = true;
  }, [overlayDrawData]);
```

- [ ] **Step 2: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/components/TelemetryChart.tsx client/src/lib/chart-utils.ts && git commit -m "TelemetryChart: accept overlays, compute time-shifted draw data, pass to DrawContext"
```

---

### Task 4.4: Cross-session delta panel

**Files:**
- Modify: `client/src/lib/chart-cursors.ts`

- [ ] **Step 1: Update `drawCursorPills` to also draw overlay value pills under each channel's pill**

In `client/src/lib/chart-cursors.ts`, find `drawCursorPills` (around line 69-123). After the line that increments `pillIndex++` (the closing of the existing per-strip loop), add overlay pills *before* `pillIndex++`. Replace the entire `drawCursorPills` function with:

```typescript
function drawCursorPills(dc: DrawContext, cursorT: number, axisY: number) {
  const { ctx, w, rm, xRange, plotW, strips, channelDataMap, chartMode } = dc;
  let pillIndex = 0;
  for (const strip of strips) {
    const data = channelDataMap.get(strip.channelId);
    if (!data || data.allSamples.length === 0) continue;

    const snap = nearestSample(data.allSamples, cursorT * 1000);
    if (!snap) continue;
    const lineVal = interpolateValue(data.allSamples, cursorT * 1000) ?? snap.value;
    const yRange = getStripYRange(dc, strip, data.def);
    const dotX = dc.timeToX(cursorT, xRange, plotW);
    const dotY = stripValToY(strip, yRange, lineVal);

    ctx.fillStyle = strip.color;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
    ctx.fill();

    const valText = formatValue(snap.value);
    const nameText = data.def.shortName;
    ctx.font = `bold 10px ${MONO_FONT}`;
    const nameW = ctx.measureText(nameText).width;
    ctx.font = `10px ${MONO_FONT}`;
    const valW = ctx.measureText(valText).width;
    const pillGap = 6;
    const pillPadX = 8;
    const pillW = nameW + pillGap + valW + pillPadX * 2;
    const pillH = 20;
    const pillX = w - rm - pillW - 4;
    const pillY = chartMode === 'overlay'
      ? strip.top + 4 + pillIndex * (pillH + 3)
      : strip.top + 4;

    ctx.fillStyle = dc.colors.cursorPill;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 4);
    ctx.fill();

    ctx.font = `bold 10px ${MONO_FONT}`;
    ctx.fillStyle = strip.color;
    ctx.textAlign = 'left';
    ctx.fillText(nameText, pillX + pillPadX, pillY + 14);

    ctx.font = `10px ${MONO_FONT}`;
    ctx.fillStyle = dc.colors.cursorPillText;
    ctx.fillText(valText, pillX + pillPadX + nameW + pillGap, pillY + 14);
    pillIndex++;

    // Overlay pills for this channel
    for (const ov of dc.overlays) {
      const ovSamples = ov.samplesByPrimaryId.get(strip.channelId);
      if (!ovSamples || ovSamples.length === 0) continue;
      const ovSnap = nearestSample(ovSamples, cursorT * 1000);
      if (!ovSnap) continue;

      const ovValText = formatValue(ovSnap.value);
      ctx.font = `10px ${MONO_FONT}`;
      const ovValW = ctx.measureText(ovValText).width;
      const ovTagText = `#${ov.index}`;
      ctx.font = `bold 9px ${MONO_FONT}`;
      const ovTagW = ctx.measureText(ovTagText).width;
      const ovPillW = ovTagW + pillGap + ovValW + pillPadX * 2;
      const ovPillH = 16;
      const ovPillX = w - rm - ovPillW - 4;
      const ovPillY = chartMode === 'overlay'
        ? strip.top + 4 + pillIndex * (ovPillH + 2)
        : pillY + pillH + 2 + (ov.index - 1) * (ovPillH + 2);

      ctx.fillStyle = dc.colors.cursorPill;
      ctx.beginPath();
      ctx.roundRect(ovPillX, ovPillY, ovPillW, ovPillH, 3);
      ctx.fill();

      ctx.font = `bold 9px ${MONO_FONT}`;
      ctx.fillStyle = strip.color;
      ctx.fillText(ovTagText, ovPillX + pillPadX, ovPillY + 11);

      ctx.font = `10px ${MONO_FONT}`;
      ctx.fillStyle = dc.colors.cursorPillText;
      ctx.fillText(ovValText, ovPillX + pillPadX + ovTagW + pillGap, ovPillY + 11);

      if (chartMode === 'overlay') pillIndex++;
    }
  }
}
```

- [ ] **Step 2: Update `drawDeltaPanel` to add overlay columns**

Replace the entire `drawDeltaPanel` function (around line 180-278) with:

```typescript
/** Draw the delta comparison panel — within-session A/B and cross-session
 *  primary-vs-overlay if overlays are present. */
function drawDeltaPanel(dc: DrawContext, cursorA: number, cursorB: number) {
  const { ctx, w, rm, strips, channelDataMap, overlays } = dc;

  const deltaT = Math.abs(cursorB - cursorA);
  type Row = {
    label: string;
    valA: string;
    valB: string;
    delta: string;
    color: string;
    overlayCells: { tag: string; valA: string; valB: string; deltaA: string; deltaB: string }[];
  };
  const rows: Row[] = [];

  for (const strip of strips) {
    const data = channelDataMap.get(strip.channelId);
    if (!data || data.allSamples.length === 0) continue;
    const snapA = nearestSample(data.allSamples, cursorA * 1000);
    const snapB = nearestSample(data.allSamples, cursorB * 1000);
    if (!snapA || !snapB) continue;

    const overlayCells: Row['overlayCells'] = [];
    for (const ov of overlays) {
      const ovSamples = ov.samplesByPrimaryId.get(strip.channelId);
      if (!ovSamples || ovSamples.length === 0) continue;
      const ovSnapA = nearestSample(ovSamples, cursorA * 1000);
      const ovSnapB = nearestSample(ovSamples, cursorB * 1000);
      if (!ovSnapA || !ovSnapB) continue;
      overlayCells.push({
        tag: `#${ov.index}`,
        valA: formatValue(ovSnapA.value),
        valB: formatValue(ovSnapB.value),
        deltaA: formatValue(ovSnapA.value - snapA.value),
        deltaB: formatValue(ovSnapB.value - snapB.value),
      });
    }

    rows.push({
      label: data.def.shortName,
      valA: formatValue(snapA.value),
      valB: formatValue(snapB.value),
      delta: formatValue(snapB.value - snapA.value),
      color: strip.color,
      overlayCells,
    });
  }

  ctx.font = `bold 10px ${MONO_FONT}`;
  let maxNameW = ctx.measureText('Channel').width;
  for (const row of rows) {
    const tw = ctx.measureText(row.label).width;
    if (tw > maxNameW) maxNameW = tw;
  }
  const nameColW = maxNameW + 14;
  const valColW = 64;
  const ovValColW = 56;
  const numOverlayCols = overlays.length;

  const panelPad = 10;
  const headerH = 22;
  const colHeaderH = 18;
  const baseLineH = 20;
  const ovLineH = 16;
  let totalLines = 0;
  for (const r of rows) {
    totalLines += baseLineH + r.overlayCells.length * ovLineH;
  }
  const panelH = headerH + colHeaderH + totalLines + panelPad * 2;
  // Columns: name | A | B | Δ(A→B) | per-overlay {A, B, Δ-vs-prim@A, Δ-vs-prim@B}
  const ovColW = numOverlayCols * (ovValColW * 4);
  const panelW = nameColW + valColW * 3 + ovColW + panelPad * 2;
  const panelX = w - rm - panelW - 10;
  const panelY = 8;

  ctx.fillStyle = dc.colors.deltaPanel;
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, panelW, panelH, 6);
  ctx.fill();
  ctx.strokeStyle = dc.colors.deltaLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, panelW, panelH, 6);
  ctx.stroke();

  ctx.font = `bold 11px ${MONO_FONT}`;
  ctx.fillStyle = dc.colors.deltaAccent;
  ctx.textAlign = 'left';
  ctx.fillText(`Δt = ${deltaT.toFixed(3)}s`, panelX + panelPad, panelY + panelPad + 12);

  const col1 = panelX + panelPad;
  const col2 = panelX + panelPad + nameColW + valColW;
  const col3 = col2 + valColW;
  const col4 = col3 + valColW;

  const colY = panelY + panelPad + headerH + 10;
  ctx.font = `9px ${MONO_FONT}`;
  ctx.fillStyle = dc.colors.text;
  ctx.textAlign = 'left';
  ctx.fillText('Channel', col1, colY);
  ctx.textAlign = 'right';
  ctx.fillText('A', col2, colY);
  ctx.fillText('B', col3, colY);
  ctx.fillText('Δ', col4, colY);
  // Overlay column headers
  for (let i = 0; i < overlays.length; i++) {
    const baseX = col4 + (i * 4 + 1) * ovValColW;
    ctx.fillText(`#${overlays[i].index}A`, baseX, colY);
    ctx.fillText(`#${overlays[i].index}B`, baseX + ovValColW, colY);
    ctx.fillText(`Δ@A`, baseX + ovValColW * 2, colY);
    ctx.fillText(`Δ@B`, baseX + ovValColW * 3, colY);
  }

  const sepY = colY + 5;
  ctx.strokeStyle = dc.colors.separator;
  ctx.beginPath();
  ctx.moveTo(col1, sepY);
  ctx.lineTo(panelX + panelW - panelPad, sepY);
  ctx.stroke();

  let ry = sepY + 4 + 12;
  for (const row of rows) {
    ctx.font = `bold 10px ${MONO_FONT}`;
    ctx.fillStyle = row.color;
    ctx.textAlign = 'left';
    ctx.fillText(row.label, col1, ry);

    ctx.font = `10px ${MONO_FONT}`;
    ctx.fillStyle = dc.colors.text;
    ctx.textAlign = 'right';
    ctx.fillText(row.valA, col2, ry);
    ctx.fillText(row.valB, col3, ry);

    ctx.font = `bold 10px ${MONO_FONT}`;
    ctx.fillStyle = dc.colors.deltaAccent;
    ctx.fillText(row.delta, col4, ry);

    // Overlay cells (one row per overlay, indented under the channel)
    let ovRy = ry + ovLineH;
    for (const ovCell of row.overlayCells) {
      const ovIdx = overlays.findIndex(o => `#${o.index}` === ovCell.tag);
      if (ovIdx < 0) { ovRy += ovLineH; continue; }
      const baseX = col4 + (ovIdx * 4 + 1) * ovValColW;

      ctx.font = `9px ${MONO_FONT}`;
      ctx.fillStyle = dc.colors.text;
      ctx.textAlign = 'left';
      ctx.fillText(ovCell.tag, col1 + 12, ovRy);

      ctx.textAlign = 'right';
      ctx.fillText(ovCell.valA, baseX, ovRy);
      ctx.fillText(ovCell.valB, baseX + ovValColW, ovRy);
      ctx.fillStyle = dc.colors.deltaAccent;
      ctx.fillText(ovCell.deltaA, baseX + ovValColW * 2, ovRy);
      ctx.fillText(ovCell.deltaB, baseX + ovValColW * 3, ovRy);

      ovRy += ovLineH;
    }
    ry = ovRy + 4;
  }
}
```

Notes:
- The panel grows wide quickly with overlays. That's intentional — racers want everything visible. Past 3 overlays the soft cap warning surfaces in the OverlayPopover (Task 5.3).

- [ ] **Step 2: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/lib/chart-cursors.ts && git commit -m "chart-cursors: cross-session value pills + delta panel columns

Per-channel cursor pills get an overlay #N pill stacked underneath. Delta
panel adds {#NA, #NB, Δ@A, Δ@B} columns per overlay, one row per (channel,
overlay) below the primary channel row."
```

---

## Phase 5 — Frontend UI: SessionBrowser multi-select + chart popover

### Task 5.1: Multi-select in `SessionBrowser`

**Files:**
- Modify: `client/src/components/SessionBrowser.tsx`
- Modify: `client/src/App.tsx` — `onSessionLoaded` signature changes to also accept overlay session IDs.

- [ ] **Step 1: Update `SessionBrowser` props and state**

In `client/src/components/SessionBrowser.tsx`, change the `SessionBrowserProps` interface (line 17-23):

```typescript
interface SessionBrowserProps {
  onSessionLoaded: (
    info: SessionInfo,
    sessionId: string,
    fileName: string,
    overlaySessionIds: string[],
  ) => void;
  onOpenSettings: () => void;
  onOpenLive: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}
```

Inside the component, add multi-select state right after the existing `useState` calls (around line 105):

```typescript
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
```

- [ ] **Step 2: Add row checkbox handler and update load logic**

Add helpers above `handleLoad` (around line 145):

```typescript
const toggleSelected = useCallback((sessionId: string) => {
  setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    return next;
  });
}, []);

const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
```

Update `handleLoad` (lines 145-177) to handle multi-select. Replace the function body:

```typescript
const handleLoad = useCallback(async (session: LocalSession) => {
  // If multiple are selected, treat the clicked one as primary and the rest as overlays.
  // Else, single-load.
  let primaryId = session.id;
  let overlayIds: string[] = [];
  if (selectedIds.size > 1) {
    if (!selectedIds.has(session.id)) {
      // User clicked a row outside the selection — fall back to single-load
      primaryId = session.id;
      overlayIds = [];
    } else {
      primaryId = session.id;
      overlayIds = Array.from(selectedIds).filter(id => id !== session.id);
    }
  }

  const allIds = [primaryId, ...overlayIds];
  // Soft cap warning
  if (allIds.length > 4) {
    const ok = window.confirm(
      `Loading ${allIds.length} sessions (1 primary + ${overlayIds.length} overlays). ` +
      `Past 3 overlays the chart may slow down. Continue?`,
    );
    if (!ok) return;
  }

  // Resolve any not-yet-pulled sessions
  for (const id of allIds) {
    const s = sessions.find(x => x.id === id);
    if (!s) continue;
    if (s.sync_status === 'remote_only') {
      setPullingId(id);
      try { await pullSession(id); await refreshSessions(); }
      catch (e) {
        setError(e instanceof Error ? e.message : 'Pull failed');
        setPullingId(null);
        return;
      }
      setPullingId(null);
    }
  }

  setLoadingId(primaryId);
  try {
    const info = await loadSession(primaryId);
    const primarySession = sessions.find(s => s.id === primaryId);
    onSessionLoaded(info, primaryId, primarySession?.filename || session.filename, overlayIds);
    clearSelection();
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Load failed');
  } finally {
    setLoadingId(null);
  }
}, [onSessionLoaded, refreshSessions, sessions, selectedIds, clearSelection]);
```

- [ ] **Step 3: Add a checkbox to each row's UI**

Find the row JSX in `SessionBrowser.tsx` (look for the loop that renders sessions, near the bottom of the file — search for `sessions.map` or `filteredSessions.map`). Add a checkbox at the start of each row, before the session info. Locate the row container (typically a `<div>` with click handler `() => handleLoad(session)`):

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && grep -n "handleLoad(session)" client/src/components/SessionBrowser.tsx
```

For each match in a row container, add a checkbox column. Insert near the start of the row's children:

```tsx
<input
  type="checkbox"
  checked={selectedIds.has(session.id)}
  onChange={(e) => { e.stopPropagation(); toggleSelected(session.id); }}
  onClick={(e) => e.stopPropagation()}
  className="mr-2 mt-0.5 self-start cursor-pointer flex-shrink-0"
  data-testid={`select-session-${session.id}`}
  title={selectedIds.size > 1 && selectedIds.has(session.id) ? 'In selection' : 'Add to overlay selection'}
/>
```

- [ ] **Step 4: Add a selection summary bar above the list**

Find the search/filter bar above the sessions list. After it (or in a sibling `<div>`), conditionally render a selection summary:

```tsx
{selectedIds.size > 1 && (
  <div className="px-4 py-2 bg-primary/10 border-y border-primary/30 flex items-center justify-between">
    <span className="text-xs text-foreground">
      {selectedIds.size} selected — click any selected row's <strong>Load</strong> to open as primary + overlays
    </span>
    <button
      onClick={clearSelection}
      className="text-xs text-muted-foreground hover:text-foreground"
    >
      Clear
    </button>
  </div>
)}
```

- [ ] **Step 5: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: errors about `onSessionLoaded` signature mismatch in `App.tsx` — fix in Task 5.2 next.

- [ ] **Step 6: Commit (with intentionally broken App.tsx — next task fixes it)**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/components/SessionBrowser.tsx && git commit -m "SessionBrowser: multi-select rows for primary + overlays

Adds a checkbox per row, a selection summary bar, and updates handleLoad
to forward overlaySessionIds to onSessionLoaded. App.tsx wiring follows."
```

---

### Task 5.2: Wire `App.tsx` to load overlays

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Update `handleSessionLoaded` to consume `overlaySessionIds`**

In `client/src/App.tsx`:

1. Destructure new actions from `useAppState`. Find the destructuring (lines 24-49) and add:

```tsx
    addOverlay,
    removeOverlay,
    toggleOverlayVisibility,
    updateOverlayAlignment,
    ensureOverlayChannelLoaded,
```

2. Change `handleSessionLoaded` signature (around line 157-166):

```tsx
const handleSessionLoaded = useCallback(async (
  info: SessionInfo,
  sessionId: string,
  fileName: string,
  overlaySessionIds: string[] = [],
) => {
  setLoadedSessionId(sessionId);
  setLoading(true);
  setProgress({ stage: 'Building session...', percent: 50 });
  try {
    await buildAndSetSession(info, fileName);
    // After primary is built, kick off overlay loads (parallel, best-effort)
    for (const ovId of overlaySessionIds) {
      const sessionEntry = (await import('./lib/api')).listSessions
        ? null
        : null; // we don't need this; addOverlay handles its own fetch
      const result = await addOverlay(ovId, ovId);
      if ('error' in result) {
        // Overlay errors are non-fatal: the primary is already loaded
        console.warn(`Failed to add overlay ${ovId}:`, result.error);
      }
    }
  } catch (err) {
    setError(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
  }
}, [buildAndSetSession, setLoading, setProgress, setError, addOverlay]);
```

(Note: the line `const sessionEntry = ...` is leftover from a thinking step — clean up to just `const result = await addOverlay(ovId, ovId);` etc. The simpler version:)

Replace `handleSessionLoaded` body cleanly:

```tsx
const handleSessionLoaded = useCallback(async (
  info: SessionInfo,
  sessionId: string,
  fileName: string,
  overlaySessionIds: string[] = [],
) => {
  setLoadedSessionId(sessionId);
  setLoading(true);
  setProgress({ stage: 'Building session...', percent: 50 });
  try {
    await buildAndSetSession(info, fileName);
    for (const ovId of overlaySessionIds) {
      const result = await addOverlay(ovId, ovId);
      if ('error' in result) {
        console.warn(`Failed to add overlay ${ovId}: ${result.error}`);
      }
    }
  } catch (err) {
    setError(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
  }
}, [buildAndSetSession, setLoading, setProgress, setError, addOverlay]);
```

3. The default-arg version of `addOverlay` uses the session ID as label — Task 5.3 will improve label display in the popover by storing filename. For now, label = id is acceptable.

4. In the chart render section (around line 413), pass `overlays` to `TelemetryChart`:

```tsx
<TelemetryChart
  session={session}
  activeChannels={activeChannels}
  viewRange={state.viewRange}
  onViewRangeChange={setViewRange}
  derivedChannels={state.derivedChannels}
  derivedSamplesMap={derivedSamplesMap}
  cursorTime={state.cursorTime}
  onCursorTimeChange={setCursorTime}
  chartMode={state.chartMode}
  overlays={state.overlays}
/>
```

5. After visible channels change, lazy-load overlay channel data. Add a new effect inside `App.tsx` (after the existing `useMemo` for `activeChannels` around line 318):

```tsx
useEffect(() => {
  if (state.overlays.length === 0) return;
  for (const ac of state.activeChannels) {
    for (const ov of state.overlays) {
      ensureOverlayChannelLoaded(ov.id, ac.channelId);
    }
  }
}, [state.activeChannels, state.overlays, ensureOverlayChannelLoaded]);
```

(`useEffect` is already imported in `App.tsx`? Check: line 1 — `import { useCallback, useMemo, useState } from 'react';`. Add `useEffect`:)

Update line 1:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
```

- [ ] **Step 2: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/App.tsx && git commit -m "App: wire overlay session IDs through handleSessionLoaded → addOverlay

After the primary loads, additional selected sessions are loaded as overlays.
A useEffect keeps overlay channel samples lazily fetched whenever the user
activates a new channel."
```

---

### Task 5.3: Overlay management popover

**Files:**
- Create: `client/src/components/OverlayPopover.tsx`
- Modify: `client/src/components/TelemetryChart.tsx` — add the toolbar trigger.

- [ ] **Step 1: Write `OverlayPopover.tsx`**

```tsx
// client/src/components/OverlayPopover.tsx
import { useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import type { OverlayState, OverlayAlignment } from '../lib/overlay-types';
import type { XRKSession } from '../lib/xrk-parser';
import { fastestLapIndex } from '../lib/overlay-alignment';

interface Props {
  primary: XRKSession;
  overlays: OverlayState[];
  onRemove: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onUpdateAlignment: (id: string, alignment: OverlayAlignment) => void;
  onClose: () => void;
}

export function OverlayPopover({
  primary, overlays, onRemove, onToggleVisible, onUpdateAlignment, onClose,
}: Props) {
  const primaryLapCount = Math.max(0, primary.lapMarkers.length - 1);
  const showPerfWarning = overlays.length > 3;

  return (
    <div
      className="absolute right-2 top-10 w-[420px] max-h-[500px] overflow-y-auto bg-card border border-border rounded-lg shadow-lg z-20"
      data-testid="overlay-popover"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-sm font-semibold">Overlays ({overlays.length})</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" data-testid="overlay-popover-close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {showPerfWarning && (
        <div className="px-3 py-1.5 text-xs bg-amber-500/10 text-amber-700 dark:text-amber-300 border-b border-amber-500/30">
          Past 3 overlays the chart may slow down. Hide some to recover frame rate.
        </div>
      )}

      {overlays.length === 0 && (
        <p className="px-3 py-4 text-xs text-muted-foreground">No overlays loaded. Multi-select sessions in the browser to add.</p>
      )}

      <ul>
        {overlays.map((ov, i) => {
          const ovLapCount = Math.max(0, ov.session.lapMarkers.length - 1);
          return (
            <li key={ov.id} className="px-3 py-2 border-b border-border/50 last:border-b-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-mono text-foreground">#{i + 1} {ov.label}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onToggleVisible(ov.id)}
                    className="text-muted-foreground hover:text-foreground"
                    title={ov.visible ? 'Hide' : 'Show'}
                  >
                    {ov.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => onRemove(ov.id)}
                    className="text-muted-foreground hover:text-red-500"
                    title="Remove overlay"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <AlignmentControls
                primary={primary}
                overlay={ov.session}
                primaryLapCount={primaryLapCount}
                overlayLapCount={ovLapCount}
                alignment={ov.alignment}
                onChange={(a) => onUpdateAlignment(ov.id, a)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AlignmentControls({
  primary, overlay, primaryLapCount, overlayLapCount, alignment, onChange,
}: {
  primary: XRKSession;
  overlay: XRKSession;
  primaryLapCount: number;
  overlayLapCount: number;
  alignment: OverlayAlignment;
  onChange: (a: OverlayAlignment) => void;
}) {
  const [manualMs, setManualMs] = useState(alignment.kind === 'manual' ? alignment.offsetMs : 0);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-muted-foreground w-14">Align:</label>
        <select
          value={alignment.kind}
          onChange={(e) => {
            const k = e.target.value as 'raw' | 'lap' | 'manual';
            if (k === 'raw') onChange({ kind: 'raw' });
            else if (k === 'manual') onChange({ kind: 'manual', offsetMs: manualMs });
            else {
              const p = fastestLapIndex(primary.lapMarkers);
              const o = fastestLapIndex(overlay.lapMarkers);
              onChange({ kind: 'lap', primaryLap: p === -1 ? 0 : p, overlayLap: o === -1 ? 0 : o });
            }
          }}
          className="text-xs bg-background border border-border rounded px-1.5 py-0.5 flex-1"
        >
          <option value="raw">Raw (t=0 = t=0)</option>
          <option value="lap" disabled={primaryLapCount === 0 || overlayLapCount === 0}>
            By lap (primary lap N vs overlay lap M)
          </option>
          <option value="manual">Manual offset (ms)</option>
        </select>
      </div>
      {alignment.kind === 'lap' && (
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-muted-foreground w-14">Lap:</label>
          <select
            value={alignment.primaryLap}
            onChange={(e) => onChange({ ...alignment, primaryLap: parseInt(e.target.value, 10) })}
            className="text-xs bg-background border border-border rounded px-1 py-0.5"
          >
            {Array.from({ length: primaryLapCount }, (_, i) => (
              <option key={i} value={i}>Primary L{i + 1}</option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">vs</span>
          <select
            value={alignment.overlayLap}
            onChange={(e) => onChange({ ...alignment, overlayLap: parseInt(e.target.value, 10) })}
            className="text-xs bg-background border border-border rounded px-1 py-0.5"
          >
            {Array.from({ length: overlayLapCount }, (_, i) => (
              <option key={i} value={i}>Overlay L{i + 1}</option>
            ))}
          </select>
        </div>
      )}
      {alignment.kind === 'manual' && (
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-muted-foreground w-14">Offset:</label>
          <input
            type="number"
            value={manualMs}
            step={10}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10) || 0;
              setManualMs(v);
              onChange({ kind: 'manual', offsetMs: v });
            }}
            className="text-xs bg-background border border-border rounded px-1.5 py-0.5 w-24 tabular"
          />
          <span className="text-[10px] text-muted-foreground">ms</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add toolbar indicator and popover state in `TelemetryChart`**

In `client/src/components/TelemetryChart.tsx`, add an import:

```tsx
import { OverlayPopover } from './OverlayPopover';
import type { OverlayAlignment, OverlayState } from '../lib/overlay-types';
```

Receive new props for the popover (extend `TelemetryChartProps` in `chart-utils.ts`):

```typescript
export interface TelemetryChartProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  viewRange: TimeRange | null;
  onViewRangeChange: (range: TimeRange | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
  cursorTime?: number | null;
  onCursorTimeChange?: (t: number | null) => void;
  chartMode?: ChartMode;
  overlays?: OverlayState[];
  onOverlayRemove?: (id: string) => void;
  onOverlayToggleVisible?: (id: string) => void;
  onOverlayUpdateAlignment?: (id: string, alignment: OverlayAlignment) => void;
}
```

Add `import type { OverlayAlignment } from './overlay-types';` to `chart-utils.ts` imports.

In `TelemetryChart.tsx`, destructure the new props:

```tsx
export function TelemetryChart({
  session,
  activeChannels,
  viewRange,
  onViewRangeChange,
  derivedChannels,
  derivedSamplesMap,
  cursorTime,
  onCursorTimeChange,
  chartMode = 'separate',
  overlays = [],
  onOverlayRemove,
  onOverlayToggleVisible,
  onOverlayUpdateAlignment,
}: TelemetryChartProps) {
```

Add popover state at the top of the component (alongside `deltaMode`):

```tsx
const [overlayPopoverOpen, setOverlayPopoverOpen] = useState(false);
```

Find the toolbar JSX (around line 705-742, the `<div className="flex items-center justify-between px-3 py-1.5 border-b...`). After the `Δ Delta` button, add:

```tsx
{overlays.length > 0 && (
  <button
    onClick={() => setOverlayPopoverOpen(o => !o)}
    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
    title="Manage overlays"
    data-testid="overlay-toggle"
  >
    Overlays: {overlays.length}{overlays.length > 3 ? ' ⚠' : ''} ▾
  </button>
)}
```

Render the popover at the bottom of the component, just before the closing `</div>` of the canvas container (around line 763, inside the chart wrapper but as a sibling of the canvas):

```tsx
{overlayPopoverOpen && overlays.length > 0 && onOverlayRemove && onOverlayToggleVisible && onOverlayUpdateAlignment && (
  <OverlayPopover
    primary={session}
    overlays={overlays}
    onRemove={onOverlayRemove}
    onToggleVisible={onOverlayToggleVisible}
    onUpdateAlignment={onOverlayUpdateAlignment}
    onClose={() => setOverlayPopoverOpen(false)}
  />
)}
```

Note the popover uses `position: absolute` with `right-2 top-10` — make sure its parent has `position: relative`. The chart's outer container `<div className="flex flex-col h-full" data-testid="chart-container">` doesn't have `relative`. Change it:

```tsx
<div className="flex flex-col h-full relative" data-testid="chart-container">
```

- [ ] **Step 3: Pass overlay actions from `App.tsx`**

In `client/src/App.tsx`, extend the `<TelemetryChart ... />` element:

```tsx
<TelemetryChart
  session={session}
  activeChannels={activeChannels}
  viewRange={state.viewRange}
  onViewRangeChange={setViewRange}
  derivedChannels={state.derivedChannels}
  derivedSamplesMap={derivedSamplesMap}
  cursorTime={state.cursorTime}
  onCursorTimeChange={setCursorTime}
  chartMode={state.chartMode}
  overlays={state.overlays}
  onOverlayRemove={removeOverlay}
  onOverlayToggleVisible={toggleOverlayVisibility}
  onOverlayUpdateAlignment={updateOverlayAlignment}
/>
```

- [ ] **Step 4: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/components/OverlayPopover.tsx client/src/components/TelemetryChart.tsx client/src/lib/chart-utils.ts client/src/App.tsx && git commit -m "Overlay popover: toolbar indicator + management UI

Per-overlay visibility toggle, remove, and alignment selector (raw/lap/manual)
with primary-vs-overlay lap dropdowns and manual ms entry."
```

---

## Phase 6 — Derived channels on overlays (formula mode)

### Task 6.1: Re-evaluate formula derived channels per overlay

**Files:**
- Modify: `client/src/lib/useXRKStore.ts` — extend overlay state to carry derived samples per overlay.
- Modify: `client/src/components/TelemetryChart.tsx` — surface them via `samplesByPrimaryId` matching by derived id (since derived ids are session-scoped, we keep parity by id).

- [ ] **Step 1: Augment `OverlayState` with derived samples map**

In `client/src/lib/overlay-types.ts`, extend `OverlayState`:

```typescript
export interface OverlayState {
  id: string;
  label: string;
  session: XRKSession;
  visible: boolean;
  alignment: OverlayAlignment;
  /** Raw channel samples keyed by overlay channel id (matched by shortName).
   *  Lazy-filled. */
  samples: Map<number, ChannelSample[]>;
  /** Derived-channel samples computed against this overlay, keyed by the
   *  *primary's* derived channel id. Only populated for formula-mode derived
   *  channels (Python-mode is primary-only). Recomputed on overlay add and on
   *  any primary derived-channel change. */
  derivedSamples: Map<number, ChannelSample[]>;
}
```

In `useXRKStore.ts`'s `addOverlay`, set `derivedSamples: new Map()` on the new `OverlayState`.

Replace `addOverlay`'s OverlayState assembly:

```typescript
const overlay: OverlayState = {
  id: sessionId,
  label,
  session: overlaySession,
  visible: true,
  alignment: defaultAlignment(primary, overlaySession),
  samples: new Map(),
  derivedSamples: new Map(),
};
```

- [ ] **Step 2: Add a recompute helper**

Add to `useXRKStore.ts` (in the overlay section, after `ensureOverlayChannelLoaded`):

```typescript
/** Recompute formula-mode derived channels against an overlay. Lazy-fetches
 *  any base channels the formula references that aren't already loaded for
 *  the overlay. Skips Python-mode derived channels (primary-only by design). */
const recomputeOverlayDerived = useCallback(async (sessionId: string) => {
  const primary = state.session;
  if (!primary) return;
  const overlay = state.overlays.find(o => o.id === sessionId);
  if (!overlay) return;
  const formulaDerived = state.derivedChannels.filter(d => d.mode === 'formula');
  if (formulaDerived.length === 0) {
    // Clear any stale entries
    if (overlay.derivedSamples.size > 0) {
      setState(prev => ({
        ...prev,
        overlays: prev.overlays.map(o => o.id === sessionId
          ? { ...o, derivedSamples: new Map() }
          : o),
      }));
    }
    return;
  }

  // Gather all referenced names across all formula derived channels
  const allNames = new Set<string>();
  for (const dc of formulaDerived) {
    for (const n of extractChannelNames(dc.expression)) allNames.add(n);
  }
  // Lazy-fetch missing channels for the overlay
  const namesToFetch: string[] = [];
  for (const name of allNames) {
    let overlayChId = -1;
    for (const [oid, odef] of overlay.session.channels) {
      if (odef.shortName === name) { overlayChId = oid; break; }
    }
    if (overlayChId === -1) continue;
    const already = overlay.samples.get(overlayChId);
    if (already && already.length > 0) continue;
    namesToFetch.push(name);
  }
  let freshSamples = new Map(overlay.samples);
  if (namesToFetch.length > 0) {
    try {
      const dataMap = await fetchSessionChannelData(sessionId, namesToFetch);
      for (const [name, data] of dataMap) {
        let overlayChId = -1;
        for (const [oid, odef] of overlay.session.channels) {
          if (odef.shortName === name) { overlayChId = oid; break; }
        }
        if (overlayChId === -1) continue;
        const samps: ChannelSample[] = data.timestamps.map((t, i) => ({ timestamp: t, value: data.values[i] }));
        freshSamples.set(overlayChId, samps);
      }
    } catch (e) {
      console.error('Overlay derived: failed to fetch channels:', e);
      return;
    }
  }

  // Build channelData keyed by shortName for the formula evaluator
  const channelData: Record<string, { timestamps: number[]; values: number[] }> = {};
  for (const [chId, samps] of freshSamples) {
    if (samps.length === 0) continue;
    const def = overlay.session.channels.get(chId);
    if (!def) continue;
    channelData[def.shortName] = {
      timestamps: samps.map(s => s.timestamp),
      values: samps.map(s => s.value),
    };
  }

  const newDerived = new Map<number, ChannelSample[]>();
  for (const dc of formulaDerived) {
    const result = evaluateFormula(dc.expression, channelData);
    if (typeof result === 'string') continue; // skip on error
    newDerived.set(dc.id, result.timestamps.map((t, i) => ({ timestamp: t, value: result.values[i] })));
  }

  setState(prev => ({
    ...prev,
    overlays: prev.overlays.map(o => o.id === sessionId
      ? { ...o, samples: freshSamples, derivedSamples: newDerived }
      : o),
  }));
}, [state.session, state.overlays, state.derivedChannels]);
```

Add `recomputeOverlayDerived` to the returned object.

- [ ] **Step 3: Call recompute on overlay add and on derived-channel change**

In `addOverlay`'s success branch, after `setState(prev => ({ ...prev, overlays: [...prev.overlays, overlay] }));`, add:

```typescript
// Fire-and-forget recompute
void recomputeOverlayDerived(sessionId);
```

But `recomputeOverlayDerived` isn't defined at this point in the file (declaration order). Move the recompute call to the consumer side: in `App.tsx`, after `addOverlay` resolves successfully, call `recomputeOverlayDerived(ovId)`. Update `handleSessionLoaded`:

```tsx
for (const ovId of overlaySessionIds) {
  const result = await addOverlay(ovId, ovId);
  if ('error' in result) {
    console.warn(`Failed to add overlay ${ovId}: ${result.error}`);
    continue;
  }
  void recomputeOverlayDerived(ovId);
}
```

Also destructure `recomputeOverlayDerived` in `App.tsx`'s `useAppState()` destructure.

For the case "user adds a derived channel after overlays exist": add an effect in `App.tsx`:

```tsx
useEffect(() => {
  for (const ov of state.overlays) {
    void recomputeOverlayDerived(ov.id);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [state.derivedChannels]);
```

(The eslint disable is intentional — we don't want to re-run on every overlay change since recompute itself sets state on overlays.)

- [ ] **Step 4: Surface overlay derived samples to the chart**

In `TelemetryChart.tsx`, in `overlayDrawData`'s `useMemo`, when iterating `visibleChannels`, also check derived. Replace the inner loop:

```tsx
for (const ac of visibleChannels) {
  // First, try base channel matched by shortName
  const ovChId = findOverlayChannelId(session, ov.session, ac.channelId);
  if (ovChId !== -1) {
    const raw = ov.samples.get(ovChId);
    if (raw && raw.length > 0) {
      samplesByPrimaryId.set(ac.channelId, applyOffset(raw, offsetMs));
      continue;
    }
  }
  // Otherwise, derived channel — overlay's derivedSamples is keyed by
  // primary derived id, no shortName match needed.
  const derivedSamps = ov.derivedSamples.get(ac.channelId);
  if (derivedSamps && derivedSamps.length > 0) {
    samplesByPrimaryId.set(ac.channelId, applyOffset(derivedSamps, offsetMs));
  }
}
```

Note: `findOverlayChannelId` returns -1 for derived ids (which are >= 10000 and don't exist in the overlay's channels map), so the loop falls through to derivedSamples. That's the correct dispatch.

- [ ] **Step 5: Add a tooltip on Python-mode derived channels in `ChannelSidebar`**

Open `client/src/components/ChannelSidebar.tsx`. Find the derived channel row rendering. Where Python-mode rows are rendered, add a `title="Overlays do not evaluate Python-mode derived channels (sandbox runs primary-only)"` to the row's container if `overlays.length > 0` (the sidebar would need overlays passed in for this — the lightest change is to put the tooltip unconditionally on Python-mode rows since the message is always true).

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && grep -n "mode === 'python'\|python\\.\\|Mode\\." client/src/components/ChannelSidebar.tsx | head -10
```

Locate the row container for derived channels. Wherever `dc.mode === 'python'` is rendered, add the tooltip. If no such conditional exists yet, search for the `derivedChannels` map and add a `title` attribute that switches by mode:

```tsx
title={dc.mode === 'python' ? 'Overlays do not evaluate Python-mode derived channels' : undefined}
```

If finding the right spot is non-trivial, use this minimal injection: at the top of the derived-channels list rendering (the `<ul>` or `<div>` that maps `derivedChannels`), add a small note:

```tsx
{derivedChannels.some(d => d.mode === 'python') && (
  <p className="px-2 py-1 text-[10px] text-muted-foreground italic">
    Python-mode derived channels are primary-only.
  </p>
)}
```

Keep the change small — the goal is communication, not redesign.

- [ ] **Step 6: Verify type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git add client/src/lib/overlay-types.ts client/src/lib/useXRKStore.ts client/src/components/TelemetryChart.tsx client/src/App.tsx client/src/components/ChannelSidebar.tsx && git commit -m "Overlay derived channels: re-evaluate formulas per overlay session

Each overlay carries a derivedSamples map keyed by primary derived id.
Recomputed on overlay add and whenever the primary's derivedChannels list
changes. Python-mode derived stays primary-only (tooltip explains why)."
```

---

## Phase 7 — Manual verification

No automated UI tests in this codebase. Run the dev server, walk through golden paths and edge cases, and confirm everything renders correctly.

### Task 7.1: Smoke run with two real sessions

**Files:** none — manual verification.

- [ ] **Step 1: Start dev servers**

In one terminal, from the worktree root:

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && ./start.sh
```

(Coordinate with team-lead if another teammate is using the same ports — only one `start.sh` at a time. If conflicts: `lsof -i :8000 -i :5000` and kill stragglers, or kill via the other agent's instructions.)

Open `http://localhost:5000` in the browser.

- [ ] **Step 2: Verify the golden path**

If you don't have two real `.xrk` files locally, ask `team-lead` for sample data. Otherwise:

1. Upload session A. Verify it loads as primary.
2. Click Back, upload session B (or sync from Railway).
3. In SessionBrowser, check the boxes on A and B. Click Load on one of them.
4. Confirm the analysis view shows the primary loaded.
5. Activate one channel (e.g., `Speed`). The chart should show TWO traces: solid (primary) and dashed (overlay). If channel data hasn't fetched yet, wait a beat — the lazy fetcher kicks in via the useEffect.
6. Move the cursor. Both pills should appear (primary value + #1 overlay value beneath).
7. Toggle Δ Delta and place A and B cursors. Delta panel should show overlay columns (#1A, #1B, Δ@A, Δ@B).
8. Click "Overlays: 1 ▾" toolbar button. Popover opens.
9. Change alignment from `Lap` (default) → `Raw`. Trace shifts to the left/right. Switch to `Manual offset`, type a number, see traces shift in real time.
10. Click the eye icon to hide the overlay → trace disappears, popover row dims. Click again → trace returns.
11. Click X to remove overlay → trace gone, popover empty.

- [ ] **Step 3: Verify edge cases**

1. **Channel only in primary:** activate `Brake_Pressure_F` (or anything not in overlay). Primary draws; no overlay trace; no overlay pill. No console errors.
2. **Different units:** if you have two sessions with mismatched units (km/h vs mph for `Speed`, say), the overlay still draws. (Future: legend warning — out of scope here.)
3. **Hide overlay → cursor still works:** move cursor; primary cursor pills present; overlay pills absent.
4. **Add a formula derived channel** (`Speed * 0.621371`). Primary trace appears. Overlay trace appears too (formula re-evaluated against overlay's `Speed`). If overlay had no `Speed`, overlay derived trace is absent.
5. **Add a Python derived channel.** Primary appears, overlay does NOT. Hovering the row shows the "primary-only" tooltip note.
6. **Soft cap:** add a 4th overlay (you'll need 5 sessions). Confirm the "Past 3 overlays the chart may slow down" amber banner shows in the popover.
7. **Close + reopen:** remove all overlays. Click Back to browser. Single-load a session. Verify chart still works exactly like the pre-overlay version (no regressions).
8. **`npm run check`** one more time:

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 4: If anything's broken, file fix tasks**

If you find issues, do NOT mark this plan complete. Use `superpowers:systematic-debugging` to investigate and write fix-up tasks before committing the plan as done.

- [ ] **Step 5: Commit (no code changes — sign-off only if needed)**

If verification surfaces additional polish, fix and commit normally. No commit if everything works as-is.

---

## Phase 8 — Hand-off

### Task 8.1: PR-ready check

- [ ] **Step 1: Run final type check**

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && npm run check
```

Expected: no errors.

- [ ] **Step 2: Push branch and notify team-lead**

(Push only if team-lead instructs — per CLAUDE.md and brief, do NOT push or open PR unless explicitly asked.)

```bash
cd /Users/manthan/Documents/development/quickscope-session-overlay-deltas && git log --oneline origin/main..HEAD
```

- [ ] **Step 3: Mark Task #3 completed**

Use TaskUpdate to set `status: completed` on task #3, then DM `team-lead` with:
- Branch: `feature/session-overlay-deltas`
- Commit count + summary
- Files changed (high-level: backend `state.py` + `routes/{sessions,analysis}.py` + `services/session_cache.py`; frontend `lib/{overlay-types,overlay-alignment,api,useXRKStore,chart-utils,chart-draw,chart-cursors}.ts`, `components/{TelemetryChart,SessionBrowser,OverlayPopover,App,ChannelSidebar}`; CLAUDE.md)
- Known limitations: Python derived stays primary-only by design; channel matching is `shortName`-only (no firmware-version reconciliation); soft cap is advisory.

---

## Self-Review

**Spec coverage check (Q1-Q8):**

- Q1 — per-id LRU cache (4 entries) → Tasks 1.1-1.5. ✅
- Q2 — match by shortName, plot mismatched-units → `findOverlayChannelId` (overlay-types.ts), no units check before draw. ✅ (legend warning is a v2 stretch.)
- Q3 — user-pickable alignment (raw/lap/manual), best-lap default → `defaultAlignment` + `OverlayPopover` AlignmentControls. ✅
- Q4 — multi-select in SessionBrowser → Task 5.1; chart popover for management → Task 5.3. ✅
- Q5 — same-hue, dashed/dotted/dash-dot → `OVERLAY_DASH_PATTERNS` + Task 4.2. Past 3 falls back to solid+brightened with perf warning (Q8 soft cap). ✅
- Q6 — formula-mode derived re-eval per overlay; Python primary-only with tooltip → Tasks 6.1.1-6.1.5. ✅
- Q7 — one cursor cross-session, augmented delta panel; A/B still works orthogonally → Task 4.4. ✅
- Q8 — soft cap 5, warn past 3 → SessionBrowser warn dialog + popover banner. ✅

**Placeholder scan:** none — all code blocks are concrete.

**Type consistency:**
- `OverlayState` defined once (overlay-types.ts), augmented with `derivedSamples` in Task 6.1 — every consumer uses the augmented type because TS imports the same file.
- `OverlayDrawData` defined once (chart-utils.ts), consumed by chart-draw and chart-cursors via `DrawContext.overlays`. ✅
- `addOverlay` returns `{error: string} | {id: string}` consistently. ✅
- `OverlayAlignment` discriminated union — every `switch` is exhaustive. ✅

**Ambiguity check:**
- "Channel matching by shortName" applies only to base channels. Derived channels use the primary's derived id directly (Task 6.1, Step 4). Resolved.
- "Soft cap 5" — phrasing mismatch: brief says "soft cap at 5 with a perf warning past 3". Plan implements: warn at popover open if >3, confirm dialog if >4 in SessionBrowser. Matches the brief: warn-past-3 (advisory) and a separate "really?" gate at the cap.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-03-session-overlay-deltas.md`. The plan-summary will be DM'd to `team-lead` for relay/approval before any task is executed. Per the project brief, no code is written until plan approval.
