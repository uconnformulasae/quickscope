# Customizable Live View Implementation Plan

> Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The live dashboard always renders, whether or not a car is connected. The header indicator shows the connection state. Users can build, save, and share their own dashboards, so the IC and EV teams can each run the setup they need.

**Why:** Right now `LiveView.tsx` renders `EVDashboard` or `ICDashboard` only when `status` is `streaming` or `paused`. When disconnected you get an empty "Live stream stopped" card, and the layouts are hardcoded in TSX. That means nobody can change or even preview a dashboard without being on the car's WiFi.

**Decisions (confirmed with user):**

| Question | Decision |
|---|---|
| Customization depth | Widget grid editor: add, remove, drag, and resize widgets, each bound to a channel |
| Storage | Backend `data/live_layouts.json`, plus JSON Import/Export for sharing between laptops |
| Layout selection | Multiple named layouts, each tagged `ev` or `ic`. Offline shows the last-used layout. On connect, auto-switch to the last-used layout for that car unless the user pinned one |
| Channel picker source | Built-in EV/IC lists + a cached list of channels each car actually sent + free-text entry |

**Tech stack:** React 18, Tailwind, FastAPI, `react-grid-layout` (new dependency, see Task 4).

---

## Implementation notes (2026-10-19)

All phases landed together on `feature/customizable-live-view`. Where the build differs from the plan below:

- **Widget types consolidated.** `stats` (with `style: big | tile | compact`) replaces `bigStat` / `stat` / `quad`. `bars` holds several bars, not one. `boolLight` is folded into `boolGroup`, and `label` became `note`. Channels can also be **formulas** (formula-engine syntax, evaluated per snapshot). This is how EV "Pack Power" is built without a special case.
- **Task 2 skipped (`- [~]`).** There's no interim `EV | IC` toggle, because the layout picker shipped in the same change.
- **Built-ins are never modified, so there's no "Reset".** Edit on a built-in starts a copy. "Rename" happens in edit mode (Electron has no `window.prompt`).
- **Selection route is `PUT /api/live/layout-selection`**, not `/layouts/selection`, so it can't collide with a layout id.
- **The channel cache is filled from snapshot keys in the live WS route**, not from the layout parser. Names only (no units), merged per car, written off the device pump thread only when a new name appears.
- **Narrow screens (< 768 px) render a plain stacked column** at natural height, not a react-grid-layout `sm` breakpoint (fixed row heights clipped content).
- **Save failures show an error banner** (no toast system in the app).
- **Bugs found along the way:** `measureBeforeMount` on react-grid-layout 1.4.4's `WidthProvider` leaves every item 0 px wide, so it isn't used. And `useLiveStream` kept the pause flag across disconnect → reconnect, which silently dropped every snapshot. `disconnect()` now clears it.

---

## Current state (reference)

- `client/src/components/LiveView.tsx`: header with status pill, action bar (Connect/Pause/Disconnect), and `main`, which picks the dashboard via `vehicleKind(device?.vehicle)` only while live.
- `client/src/components/live/EVDashboard.tsx`, `ICDashboard.tsx`: hand-built panels (Pack hero, Accumulator, Cooling, Vehicle, Status & Faults, Inverter, Other channels, Stream health / Engine, Chassis, Brakes, Tires, Status, Other).
- `client/src/components/live/widgets.tsx`: `Panel`, `BigStat`, `CoolStat`, `VehicleStat`, `fmt`, `directionLabel`.
- `client/src/components/live/live-channels.ts`: `CHANNEL_META`, `BOOL_CHANNELS`, `IC_*` lists, `*_PANEL_OWNED_CHANNELS`, `vehicleKind()`.
- `client/src/components/live/useLiveStream.ts`: WS state machine (`idle | connecting | streaming | paused | error`). It auto-connects when `aimDevice` is passed.
- `backend/services/settings_store.py`: the JSON-in-`DATA_DIR` pattern to copy (atomic write, corrupt-file recovery).

