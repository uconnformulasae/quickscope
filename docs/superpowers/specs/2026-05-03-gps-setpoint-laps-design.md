# Custom Laps via Per-Session GPS Setpoints

## Summary
Let the user define custom lap-detection points by dropping pins on the GPS map (Leaflet) per session. The first pin (`setpoints[0]`) is the start/finish line; subsequent pins are sector splits in click order. When pins exist, they replace the existing 3-tier auto-detection (`device → gps_auto → beacon_auto`); when none exist, the cascade runs unchanged. Lap detection becomes radius-crossing on each pin. Sector splits are surfaced in `LapAnalysisTab`.

## Decisions
- **Override semantics:** When `lap_setpoints` is non-empty, it fully overrides auto-detection (`lap_source = "gps_manual"`). Empty/null/missing → existing 3-tier cascade.
- **Multi-pin from day one:** 1..N setpoints. First click = start/finish; subsequent clicks = sectors in click order. No drag-reorder for v1 (delete + re-add to reorder).
- **Persistence:** Per-session field on the local session record. **Not** synced to Railway in v1 (follow-up task once Data-Development backend gains the field).
- **Placement UX:** Click-on-map with snap-to-nearest-track-point. Pins draggable when edit mode is on. "Edit setpoints" toggle button in the GPS map's top-right; map clicks only drop pins when edit mode is on. Existing pins remain visible when edit mode is off.
- **Recompute trigger:** On exit-edit-mode (save-on-exit). No live recompute during drag.
- **Per-pin radius:** Single slider 5–50 m, default 15 m. `RETURN_RADIUS_M = radius`, `DEPARTURE_RADIUS_M = 2 × radius` derived per pin. No "advanced" knob for departure-radius in v1.
- **Lap definition under sectors:** Lenient. A lap closes whenever the car returns to the first pin's radius (after `MIN_LAP_S = 10`-second debounce). Sector splits are recorded for whichever sectors were crossed within that lap; missed sectors render as `—` in the UI.
- **`MIN_LAP_S` debounce:** Applies only to start/finish. Sector boundaries are not debounced.
- **LiveView impact:** None for v1. Setpoints are post-session analysis only.
- **Backwards compatibility:** Lazy `dict.get("lap_setpoints", [])`. No migration script for existing `sessions.json` rows.

## Data Model

### Session-record extension (`session_store.py`)
```python
# Added to the entry returned by add_session() / persisted in sessions.json
"lap_setpoints": list[dict] | None  # [{"lat": float, "lon": float, "radius_m": float}, ...]
                                    # Read with dict.get("lap_setpoints", []) for legacy rows.
                                    # Order matters: index 0 = start/finish, 1..N-1 = sectors.
```

Only setter: `update_session(session_id, lap_setpoints=[...])`. Reuses the existing thread-safe atomic-rewrite path.

### Frontend type (`api.ts`)
```ts
export interface LapSetpoint { lat: number; lon: number; radius_m: number; }

// Added to LocalSession:
lap_setpoints: LapSetpoint[] | null;
```

### Lap response shape (`/api/laps`)

Extended to surface sector splits. Backwards-compatible — pre-existing fields unchanged; new fields optional in TS:

```json
{
  "laps": [
    {
      "lapNumber": 1,
      "startTime": 12345.0,
      "endTime": 78901.0,
      "source": "gps_manual",
      "sectorTimes": [12000.5, 33000.0, null]   // ms; null = sector not crossed; absent when no sectors
    }
  ],
  "source": "gps_manual",
  "sectorCount": 3                               // 0 when no sectors; absent for legacy callers — also fine
}
```

`LapSource` union grows: `'device' | 'gps_auto' | 'beacon_auto' | 'gps_manual' | 'none'`.

## API Surface

### New endpoints (in `backend/routes/sessions.py`)

| Method | Path | Body | Behavior |
|---|---|---|---|
| `PUT` | `/api/sessions/{session_id}/setpoints` | `{ "setpoints": [{lat, lon, radius_m}, ...] }` | Validates, writes via `update_session`. Empty list = clear (returns to auto). Returns updated `LocalSession`. |
| `GET` | `/api/sessions/{session_id}/setpoints` | — | Returns `{ "setpoints": [...] }`. Convenience for the dialog before the session is loaded into `state.log`. (Optional — could just read from `listSessions()` cache; keeping it for clarity.) |

Validation in PUT handler:
- Each setpoint: `-90 ≤ lat ≤ 90`, `-180 ≤ lon ≤ 180`, `5 ≤ radius_m ≤ 50`, all finite.
- `len(setpoints) ≤ 16` (sanity cap; FSAE never has more than ~5 sectors).
- 400 on validation failure.

### Modified endpoint

`GET /api/laps` — when `state.session_id`'s record has non-empty `lap_setpoints`, route through the new `from_setpoints()` detector (see below) instead of the cascade. `lap_source = "gps_manual"`. Sector times included in response.

