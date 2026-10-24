# Port Customizable Live View onto the Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `13-codebase-audit` gains the always-on, user-customizable EV/IC live dashboard from `feature/customizable-live-view`, with every audit fix kept.

**Architecture:** The feature (commit `040a65c`) and the audit (`8b96470`, `6461e7f`) both branch from `5536b44`. We cherry-pick the feature commit onto `13-codebase-audit` (no merge commits, no other branch touched), resolve the six conflicts mechanically, then restore the feature behaviors the mechanical resolution drops, test-first. No design changes to the feature: its grid editor, backend layout store, EV/IC built-ins, channel picker and import/export stay as built.

**Tech Stack:** React 18 + Vite + Vitest/jsdom, `react-grid-layout@1.4.4`, FastAPI + pytest.

**Spec:** `docs/superpowers/plans/2026-10-19-customizable-live-view.md` (on the feature branch — the feature's own design + implementation notes) and `~/Downloads/COMPREHENSIVE_AUDIT_REPORT.md` (the audit). Decisions confirmed with the user on 2026-10-20: port as-is, full grid editor, backend file + JSON import/export storage. Work lands on `13-codebase-audit`; nothing is merged anywhere; it is pushed only after it has been tested connected to the car.

## Global Constraints

- Every audit fix stays in effect. In particular: `backend/origins.py` origin check on the live WebSocket, `app://quickscope` Electron scheme, `useLiveStream` auto-reconnect with backoff, hub lock released on any WS failure, no `GPS_*` ghost channels in `CHANNEL_META`.
- Branch: `13-codebase-audit` only. Bring the feature in with `git cherry-pick`, never `git merge`. Do not merge into `Dev`, `main` or `feature/customizable-live-view`, and open no PRs.
- Do not push until Task 5's on-car checks pass and the user signs off. Then push only `13-codebase-audit` (fast-forward, no force-push).
- `react-grid-layout` stays pinned at exactly `1.4.4`.
- Backend data files live under `settings_store.DATA_DIR` (writable in the packaged app), never next to the code.
- Done = `python3 -m pytest tests/ -q` green, `npx vitest run --root client` green, `npx tsc --noEmit -p .` clean.

## Review Focus

1. **Mid-stream WiFi drop with auto-reconnect** — the dashboard must keep the current layout and last values; the reconnect must not trigger the "on connect, switch to the car's layout" rule or kick the user out of edit mode. (Hook keeps `status === 'streaming'` while `reconnecting`, so `connectedKind` never changes — pinned by a Task 2 test.)
2. **Packaged app saving/deleting a layout** — PUT/DELETE from `app://quickscope` needs a CORS preflight that the audit's origin allowlist must pass, while a foreign site's preflight must fail. (Task 4 test.)
3. **Disconnect then Connect** — not stuck paused, stream counter restarts, last values stay on screen (dimmed) in between. (Task 2 tests.)
4. **Opening Live with no car ever connected** — every widget shows `—`; no red `DISABLED`, no fake `0.0 kW`. (Task 3 tests, ported from the audit's `EVDashboard.test.tsx`.)
5. **A second window opening Live while another streams** — gets the hub's "already open in another window" error in the banner, but its dashboard grid still renders offline. (Task 5 manual check.)

---

## File Map

| File | Change | Task |
|---|---|---|
| `backend/main.py`, `tests/conftest.py`, `tests/test_live_ws_route.py`, `package-lock.json` | Conflict resolution (union of both sides) | 1 |
| `client/src/components/live/EVDashboard.tsx`, `EVDashboard.test.tsx` | Delete (feature replaced it with layouts) | 1 |
| `client/src/components/live/useLiveStream.ts` | Conflict → audit side, then re-add feature behaviors | 1, 2 |
| `client/src/components/live/useLiveStream.test.tsx` | Add disconnect/reconnect tests | 2 |
| `client/src/components/live/LiveDashboard.test.tsx` | Create: EV/IC built-in layout regression tests | 3 |
| `client/src/test/dom-setup.ts` | Add `window.matchMedia` stub | 3 |
| `tests/test_live_layouts.py` | Add CORS preflight tests | 4 |
| `backend/services/live_layout_store.py:16-17`, `backend/services/live_channel_cache.py:19-20` | Import `DATA_DIR` from `settings_store` | 4 |

---

### Task 1: Cherry-pick the feature commit onto `13-codebase-audit`

**Files:** Modify `backend/main.py`, `tests/conftest.py`, `tests/test_live_ws_route.py`, `client/src/components/live/useLiveStream.ts`, `package-lock.json`. Delete `client/src/components/live/EVDashboard.tsx`, `client/src/components/live/EVDashboard.test.tsx`.

**Interfaces:**
- Produces: a `13-codebase-audit` commit where `useLiveStream()` is exactly the audit version plus the feature's auto-merged `receivedAt: number | null` state/return field. Task 2 builds on this.

- [ ] **Step 1: Confirm the branch and take a baseline**

```bash
git checkout 13-codebase-audit && git status --short   # only this plan file untracked
python3 -m pytest tests/ -q && npx vitest run --root client
```
Expected: both green (record the counts). `git add` this plan file in Step 4.

- [ ] **Step 2: Cherry-pick**

Run: `git cherry-pick -x 040a65c`
Expected (confirmed by a dry run on 2026-10-20): conflicts in exactly `backend/main.py`, `client/src/components/live/EVDashboard.tsx` (modified here, deleted by the feature), `client/src/components/live/useLiveStream.ts`, `package-lock.json`, `tests/conftest.py`, `tests/test_live_ws_route.py`. `backend/routes/live.py`, `live-channels.ts`, `api.ts`, `SessionBrowser.tsx`, `index.css`, `package.json` auto-merge — leave them. In a cherry-pick, "ours" is the audit branch and "theirs" is the feature commit.

- [ ] **Step 3: Resolve each conflict**

- `backend/main.py`: keep both — `from origins import ALLOWED_ORIGINS, ALLOWED_ORIGIN_REGEX` and `from routes import sessions, analysis, settings, live, live_layouts`.
- `tests/conftest.py`: union — import `aim_download_trace, aim_live_trace, live_channel_cache, live_layout_store, session_store, settings_store`; keep both monkeypatch blocks (layout/channel stores *and* the two trace dirs).
- `tests/test_live_ws_route.py`: keep both sides in full (feature's `test_live_ws_caches_seen_channel_names_for_the_offline_editor` and the audit's `_RecordingHub` + four tests).
- `useLiveStream.ts`: take the **ours** (audit) side of both hunks (no `setTotalReceived(0)` in `openSocket`; `disconnect` uses `closeIntentionally()`). Keep the auto-merged `receivedAt` lines. Task 2 restores the feature behavior on top.
- `EVDashboard.tsx`: `git rm` it. Its audit fixes already exist in the feature as `default-layouts.ts` (Pack Power is the formula `Pack_Voltage * Pack_Current / 1000`; `BMS_Disch_Enable` uses `format: 'onoff'`, which renders `—` when missing).
- `EVDashboard.test.tsx` (added by the audit, imports the deleted component): `git rm` it. Task 3 replaces it.
- `package-lock.json`: `git checkout --ours package-lock.json && npm install` (adds the feature's `react-grid-layout`), then confirm `package.json` lists `react-grid-layout` `1.4.4`, `leaflet`, `@testing-library/react`, `jsdom`.

- [ ] **Step 4: Verify and finish the cherry-pick**

```bash
git grep -n '^<<<<<<<\|^>>>>>>>' -- . ':!*.md' ; python3 -m pytest tests/ -q && npx vitest run --root client && npx tsc --noEmit -p .
```
Expected: no markers; all green, including `test_live_ws_caches_seen_channel_names_for_the_offline_editor` (proves the channel-cache hook survived being moved into the audit's `_stream_session()`).

```bash
git add -A && git add docs/superpowers/plans/2026-10-20-port-customizable-live-view.md
git cherry-pick --continue --no-edit
```
Expected: one new commit on `13-codebase-audit`, "custom live view", with "(cherry picked from commit 040a65c…)" in its message. `git log --merges 6461e7f..HEAD` prints nothing. Don't push yet (see Task 5).

---

### Task 2: Restore the feature's disconnect behavior in `useLiveStream`

**Files:** Modify `client/src/components/live/useLiveStream.ts` (`connect`, `disconnect`). Test: `client/src/components/live/useLiveStream.test.tsx` (reuse its `FakeSocket`, `streaming()`, `device` helpers).

**Interfaces:**
- Consumes: Task 1's hook.
- Produces (unchanged signature): `useLiveStream(aimDevice)` → `{ status, device, error, reconnecting, latest, totalReceived, receivedAt, connect, disconnect, togglePause }`. `LiveView.tsx` relies on `latest` surviving `disconnect()` to show dimmed last values.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps the last values on screen after the user disconnects', () => {
  const { hook } = streaming();
  act(() => hook.result.current.disconnect());
  expect(hook.result.current.status).toBe('idle');
  expect(hook.result.current.latest?.channels?.RPM).toBe(1000);
  expect(hook.result.current.receivedAt).not.toBeNull();
});

it('a fresh connect after a paused disconnect streams again and restarts the counter', () => {
  const { hook } = streaming();
  act(() => { hook.result.current.togglePause(); hook.result.current.disconnect(); hook.result.current.connect(); });
  act(() => {
    latestSocket().open();
    latestSocket().message({ type: 'connected', device });
    latestSocket().message({ type: 'snapshot', ts: 2, subsystem: 'Syst', channels: { RPM: 2000 } });
  });
  expect(hook.result.current.status).toBe('streaming');
  expect(hook.result.current.totalReceived).toBe(1);
  expect(hook.result.current.latest?.channels?.RPM).toBe(2000);
});

it('a dropped stream stays "streaming" while reconnecting and keeps counting after', () => {
  const { hook, ws } = streaming();
  act(() => ws.fireClose());
  expect(hook.result.current.status).toBe('streaming'); // so the layout auto-switch never re-fires
  act(() => { vi.advanceTimersByTime(1000); });
  act(() => {
    latestSocket().open();
    latestSocket().message({ type: 'connected', device });
    latestSocket().message({ type: 'snapshot', ts: 2, subsystem: 'Syst', channels: { RPM: 2000 } });
  });
  expect(hook.result.current.totalReceived).toBe(2);
});
```

- [ ] **Step 2: Run to verify the first two fail**

Run: `npx vitest run --root client src/components/live/useLiveStream.test.tsx`
Expected: "keeps the last values" FAILS (`latest` is null); "fresh connect" FAILS (status `paused`). The third may already pass — it pins Review Focus #1.

- [ ] **Step 3: Implement**

In `disconnect()`: drop `setTotalReceived(0)` and `setLatest(null)`; add `pausedRef.current = false`. In `connect()` (user-initiated only, not `openSocket`, so a reconnect keeps counting): add `setTotalReceived(0)`.

- [ ] **Step 4: Run the client suite**

Run: `npx vitest run --root client && npx tsc --noEmit -p .`
Expected: all green — including the audit's existing six reconnect tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/live/useLiveStream.ts client/src/components/live/useLiveStream.test.tsx
git commit -m "fix(live): keep last values and clear pause on disconnect after merging reconnect logic"
```

---

### Task 3: Port the audit's EV dashboard regression tests to the layout system

**Files:** Create `client/src/components/live/LiveDashboard.test.tsx`. Modify `client/src/test/dom-setup.ts`.

**Interfaces:**
- Consumes: `LiveDashboard({ layout, latest, totalReceived, stale, editing, onGridChange, onEditWidget, onRemoveWidget })`, `EV_DEFAULT_LAYOUT` / `IC_DEFAULT_LAYOUT` from `default-layouts.ts`, `CHANNEL_META` / `BUILTIN_CHANNELS` from `live-channels.ts`.

- [ ] **Step 1: Stub `matchMedia` in `dom-setup.ts`**

`window.matchMedia ??=` a stub returning `{ matches: false, addEventListener() {}, removeEventListener() {} }`. `matches: false` selects `LiveDashboard`'s narrow stacked-column path, so tests never mount `react-grid-layout` (which needs real layout).

- [ ] **Step 2: Write the tests** (`// @vitest-environment jsdom`, import `../../test/dom-setup` first; render with `stale={false} editing={false}` and no-op callbacks)

- `EV built-in with no data shows no reading instead of a red DISABLED or fake 0.0 kW`: `latest={null}` → `queryByText('DISABLED')`, `queryByText('ENABLED')`, `queryByText('0.0')` all null.
- `EV built-in computes pack power and shows discharge enabled`: channels `{ Pack_Voltage: 400, Pack_Current: 50, BMS_Disch_Enable: 1 }` → `getByText('20.0')` and `getByText('ENABLED')`.
- `EV built-in flags DISABLED only when the car reports 0`: `{ BMS_Disch_Enable: 0 }` → `getByText('DISABLED')`.
- `IC built-in renders with no data`: `IC_DEFAULT_LAYOUT`, `latest={null}` → `queryByText('0.0')` null.
- `no ghost GPS channels are offered`: `CHANNEL_META` and `[...BUILTIN_CHANNELS.ev, ...BUILTIN_CHANNELS.ic]` contain no name starting `GPS_`.

- [ ] **Step 3: Run**

Run: `npx vitest run --root client src/components/live/LiveDashboard.test.tsx`
Expected: PASS (the feature already implements these; these tests lock them in). Any failure is a real regression of an audit fix — fix it in `WidgetRenderer.tsx` (`displayValue`/`toneFor`), not in the test.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/live/LiveDashboard.test.tsx client/src/test/dom-setup.ts
git commit -m "test(live): port EV dashboard audit regressions to built-in layouts"
```

---

### Task 4: Align the feature's backend with the audit (origins + data dir)

**Files:** Test: `tests/test_live_layouts.py`. Modify `backend/services/live_layout_store.py:16-17`, `backend/services/live_channel_cache.py:19-20`.

- [ ] **Step 1: Write the failing-or-pinning tests**

```python
def _preflight(origin):
    return client.options("/api/live/layouts/x", headers={
        "Origin": origin, "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
    })

def test_layout_writes_allowed_from_packaged_app_origin():
    res = _preflight("app://quickscope")
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "app://quickscope"

def test_layout_writes_refused_from_foreign_or_null_origin():
    for origin in ("https://evil.example", "null"):
        assert "access-control-allow-origin" not in _preflight(origin).headers

def test_layout_stores_use_the_shared_data_dir():
    from services import live_channel_cache, live_layout_store, settings_store
    assert live_layout_store.DATA_DIR is settings_store.DATA_DIR
    assert live_channel_cache.DATA_DIR is settings_store.DATA_DIR
```
(`client` is the module-level `TestClient(app)` already in this file. `conftest.py` monkeypatches `DATA_DIR` on all three modules to the same path object, so the identity check holds under the fixture too — if it doesn't, compare with `==`.)

- [ ] **Step 2: Run** — `python3 -m pytest tests/test_live_layouts.py -q`. Expected: CORS tests PASS (pin Review Focus #2); data-dir test FAILS (each store builds its own `Path`).

- [ ] **Step 3: Implement** — in both stores replace the `_DEFAULT_DATA_DIR`/`DATA_DIR = Path(os.environ…)` pair with `from services.settings_store import DATA_DIR`; drop imports left unused.

- [ ] **Step 4: Run** — `python3 -m pytest tests/ -q`. Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add backend/services/live_layout_store.py backend/services/live_channel_cache.py tests/test_live_layouts.py
git commit -m "fix(live): share DATA_DIR with settings store; pin layout CORS for app:// origin"
```

---

### Task 5: Verify offline, test on the car, then push `13-codebase-audit`

Nothing leaves this machine until Step 3 passes on the car and the user signs off.

- [ ] **Step 1: Automated suite** — `python3 -m pytest tests/ -q && npx vitest run --root client && npx tsc --noEmit -p . && npm run build`. Expected: all green, build succeeds.
- [ ] **Step 2: Offline checks in Electron** (`npm run build` then `npm run electron:dev`, so the page loads from `app://quickscope` like the packaged app)
  - No car WiFi: open Live → EV default grid renders with `—`, header shows Disconnected (Review Focus #4).
  - Edit → add a widget → Save; quit and relaunch → layout persists (proves the `app://` origin can save — Review Focus #2). Export it, Import it back → "(imported)" copy appears.
- [ ] **Step 3: On the car (user runs these; record pass/fail for each)**
  - EV car: Connect → switches to the EV layout; values stream; channel picker lists "Live now" channels.
  - Toggle laptop WiFi off ~5 s, back on → "Reconnecting", then streaming resumes on the **same** layout with values kept (Review Focus #1). Repeat while in edit mode → draft not lost.
  - Disconnect → values stay dimmed with "Last values" note; Connect → fresh counter, not paused (Review Focus #3).
  - Open a second QuickScope window → Live: grid renders, banner shows "Live view is already open in another window" (Review Focus #5).
  - IC car: auto-switches to the IC layout; a pinned EV layout stays pinned with the amber mismatch notice.
  - Any failure: fix it as a new commit on `13-codebase-audit` (test first where it can be reproduced off the car), then repeat Step 3.
- [ ] **Step 4: Push (only after the user signs off on Step 3)**

```bash
git log --merges 6461e7f..HEAD   # expect no output: nothing was merged
git push origin 13-codebase-audit
```
Expected: a fast-forward push. No PR, and no merge into `Dev`, `main` or `feature/customizable-live-view`.

---

## Out of Scope

- Merging `13-codebase-audit` anywhere (`Dev`, `main`). When that happens later, note that `origin/Dev` has the TCP refactor (`655219d`, PR #16), which conflicts with the audit in `backend/routes/sessions.py`, `backend/services/aim_connector.py` and `tests/test_aim_pull_sequence.py`.
- `feature/customizable-live-view` itself stays as it is on `origin`.
- The audit's other open items (live int16 voltage/IMU scaling, pull-capture fixtures, DLL-only tests).