---

## Phase 1: Always show the dashboard

This phase can ship on its own before the editor exists.

### Task 1: Render the dashboard in every state

**Files:** Modify `client/src/components/LiveView.tsx`

- [x] Remove the `isLive &&` guard around the dashboard. Always render the active layout.
- [x] When not streaming, pass `latest={null}` (or the last snapshot, see below). Widgets already render `—` through `fmt()` when a value is undefined. Check that every widget handles a missing value (bars at 0, bool lights neutral grey rather than red or green).
- [x] Turn the error, connecting, and idle center cards into a **slim banner** above the grid, so they don't replace it:
  - idle: "Not connected. Showing layout preview." with a Connect button
  - connecting: spinner + "Connecting to {vehicle} at {ip}…"
  - error: the current red message + Retry
- [x] Keep the last values on screen after a disconnect, dimmed (`opacity-60`), with a "Last values · {time ago}" note in the banner. `useLiveStream` already keeps `latest` through reconnects; don't clear it on `disconnect()`.
- [x] Add an explicit **Disconnected** state (grey dot) to the header status indicator, so it is never blank.

### Task 2: Pick EV vs IC while offline

**Files:** Modify `LiveView.tsx`

- [~] Until Phase 2 lands, add a small `EV | IC` segmented toggle in the action bar. It is enabled when not connected. On connect it follows `vehicleKind(device.vehicle)`.
- [~] Phase 2 replaces this toggle with the layout picker.

### Task 3: Live button copy

**Files:** Modify `client/src/components/SessionBrowser.tsx`

- [x] Change the not-connected tooltip to "Open live view (offline preview: AiM device not reachable)". The button already works when offline. Only the wording needs to reflect the new behavior.

---

## Phase 2: Layout model and widget grid

### Task 4: Choose the grid library

- [x] Add `react-grid-layout` (pin an exact version, e.g. `1.4.4`) and `@types/react-grid-layout` to root `package.json`. It gives drag, resize, collision handling, and responsive breakpoints. Building this on CSS grid would be a lot of work.
- [x] Use `Responsive` + `WidthProvider` with a 12-column `lg` breakpoint to match today's `lg:grid-cols-12`. For `sm`, stack widgets in a single column in layout order. Don't store a separate mobile layout.

### Task 5: Layout schema

**Files:** Create `client/src/components/live/layout-schema.ts`

```ts
export type WidgetType =
  | 'bigStat'      // large value + unit (BigStat)
  | 'stat'         // compact value tile (VehicleStat / CoolStat)
  | 'bar'          // horizontal bar w/ min/max (throttle, SOC, pack V)
  | 'boolLight'    // single state/fault pill
  | 'boolGroup'    // grid of state/fault pills (Status & Faults)
  | 'gForce'       // lateral/inline friction circle
  | 'quad'         // 4 corners (wheel speeds, tire/brake temps)
  | 'otherChannels'// auto list of channels not used elsewhere in the layout
  | 'streamHealth' // rate, total received, last ts
  | 'label';       // section heading / divider

export interface WidgetConfig {
  id: string;                 // uuid
  type: WidgetType;
  title?: string;
  channels: string[];         // 1 for stat/bar/boolLight, 2 for gForce, 4 for quad, N for boolGroup
  unit?: string;              // override CHANNEL_META
  precision?: number;
  min?: number; max?: number; // bar range + color thresholds
  warn?: number; crit?: number;
  boolKind?: 'state' | 'fault';
  tone?: 'default' | 'primary';
}

export interface LiveLayout {
  id: string;
  name: string;
  vehicle: 'ev' | 'ic';
  version: 1;
  grid: { i: string; x: number; y: number; w: number; h: number }[]; // react-grid-layout items, i === widget.id
  widgets: WidgetConfig[];
  builtIn?: boolean;          // shipped defaults: can be duplicated and reset, not deleted
  updatedAt: string;
}
```