### `api.ts` additions
```ts
export async function updateSetpoints(sessionId: string, setpoints: LapSetpoint[]): Promise<LocalSession>;
export async function getSetpoints(sessionId: string): Promise<LapSetpoint[]>;
```

## Lap Detection (`backend/services/lap_detection.py`)

### New function
```python
def from_setpoints(
    timestamps_ms: list[float],
    lats: list[float],
    lons: list[float],
    setpoints: list[dict],   # [{lat, lon, radius_m}, ...]; index 0 = start/finish
    min_lap_s: float = MIN_LAP_S,
) -> list[dict]:
    """Detect laps + sector splits from user-defined GPS setpoints.

    Returns rows of {lapNumber, startTime, endTime, source: 'gps_manual',
                     sectorTimes: [ms_or_None, ...]}.
    Lap closes on each return to setpoint[0] (after MIN_LAP_S debounce on
    that pin only). Sector i (1..N-1) split = first time in the current
    lap the car enters setpoint[i]'s radius. Missed sector → None.
    """
```

Algorithm sketch (single pass over GPS samples):
1. Filter invalid fixes (mirrors existing `from_gps`).
2. For each setpoint, track `prev_dist`, `inside` flag, `departed` flag.
3. Pin 0 (start/finish): same departure-then-return logic as `from_gps`, with `RETURN = radius_m`, `DEPARTURE = 2 × radius_m`. Each return crossing closes the current lap and opens a new one. `MIN_LAP_S` debounce applies.
4. Pins 1..N-1 (sectors): record the first sample-time per lap where the car enters the radius (transition from `prev_dist > radius` to `dist <= radius`). Reset on each new lap.
5. First lap is treated as starting at first crossing of pin 0 (not at session t=0) — matches `from_gps` semantics.

### `detect_laps()` integration
Add a `setpoints` keyword arg. When non-empty, call `from_setpoints()` and return `(laps, "gps_manual")`. Otherwise the existing cascade is unchanged.

### Routing
`routes/analysis.py /laps` reads `session_store.get_session(state.session_id)["lap_setpoints"]` (default `[]`) and forwards it to `detect_laps()`.

## Frontend Components

### `GPSMapView.tsx` extensions
Becomes the home of setpoint editing. New state inside the component:
- `setpoints: LapSetpoint[]` — local copy, mirrored from session record on mount.
- `editMode: boolean` — toggle.
- `dirty: boolean` — diverged from server.

New UI overlays on the map:
- **Top-right toggle button:** `Edit setpoints` ↔ `Done` (lucide `MapPin` / `Check`). When entering Done, PUT setpoints to backend and ask the parent to refetch laps via the existing `fetchLaps()` machinery (new prop `onSetpointsChanged?: () => void`).
- **Pin markers:** Leaflet markers per setpoint. Pin 0 uses a checkered/flag icon; pins 1..N use numbered circle markers (sector number). Colours from chart-color tokens. Draggable iff `editMode`.
- **Click handler on the Leaflet map:** in `editMode`, drop a new pin at the snapped GPS-track position (see "Snap-to-track").
- **Per-pin radius circle:** `L.circle({lat, lon}, radius_m)` — drawn semi-transparent. Visible always (so the user understands the active geometry).
- **Right-side edit panel** (only when `editMode`): vertical list of pins.
  - Row: `Pin N • [type]` + lat/lon (read-only display) + radius slider (5–50 m, step 1) + delete icon.
  - Bottom: `Clear all setpoints` button.
- **Empty-state hint:** when `editMode && setpoints.length === 0`, the map shows a small floating tooltip "Click on the track to place start/finish".

### Snap-to-track
When the user clicks the map at `(clickLat, clickLon)`:
1. Look at the cached `coords: [lat, lon][]` already filtered in `GPSMapView` (the polyline points).
2. Find the nearest one by haversine.
3. Use that point's `(lat, lon)` for the new setpoint, not the raw click. Default `radius_m = 15`.

### `LapAnalysisTab.tsx` updates
- Source pill: add `gps_manual: 'Manual setpoint'` with class `bg-primary/15 text-primary border-primary/30`.
- Lap rows expand to show sector times when they exist:
  - Compact mode unchanged (single row per lap).
  - When `sectorTimes` present (truthy + length > 0), append a small row of pills under the lap row: `S1: 12.345`, `S2: 18.110`, `S3: —` (em-dash for `null`).
  - **Theoretical-best**: across all laps, find min sector-1 time, min sector-2 time, etc. (ignoring `null`s). Highlight cells matching the per-sector best with the same primary tint as the best-lap pill. Sum-of-bests displayed in the header alongside best-lap when any sectors exist.

### `xrk-parser.ts`
- Extend `LapSource` to include `'gps_manual'`.
- Extend `LapMarker` with optional `sectorTimes?: (number | null)[]` so the marker list can carry the splits without a parallel structure.
- (No data-shape change to `XRKSession`.)