- [x] Add `validateLayout(json: unknown): LiveLayout`. Imports and backend data must pass it. Drop unknown widget types with a warning rather than failing the whole layout.

### Task 6: Widget renderer

**Files:**
- Create: `client/src/components/live/WidgetRenderer.tsx`
- Modify: `client/src/components/live/widgets.tsx`

- [x] `WidgetRenderer({ widget, latest, layout })` switches on `widget.type` and reuses the existing `BigStat`/`VehicleStat`/`CoolStat` primitives. Unit and precision fall back to `CHANNEL_META` and then to the cached device channel info.
- [x] Move the bespoke visuals now inline in `EVDashboard`/`ICDashboard` (pack bar, g-force dot, bool pills, corner quads) into `widgets.tsx` as reusable components.
- [x] `otherChannels` computes "every channel in `latest.channels` not referenced by any widget in this layout". This replaces `PANEL_OWNED_CHANNELS` / `IC_PANEL_OWNED_CHANNELS`.
- [x] Wrap each widget in `Panel` so the look stays as it is now.

### Task 7: Port the current dashboards to built-in layouts

**Files:**
- Create: `client/src/components/live/default-layouts.ts`
- Delete after parity: `EVDashboard.tsx`, `ICDashboard.tsx`

- [x] Express today's EV and IC dashboards as `LiveLayout` objects (`builtIn: true`, ids `builtin-ev`, `builtin-ic`). Do a side-by-side visual check against the old components using the replay/preview stream before deleting them.
- [x] Remove the EV-specific constants that only the old layout used (`PACK_V_MAX` and the others become widget `max`/`warn` values).

---

## Phase 3: Persistence and channel cache (backend)

### Task 8: Layout store

**Files:**
- Create: `backend/services/live_layout_store.py`
- Create: `backend/routes/live_layouts.py`
- Modify: `backend/main.py` (`include_router`)

- [x] Copy the `settings_store.py` pattern: `DATA_DIR / "live_layouts.json"`, lock, atomic `os.replace`, rename a corrupt file to `.corrupt`.
- [x] File shape: `{ "layouts": [...], "active": { "ev": "<id>", "ic": "<id>" }, "pinned": "<id>|null", "last_used": "<id>" }`.
- [x] The backend stores layouts as opaque JSON and only checks `id`, `name`, `vehicle`, and size (reject over 256 KB). The frontend owns the schema.
- [x] Routes:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/live/layouts` | GET | All user layouts + selection state (built-ins come from the client) |
| `/api/live/layouts/{id}` | PUT | Create or replace a layout |
| `/api/live/layouts/{id}` | DELETE | Delete a user layout |
| `/api/live/layouts/selection` | PUT | Update `active` / `pinned` / `last_used` |

### Task 9: Device channel cache

**Files:**
- Modify: `backend/services/aim_live.py` (or wherever the parsed `ChannelField` list becomes available)
- Create: `backend/services/live_channel_cache.py`
- Modify: `backend/routes/live.py`

- [x] When a live layout frame is parsed, write `{vehicle_kind: {vehicle_name, serial, seen_at, channels: [{name, unit?}]}}` to `DATA_DIR/live_channels.json`. Only write when the channel set changes.
- [x] Add `GET /api/live/channels?vehicle=ev|ic` to return the cached list.

### Task 10: Frontend API and hook

**Files:**
- Modify: `client/src/lib/api.ts`
- Create: `client/src/components/live/useLiveLayouts.ts`

- [x] Add API functions for the routes above.
- [x] `useLiveLayouts()` merges the built-ins with the user layouts and exposes `layouts`, `active`, `setActive(id)`, `pin(id|null)`, `save(layout)`, `remove(id)`, `duplicate(id)`, and `resetBuiltIn(id)`. Saves are optimistic, with a rollback + toast on failure.
- [x] **Selection rules:**
  - Offline: show `last_used` (fall back to `builtin-ev`).
  - On a `connected` message: if `pinned` is set, keep it. Otherwise switch to `active[vehicleKind(device.vehicle)]`.
  - Selecting a layout sets `last_used` and `active[layout.vehicle]`.
  - If the pinned layout's vehicle doesn't match the connected car, show a small amber notice in the banner ("Layout is for IC, car is EV"). Don't auto-switch.

---

## Phase 4: Editor UI

### Task 11: Layout picker in the action bar

**Files:** Modify `LiveView.tsx`

- [x] Replace the Phase 1 `EV | IC` toggle with a dropdown grouped by vehicle (`EV` / `IC` headings, built-ins marked). Next to it: a pin toggle, **Edit**, and a `⋯` menu with Duplicate, Rename, Export, Import, Delete, and Reset (Reset for built-ins only).

### Task 12: Edit mode

**Files:**
- Create: `client/src/components/live/LayoutEditor.tsx`
- Create: `client/src/components/live/WidgetConfigDialog.tsx`

- [x] Edit mode turns on `isDraggable`/`isResizable`, shows a dashed outline per widget with ✎ (configure) and ✕ (remove) buttons, and adds an **Add widget** button.
- [x] Editing a built-in creates a copy first ("EV default (copy)") so built-ins stay unchanged.
- [x] Changes stay local until the user clicks **Save**. **Cancel** discards them. Warn on Back if there are unsaved changes.
- [x] Streaming keeps running during edit mode, so values update while you arrange.
- [x] `WidgetConfigDialog` has: type, title, channel picker(s), unit/precision override, and min/max/warn/crit for numeric types. Reuse the modal styling from `DerivedChannelDialog.tsx`.

### Task 13: Channel picker

**Files:** Create `client/src/components/live/ChannelPicker.tsx`

- [x] A searchable combobox over three sources, deduplicated and labeled:
  1. **Live now**: keys of `latest.channels` (when connected)
  2. **Seen on {vehicle}**: from `/api/live/channels`
  3. **Built-in**: `CHANNEL_META`, `BOOL_CHANNELS`, `IC_*`
- [x] Allow free text. Mark a channel the selected vehicle has never sent with a muted "not seen" tag rather than blocking it.

### Task 14: Import / Export

- [x] Export downloads `{name}.qslayout.json`, a single `LiveLayout` (in Electron, use the existing save-file path if there is one, otherwise a Blob download).
- [x] Import uses a file picker, then `validateLayout`, assigns a new `id` if it collides, and appends " (imported)" to the name if the name collides.

---

## Phase 5: Tests and docs

### Task 15: Tests

- [x] `client/src/components/live/layout-schema.test.ts`: validation, dropping unknown widgets, `otherChannels` computation.
- [x] Selection-rule unit tests (pure function extracted from `useLiveLayouts`): offline, connect without a pin, connect with a pin, vehicle mismatch.
- [x] `tests/` backend: layout store CRUD, corrupt-file recovery, size limit, channel cache only writing when the set changes.
- [x] Manual: open Live with no WiFi and confirm the grid renders with `—` values. Connect to the EV and IC rigs and confirm auto-switch and pin behavior. Export a layout on one laptop and import it on another.

### Task 16: Docs

- [x] Update `AGENT.md` (new live/ files, new endpoints) and `README.md` features ("customizable live dashboards").

---

## Open questions / risks

- **Grid library bundle size.** `react-grid-layout` adds about 40 KB gzipped. Acceptable for the desktop app. Revisit if that's a concern.
- **Render cost.** `latest` updates at the snapshot rate and every widget re-renders. If profiling shows jank with about 40 widgets, memoize `WidgetRenderer` on `(widget, value)` per channel.
- **Layout schema migrations.** `version: 1` is in place now. Add a `migrateLayout()` when the schema changes.