### `App.tsx` wiring
- `buildAndSetSession()` already calls `fetchLaps()`. Extend it to map `sectorTimes` through into the `lapMarkers` it constructs.
- Pass a `refetchLaps` callback down to `AnalysisPanel` → `GPSMapView` so that committing setpoints triggers a re-fetch and the LapAnalysisTab updates without a full session reload.

### `useXRKStore.ts`
- No new state for setpoints (they live on the server via `LocalSession`, fetched fresh whenever needed).
- New helper to update `session.lapMarkers` + `session.lapSource` after a setpoint commit, so the chart re-renders cleanly.

## Edit Flow (UX walkthrough)
1. User opens GPS tab in AnalysisPanel.
2. Clicks "Edit setpoints" → toggle on. Edit panel slides in on the right of the map. Pin tooltip appears if no pins yet.
3. Clicks the racing line near start/finish → snapped first pin (checkered) drops with default 15 m radius circle.
4. Clicks at a corner → snapped second pin drops, numbered "S1" (sector 1).
5. Adjusts the second pin's radius slider to 8 m (a tight chicane).
6. Drags the start/finish pin slightly along the line.
7. Clicks "Done" → PUT `/api/sessions/{id}/setpoints`, then `fetchLaps()` re-runs, LapAnalysisTab updates with sector splits, chart lap markers update.
8. Source pill in LapAnalysisTab now reads `Manual setpoint` (blue).
9. To revert: edit mode → "Clear all setpoints" → Done. PUT empty list. `lap_source` returns to auto (whichever auto tier wins).

## Edge Cases
- **No GPS in session:** Edit toggle is hidden. Existing GPSMapView "No GPS Data" empty state is unchanged.
- **GPS but no track polyline (< 2 valid points):** Edit toggle hidden; same logic.
- **User places only sectors, no start/finish:** Cannot happen — the first pin placed is always the start/finish (`setpoints[0]`). Deleting the start/finish pin promotes `setpoints[1]` to start/finish (if it exists), otherwise clears all.
- **Setpoint placed off-track (snap miss when racing line was off-screen on click):** Snap always finds *some* nearest point because the polyline is fully cached. No "miss" case.
- **Radius slider range underflow:** Clamped client-side to `[5, 50]`, rejected server-side outside `[5, 50]`.
- **Concurrent edits on multiple QuickScope installs:** Last write wins. Acceptable — single-user app, sync conflicts not a real concern.
- **Session reload mid-edit:** Discards local unsaved changes. Edit panel loses state on tab switch. Acceptable for v1; we can add a "you have unsaved changes" guard later.
- **Legacy laps tab shows the old `Auto-detected (GPS)` pill:** Only when `lap_setpoints` is empty/missing. Unchanged behaviour.
- **`gps_manual` cascade in the override case:** If GPS data exists but is too short (< 10 valid samples), `from_setpoints()` returns `[]` and `source` is still `"gps_manual"` (not falling back to other tiers — explicit user choice should not silently revert). LapAnalysisTab shows the "no markers" empty state with the manual pill.

## Future Work (out of scope for v1)
- **Data-Development sync:** Add `lap_setpoints` to the Railway session schema; gate push/pull behind a feature probe in `railway_client.py`.
- **Per-track setpoint reuse:** Auto-suggest setpoints from a previous session at the same `track_name` or GPS bbox.
- **Drag-reorder pins:** Re-assign which pin is start/finish without delete + re-add.
- **Lat/lon text entry:** For surveyed coordinates.
- **LiveView lap counting:** Drive live lap timer from a "current track" setpoint stored in settings.
- **Sector-overlay on the chart:** Vertical lap markers on the telemetry chart could colour-code sectors.

## Files Touched
- `backend/services/lap_detection.py` — add `from_setpoints()`; extend `detect_laps()` signature.
- `backend/services/session_store.py` — no schema change (lazy default reads); `update_session()` already accepts arbitrary kwargs.
- `backend/routes/sessions.py` — PUT/GET `/setpoints`.
- `backend/routes/analysis.py` — `/laps` reads setpoints, calls extended `detect_laps()`, returns `sectorTimes`.
- `client/src/lib/api.ts` — new types and helpers.
- `client/src/lib/xrk-parser.ts` — `LapSource` and `LapMarker` extensions.
- `client/src/components/GPSMapView.tsx` — edit mode, pin markers, edit panel, PUT on save.
- `client/src/components/analysis/LapAnalysisTab.tsx` — `gps_manual` pill, sector splits row, theoretical-best.
- `client/src/App.tsx` — wire `refetchLaps` through to `GPSMapView`; carry `sectorTimes` through `buildAndSetSession`.

## Out of Scope / Non-Goals
- No backend changes to Data-Development.
- No new Electron/preload/build changes.
- No PyInstaller spec changes (no new dependencies).
- No tests for Leaflet interaction (rendering is CDN-loaded; same as the rest of the GPSMapView). Backend `from_setpoints()` gets unit tests.
