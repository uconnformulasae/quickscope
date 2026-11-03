# Analysis UI Customization & Lap Compare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RaceStudio-style min/max, unit conversion, UI scale, configurable GPS speed gradient, lap selection/compare, and draggable delta cursors in QuickScope's analysis view.

**Architecture:** A localStorage-backed `PreferencesProvider` feeds display prefs to every view. Pure helpers (`units.ts`, `gradients.ts`, `lap-compare.ts`, min/max + cursor hit-test in chart libs) carry the logic and the tests; components only wire them in. The Canvas chart keeps its ref-driven, no-re-render-per-pointermove draw loop.

**Tech Stack:** React 18 + TypeScript, Vite, Tailwind, custom Canvas2D chart, Leaflet, Vitest + Testing Library (jsdom), FastAPI backend (pytest).

**Spec:** `docs/superpowers/specs/2026-11-03-analysis-ui-customization-design.md`

## Global Constraints

- Branch: `appletest`. Commit after every task, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Preferences in localStorage key `quickscope-preferences`; every read/write in try/catch; corrupt/missing → defaults.
- Defaults: `uiScale 1.0` (range 0.8–1.5), `unitSystem 'logger'`, `unitOverrides {}`, `gpsGradient { preset 'turbo', customLow '#2563eb', customHigh '#dc2626', rangeMode 'auto', fixedMin 0, fixedMax 150 }`.
- Defaults must reproduce today's behaviour except the deliberate min/max and GPS-gradient visual changes.
- No React state updates per pointermove in the chart; refs + `requestDraw()` only.
- Raw samples in `session.samples` / `derivedSamplesMap` are never mutated; derived formulas evaluate on raw units.
- lucide-react icons only; must look right in light and dark themes.
- Timestamps: ms in samples/store, seconds in chart x-range.
- Verification after every task: `npm run check` and `npm run test:client` both pass (run from repo root).

## Review Focus

1. **Channel with an unknown or empty unit string** under Imperial → shown unchanged, no NaN, no "undefined" label. Test in Task 5 (`getConverter('', 'imperial')` identity; `'rpm'` identity).
2. **Visible window with zero samples** (zoomed into a gap, or channel shorter than session) → no min/max drawn, no crash. Test in Task 3 (`visibleMinMax` returns `null`).
3. **Lap selection with a single lap marker pair / laps of very different length** in compare mode → x-axis spans the longest lap, shorter laps simply end. Test in Task 7 (`buildLapWindows` + `lapRelativeRange`).
4. **GPS speed all-equal (car parked) or speed channel missing** → gradient doesn't divide by zero; single color + legend shows the one value or "no speed". Test in Task 6 (`speedToT` with min===max returns 0).
5. **Delta cursors both within hit tolerance of the mouse** → nearer one is dragged; drag never re-places a cursor on mouseup. Test in Task 2 (`hitTestCursor` nearest-wins; integration test for no re-place).

---

## File map

| File | Responsibility |
|---|---|
| Create `client/src/lib/usePreferences.tsx` | Preferences type, defaults, load/save, `PreferencesProvider`, `usePreferences()` |
| Create `client/src/lib/units.ts` | Unit normalisation, converters, display-unit resolution |
| Create `client/src/lib/useDisplaySamples.ts` | Cached converted sample arrays + display defs for a channel set |
| Create `client/src/lib/gradients.ts` | Gradient presets, `sampleGradient`, `speedToT` |
| Create `client/src/lib/lap-compare.ts` | Lap windows, lap-relative ranges, compare palette |
| Create `client/src/components/settings/DisplaySettings.tsx` | Display section of Settings dialog |
| Modify `client/src/lib/chart-utils.ts` | `DrawContext.fontScale`, `DrawContext.compare`, `visibleMinMax`, `scaledFont` |
| Modify `client/src/lib/chart-draw.ts` | New min/max markers, readout, font scaling, compare traces |
| Modify `client/src/lib/chart-cursors.ts` | `hitTestCursor`, font scaling, per-lap readout |
| Modify `client/src/components/TelemetryChart.tsx` | Cursor drag, display samples, scale, compare mode |
| Modify `client/src/lib/chart-export.ts` | Same min/max style |
| Modify `client/src/lib/useXRKStore.ts` | `selectedLaps` + actions |
| Modify `client/src/components/analysis/LapAnalysisTab.tsx` | Lap checkboxes, select best/clear |
| Modify `client/src/components/GPSMapView.tsx` | Gradient prefs, legend, lap highlight |
| Modify `client/src/components/SettingsDialog.tsx`, `ChannelSidebar.tsx`, analysis tabs, `TableView.tsx`, `ExportDialog.tsx`, `App.tsx`, `AnalysisPanel.tsx`, `client/src/index.css` | Wiring |
| Modify `backend/routes/analysis.py` | `/api/gps` returns `speedUnits` |

---

### Task 1: Preferences store and Settings "Display" section

**Files:**
- Create: `client/src/lib/usePreferences.tsx`, `client/src/components/settings/DisplaySettings.tsx`
- Modify: `client/src/App.tsx` (wrap root in `PreferencesProvider`), `client/src/components/SettingsDialog.tsx` (render `<DisplaySettings />` above the AiM section)
- Test: `client/src/lib/usePreferences.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type UnitSystem = 'logger' | 'metric' | 'imperial';
  export type GradientPreset = 'turbo' | 'classic' | 'viridis' | 'custom';
  export interface GpsGradientPrefs { preset: GradientPreset; customLow: string; customHigh: string; rangeMode: 'auto' | 'fixed'; fixedMin: number; fixedMax: number; }
  export interface Preferences { uiScale: number; unitSystem: UnitSystem; unitOverrides: Record<string, string>; gpsGradient: GpsGradientPrefs; }
  export const DEFAULT_PREFERENCES: Preferences;
  export function loadPreferences(): Preferences;         // merges stored over defaults, clamps uiScale
  export function PreferencesProvider(props: { children: React.ReactNode }): JSX.Element;
  export function usePreferences(): { prefs: Preferences; update: (patch: Partial<Preferences>) => void; reset: () => void };
  ```
  `DisplaySettings` renders an empty `<section data-testid="display-settings">` with heading "Display"; Tasks 4–6 add controls into it.

- [ ] **Step 1: Write failing tests** in `usePreferences.test.tsx` (`// @vitest-environment jsdom`):
  - `loadPreferences()` with empty storage `toEqual(DEFAULT_PREFERENCES)`.
  - stored `'{"uiScale":3,"unitSystem":"imperial"}'` → `uiScale === 1.5`, `unitSystem === 'imperial'`, `gpsGradient` equals default.
  - stored `'not json'` → defaults.
  - `localStorage.getItem` throwing → defaults (stub with `vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error()})`).
  - rendering a consumer inside `PreferencesProvider`, calling `update({uiScale:1.2})` → `localStorage['quickscope-preferences']` parses to `uiScale 1.2`.
- [ ] **Step 2:** `npx vitest run client/src/lib/usePreferences.test.tsx` → FAIL (module missing).
- [ ] **Step 3:** Implement `usePreferences.tsx` (context + `useState(loadPreferences)` + `useEffect` save) and `DisplaySettings.tsx`; wire into `App.tsx` and `SettingsDialog.tsx`.
- [ ] **Step 4:** Tests pass; `npm run check` and `npm run test:client` pass.
- [ ] **Step 5:** Commit `feat(prefs): localStorage display preferences + Settings Display section`.

---

### Task 2: Draggable delta cursors

**Files:**
- Modify: `client/src/lib/chart-cursors.ts`, `client/src/components/TelemetryChart.tsx:456-575` (mouse handlers) and touch handlers
- Test: `client/src/lib/chart-cursors.test.ts` (extend), `client/src/components/TelemetryChart.test.tsx` (extend)

**Interfaces:**
- Produces: `export function hitTestCursor(mouseX: number, cursorAX: number | null, cursorBX: number | null, tolerancePx: number): 'A' | 'B' | null` in `chart-cursors.ts` (x values in canvas px; nearer wins; ties → 'B').

- [ ] **Step 1: Failing unit tests** (`chart-cursors.test.ts`):
  - `hitTestCursor(100, 103, null, 6) === 'A'`; `hitTestCursor(100, 120, null, 6) === null`.
  - `hitTestCursor(100, 104, 98, 6) === 'B'` (nearer); `hitTestCursor(100, null, 95, 6) === 'B'`.
- [ ] **Step 2: Failing integration test** (`TelemetryChart.test.tsx`, use `fakeLayout({width:1000,height:300})`): enable delta via `delta-toggle`, click at x=300 (A), click at x=600 (B); then mousedown at x=600, mousemove to x=700, mouseup at x=700. Assert via the delta panel text (or exposed `data-cursor-b` attribute on the canvas container, added in Step 3) that B moved to the time at x=700 and the view range did **not** pan (`onViewRangeChange` not called). Then mousedown/up at x=700 with no move → B unchanged (a press on a cursor is not a re-place).
- [ ] **Step 3:** Run both → FAIL.
- [ ] **Step 4:** Implement. Add `dragCursorRef = useRef<'A'|'B'|null>(null)`. In `handleMouseDown`, when delta mode, convert cursors to px and call `hitTestCursor(mouseX, ax, bx, 6 * fontScale)` (use `1` until Task 4 adds scale); if hit, set `dragCursorRef` and skip pan setup. In `handleMouseMove`: if dragging a cursor, set `cursorXRef`/`cursor2XRef` to clamped time, throttle-emit `onCursorTimeChange` for A (same 60 ms pattern), `requestDraw()`; when not dragging and in delta mode, set cursor style `ew-resize` when hit-test hits else `crosshair`. In `handleMouseUp`: if `dragCursorRef` set, clear it and return before click detection. Mirror in single-touch start/move/end. Expose `data-cursor-a`/`data-cursor-b` (seconds, 3 dp) on the canvas wrapper, updated in `draw()` via the DOM node (no React state).
- [ ] **Step 5:** Tests pass; check + full client tests pass.
- [ ] **Step 6:** Commit `feat(chart): drag delta cursors A/B`.

---

### Task 3: RaceStudio-style min/max

**Files:**
- Modify: `client/src/lib/chart-utils.ts`, `client/src/lib/chart-draw.ts:209-293` and the strip label drawing, `drawOverlayLegend`, `client/src/lib/chart-export.ts`
- Test: `client/src/lib/chart-utils.test.ts` (extend)

**Interfaces:**
- Produces in `chart-utils.ts`:
  - `export function visibleMinMax(samples: ChannelSample[], startMs: number, endMs: number): { min: ChannelSample; max: ChannelSample } | null` — binary-search the start index, scan to end; `null` when no sample in range.
  - `export function placeLabelBox(pointX: number, pointY: number, boxW: number, boxH: number, bounds: { left: number; right: number; top: number; bottom: number }): { x: number; y: number }` — right of point by 6px, flips left if `x+boxW > right`, y clamped into bounds.
  - `export function contrastText(hex: string): '#000' | '#fff'` (relative luminance > 0.5 → black).

- [ ] **Step 1: Failing tests:**
  - `visibleMinMax(ramp(1001), 2000, 3000)` → `min.timestamp === 2000`, `max.timestamp === 3000` (use `ramp` from `client/src/test/dom-setup`, or inline a 10 ms ramp).
  - `visibleMinMax(samples, 20000, 30000)` past end → `null`; empty array → `null`.
  - `placeLabelBox(990, 50, 60, 16, {left:0,right:1000,top:0,bottom:100}).x === 990 - 6 - 60`; `placeLabelBox(10, 5, 60, 16, …)` → `x === 16`, `y >= 0`; y near bottom clamps to `bottom - 16`.
  - `contrastText('#facc15') === '#000'`; `contrastText('#4361ee') === '#fff'`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement helpers. Rewrite `drawMinMaxMarkers(dc, strip, valToY)` to use `visibleMinMax(allSamples, xRange[0]*1000, xRange[1]*1000)`; draw dashed (`[4,4]`, 1px, channel color alpha 0.4) full-width lines at min/max y; filled 3px dot at the point; boxed label (`roundRect` r=3, fill channel color, text `contrastText`, bold 11px mono, content `▲ ${formatValue(v)} ${units}` / `▼ …`) placed with `placeLabelBox`; if min box overlaps max box, shift min box down by box height + 2. Remove the off-screen-arrow branch. `globalMinMaxCache` stays (used by export header). Strip label: append ` min ${formatValue} · max ${formatValue}` in `dc.colors` muted text after the channel label; overlay legend entries get the same.
- [ ] **Step 4:** In `chart-export.ts`, call the same marker routine (export it from `chart-draw.ts` as `drawMinMaxMarkers`) instead of its own.
- [ ] **Step 5:** Tests pass; check + client tests pass. Manually: `npm run dev`, load a session, zoom — markers follow the window, labels stay inside strips, readable in light and dark.
- [ ] **Step 6:** Commit `feat(chart): RaceStudio-style visible-window min/max markers`.

---

### Task 4: UI scale

**Files:**
- Modify: `client/src/index.css:190` (move font-size rule to `html`), `client/src/lib/usePreferences.tsx` (effect sets `--ui-scale` on `document.documentElement`), `client/src/lib/chart-utils.ts`, `chart-draw.ts`, `chart-cursors.ts`, `TelemetryChart.tsx`, `DisplaySettings.tsx`
- Test: `client/src/lib/chart-utils.test.ts`, `client/src/lib/usePreferences.test.tsx`

**Interfaces:**
- Consumes: `usePreferences()` (Task 1).
- Produces: `DrawContext.fontScale: number`; `export function scaledFont(px: number, scale: number, weight?: 'bold'): string` → e.g. `scaledFont(10, 1.5) === '15px JetBrains Mono, monospace'`, `scaledFont(9, 1.2, 'bold') === 'bold 11px JetBrains Mono, monospace'` (Math.round).

- [ ] **Step 1: Failing tests:** the two `scaledFont` asserts above; provider test: `update({uiScale:1.25})` → `document.documentElement.style.getPropertyValue('--ui-scale') === '1.25'`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. CSS: `html { font-size: calc(clamp(0.875rem, 0.8rem + 0.35vw, 1rem) * var(--ui-scale, 1)); }` and remove the body font-size. Replace every literal `` `Npx ${MONO_FONT}` `` in `chart-draw.ts` and `chart-cursors.ts` with `scaledFont(N, dc.fontScale)`; scale cursor pill height (16) and the delta hit tolerance from Task 2. In `TelemetryChart.tsx` read `prefs.uiScale`, multiply `LEFT_MARGIN`, `AXIS_WIDTH`, `BOTTOM_AXIS_HEIGHT` by it when computing margins, add to `dc`, include in `draw` deps. `DisplaySettings`: range input 80–150 step 5 (`aria-label="UI scale"`), `%` readout, "Reset" button.
- [ ] **Step 4:** Tests pass; check + client tests. Manually: slider at 150% → sidebar text and chart labels both grow, nothing clipped on y-axes.
- [ ] **Step 5:** Commit `feat(ui): UI scale preference for app and chart text`.

---

### Task 5: Unit conversion

**Files:**
- Create: `client/src/lib/units.ts`, `client/src/lib/useDisplaySamples.ts`
- Modify: `TelemetryChart.tsx` (channelDataMap build at ~line 85), `analysis-helpers.ts`, `StatsTab.tsx`, `HistogramTab.tsx`, `XYPlotTab.tsx`, `LapAnalysisTab.tsx`, `TableView.tsx`, `ExportDialog.tsx`, `ChannelSidebar.tsx`, `DisplaySettings.tsx`
- Test: `client/src/lib/units.test.ts`, `client/src/lib/useDisplaySamples.test.tsx`

**Interfaces:**
- Consumes: `Preferences.unitSystem`, `Preferences.unitOverrides`.
- Produces (`units.ts`):
  ```ts
  export interface Converter { unit: string; fn: (v: number) => number; identity: boolean }
  export function normalizeUnit(u: string): string | null;            // canonical key or null if unknown
  export function convertibleUnits(rawUnit: string): string[];         // display labels of same dimension, [] if unknown
  export function getConverter(rawUnit: string, target: string): Converter; // target = unit label; identity if incompatible/unknown
  export function resolveDisplayUnit(shortName: string, rawUnit: string, prefs: Pick<Preferences,'unitSystem'|'unitOverrides'>): string;
  ```
  Canonical display labels: `km/h, mph, m/s, °C, °F, bar, kPa, psi, m, km, ft, mi, Nm, lb·ft, L, gal, kg, lb`. Aliases (case/space-insensitive): `kph,kmh,km/hr→km/h`; `C,degC,deg C,°c→°C`; `F,degF→°F`; `lbft,lb-ft,ft-lb,ft·lb→lb·ft`; `N·m,N-m→Nm`; `l→L`.
  System maps: imperial `km/h→mph, m/s→mph, °C→°F, bar→psi, kPa→psi, m→ft, km→mi, Nm→lb·ft, L→gal, kg→lb`; metric the inverse (`mph→km/h, °F→°C, psi→bar, ft→m, mi→km, lb·ft→Nm, gal→L, lb→kg`); logger → raw.
  (`useDisplaySamples.ts`):
  ```ts
  export function useDisplaySamples(): (channelId: number, shortName: string, rawUnit: string, raw: ChannelSample[]) => { unit: string; samples: ChannelSample[] };
  ```
  Returns a stable function backed by a `useRef(Map)` cache keyed `${channelId}|${targetUnit}` holding `{ raw, samples }`; recomputes when `raw` identity changes; returns `raw` itself for identity conversions. Cache cleared when prefs change.
  `analysis-helpers.ts` gains `resolveDisplay(id, session, derivedChannels, derivedSamplesMap, display) → { chan, unit, samples }` used by all tabs.

- [ ] **Step 1: Failing tests** (`units.test.ts`):
  - `getConverter('km/h','mph').fn(100)` ≈ `62.137` (toBeCloseTo 3); `getConverter('kph','mph').unit === 'mph'`.
  - `getConverter('°C','°F').fn(100) === 212`; `getConverter('degC','°F').fn(0) === 32`; `getConverter('°F','°C').fn(212)` ≈ 100.
  - `getConverter('bar','psi').fn(1)` ≈ `14.5038`; `getConverter('kPa','psi').fn(100)` ≈ `14.5038`.
  - `getConverter('rpm','mph').identity === true`; `getConverter('','mph').identity === true`; `getConverter('km/h','°F').identity === true`.
  - `resolveDisplayUnit('Speed','km/h',{unitSystem:'imperial',unitOverrides:{}}) === 'mph'`; with `unitOverrides:{Speed:'m/s'}` → `'m/s'`; `unitSystem:'logger'` → `'km/h'`; `('RPM','rpm',imperial) === 'rpm'`.
  - `convertibleUnits('kph')` contains `'km/h','mph','m/s'`; `convertibleUnits('rpm')` is `[]`.
- [ ] **Step 2: Failing hook test** (`useDisplaySamples.test.tsx`): inside provider with `unitSystem:'imperial'`, `get(1,'Speed','km/h',raw)` returns `unit 'mph'`, first sample value ≈ raw×0.621371, calling twice returns the **same array** (`toBe`); with `logger` returns `raw` itself (`toBe(raw)`).
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement `units.ts` and `useDisplaySamples.ts`.
- [ ] **Step 5:** Wire: in `TelemetryChart.tsx` channelDataMap memo, pass each channel through `display(...)`; set `def.units` and `allSamples` from the result; add `prefs` to the memo deps so `globalMinMaxCache` rebuilds. Switch Stats/Histogram/XY/Lap tabs and `TableView` to `resolveDisplay`. `ExportDialog`: add checkbox "Export in display units" (default on) that applies the same converters to values and header units. `ChannelSidebar`: for active channels where `convertibleUnits(raw).length > 0`, show a compact `<select>` (Default + options) bound to `unitOverrides[shortName]` (Default deletes the key). `DisplaySettings`: segmented control Logger / Metric / Imperial with `role="radiogroup"`.
- [ ] **Step 6:** Tests pass; check + client tests (update any snapshot/text expectations that include units only if they now legitimately differ — under default `logger` none should).
- [ ] **Step 7:** Commit `feat(units): logger/metric/imperial unit system with per-channel override`.

---

### Task 6: GPS speed gradient, settings, legend

**Files:**
- Create: `client/src/lib/gradients.ts`
- Modify: `client/src/components/GPSMapView.tsx:96-121`, `client/src/lib/api.ts` (`GPSData.speedUnits?: string`), `backend/routes/analysis.py:191-225`, `DisplaySettings.tsx`
- Test: `client/src/lib/gradients.test.ts`, `backend/tests/` (extend the existing `/api/gps` route test file; locate with `grep -rl "api/gps" backend/tests tests 2>/dev/null`)

**Interfaces:**
- Consumes: `GpsGradientPrefs`, `getConverter`/`resolveDisplayUnit` (Task 5).
- Produces (`gradients.ts`):
  ```ts
  export const GRADIENT_PRESETS: Record<Exclude<GradientPreset,'custom'>, string[]>; // hex stops
  // turbo:   ['#30123b','#4662d7','#36aaf9','#1ae4b6','#72fe5e','#c7ef34','#fbb938','#f56918','#c92903','#7a0403']
  // classic: ['#32c832','#ffc832','#ff0032']
  // viridis: ['#440154','#3b528b','#21918c','#5ec962','#fde725']
  export function gradientStops(p: GpsGradientPrefs): string[];      // custom → [customLow, customHigh]
  export function sampleGradient(stops: string[], t: number): string; // 'rgb(r, g, b)', t clamped 0–1, linear between stops
  export function speedToT(v: number, min: number, max: number): number; // (v-min)/(max-min) clamped; 0 when max<=min
  ```
  Backend: `/api/gps` JSON gains `"speedUnits": <units of speed_name channel or "">`.

- [ ] **Step 1: Failing tests:**
  - `sampleGradient(['#000000','#ffffff'], 0.5) === 'rgb(128, 128, 128)'` (Math.round); `t=-1` → `'rgb(0, 0, 0)'`; `t=2` → `'rgb(255, 255, 255)'`; three-stop `['#ff0000','#00ff00','#0000ff']` at 0.5 → `'rgb(0, 255, 0)'`.
  - `speedToT(50, 0, 100) === 0.5`; `speedToT(10, 10, 10) === 0`; `speedToT(200, 0, 100) === 1`.
  - `gradientStops({...DEFAULT_PREFERENCES.gpsGradient, preset:'custom', customLow:'#111111', customHigh:'#eeeeee'})` → `['#111111','#eeeeee']`.
  - Backend pytest: GPS response contains `speedUnits` key equal to the speed channel's units for the fixture session.
- [ ] **Step 2:** Run (`npx vitest run client/src/lib/gradients.test.ts`, `npm test`) → FAIL.
- [ ] **Step 3:** Implement `gradients.ts` and the backend field.
- [ ] **Step 4:** `GPSMapView`: split map build from trail drawing. Keep the Leaflet map in `buildMap`; draw the trail into an `L.layerGroup` stored in a ref, rebuilt by a separate effect depending on `[gpsData, prefs.gpsGradient, prefs.unitSystem, prefs.unitOverrides]`. Convert speeds with `getConverter(speedUnits, resolveDisplayUnit('GPS Speed', speedUnits, prefs))`. Range: auto → min/max of converted speeds (loop, not spread); fixed → `fixedMin/fixedMax`. Segment stride `Math.max(3, Math.ceil(coords.length / 3000))`, each segment colored by its average. Legend: absolutely-positioned card bottom-left (`z-[400]` above tiles) with a CSS `linear-gradient` of the stops, and `${min.toFixed(0)} – ${max.toFixed(0)} ${unit}`; when `speed` is null show "No speed data" and draw the trail in `#4361ee`.
- [ ] **Step 5:** `DisplaySettings`: "GPS trail" group — preset swatch buttons (each a gradient bar, `aria-pressed`), two `<input type="color">` shown when custom, Auto/Fixed toggle with two number inputs (labelled with current display speed unit, default `km/h` when unknown).
- [ ] **Step 6:** Tests pass; check + client tests + `npm test`. Manually: switch presets with the GPS tab open — trail recolors without the map resetting zoom.
- [ ] **Step 7:** Commit `feat(gps): configurable speed gradient with legend`.

---

### Task 7: Lap selection state, Laps tab UI, single-lap zoom

**Files:**
- Create: `client/src/lib/lap-compare.ts`
- Modify: `client/src/lib/useXRKStore.ts` (state, `SESSION_SCOPED_RESET`, actions), `LapAnalysisTab.tsx`, `AnalysisPanel.tsx`, `App.tsx`
- Test: `client/src/lib/lap-compare.test.ts`, `client/src/lib/useXRKStore.test.ts` (extend), `client/src/components/analysis/analysis-tabs.test.tsx` (extend)

**Interfaces:**
- Produces:
  ```ts
  // lap-compare.ts
  export interface LapWindow { index: number; lapNumber: number; startMs: number; endMs: number; durationMs: number }
  export function buildLapWindows(markers: LapMarker[]): LapWindow[];       // consecutive marker pairs; [] if <2
  export function lapRelativeRange(windows: LapWindow[], selected: number[]): [number, number]; // seconds [0, longest/1000]
  export const LAP_COMPARE_PALETTE: string[]; // ['#4361ee','#f77f00','#10b981','#e11d48','#a855f7','#eab308']
  export function lapColor(order: number): string; // palette[order % len]
  // useXRKStore
  selectedLaps: number[];            // LapWindow.index values, in selection order
  toggleLapSelected(index: number): void;
  setSelectedLaps(indices: number[]): void;
  ```
  App behaviour: when `selectedLaps.length === 1`, `setViewRange({startMs, endMs})` of that lap (effect in `App.tsx` keyed on the selection, not on viewRange, so user can still pan afterwards). `LapAnalysisTab` must compute best lap via the existing logic and expose its index for "Select best".

- [ ] **Step 1: Failing tests:**
  - `buildLapWindows([{timestamp:0,lapNumber:1},{timestamp:60000,lapNumber:2},{timestamp:125000,lapNumber:3}])` → 2 windows, second `{index:1, lapNumber:2, startMs:60000, endMs:125000, durationMs:65000}`; one marker → `[]`.
  - `lapRelativeRange(windows,[0,1])` → `[0, 65]`; `lapRelativeRange(windows,[0])` → `[0, 60]`.
  - store: `toggleLapSelected(1)`, `toggleLapSelected(0)` → `[1,0]`; toggling 1 again → `[0]`; loading a new session resets to `[]`.
  - Laps tab: renders a checkbox per lap (`getAllByRole('checkbox')` length = laps); clicking "Select best" calls `setSelectedLaps([bestIndex])`; "Clear" calls `setSelectedLaps([])`; header shows "2 selected — comparing" when two are selected.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `lap-compare.ts`, store additions, Laps tab (checkbox at card left, whole card clickable, swatch `lapColor(order)` beside selected laps), props through `AnalysisPanel`, single-lap zoom effect in `App.tsx`.
- [ ] **Step 4:** Tests pass; check + client tests.
- [ ] **Step 5:** Commit `feat(laps): select laps from Laps tab; single lap zooms chart`.

---

### Task 8: Lap compare mode in the chart

**Files:**
- Modify: `client/src/lib/chart-utils.ts` (`DrawContext.compare`), `chart-draw.ts`, `chart-cursors.ts`, `TelemetryChart.tsx` (new props, x-range, toolbar chip), `App.tsx`
- Test: `client/src/lib/lap-compare.test.ts` (extend), `client/src/components/TelemetryChart.test.tsx` (extend)

**Interfaces:**
- Consumes: `LapWindow`, `buildLapWindows`, `lapRelativeRange`, `lapColor` (Task 7); `selectedLaps`, `setSelectedLaps` (Task 7); `visibleMinMax` (Task 3).
- Produces:
  ```ts
  // chart-utils.ts
  export interface CompareContext { laps: LapWindow[] }   // in selection order; null when <2 selected
  DrawContext.compare: CompareContext | null;
  // lap-compare.ts
  export function toSessionMs(lapRelSec: number, lap: LapWindow): number; // lap.startMs + lapRelSec*1000
  // TelemetryChartProps additions
  selectedLaps?: number[];
  onClearLapSelection?: () => void;
  ```

- [ ] **Step 1: Failing tests:**
  - `toSessionMs(5, {startMs:60000,…}) === 65000`.
  - Chart integration: render with a session whose `lapMarkers` give two laps and `selectedLaps={[0,1]}` → toolbar shows chip text containing `Lap 1` and `Lap 2` (`getByTestId('lap-compare-chip')`); clicking its ✕ calls `onClearLapSelection`; wheel-zoom/pan never emits a range end beyond the longest lap length (assert last `onViewRangeChange` call `endMs <= longest`). In compare mode `onViewRangeChange` ranges are lap-relative ms.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. In `TelemetryChart.tsx`: derive `compare` from `selectedLaps` (≥2); while active use `sessionDuration = lapRelativeRange(...)[1]` for clamping, keep a separate `compareXRangeRef` so leaving compare restores the previous normal range; x-axis labels formatted as lap time (`formatLapTime`). `drawStrips`: when `dc.compare`, for each lap `i` draw the channel trace using samples in `[lap.startMs, lap.endMs]`, x = `(ts - lap.startMs)/1000` mapped via `timeToX`; separate mode color = `lapColor(i)` 1.5px (first lap 2px); overlay mode color = channel color with `setLineDash(i===0?[]:[6,3])` and alpha `1 - 0.2*i` (min 0.4). Y-range computed over all selected laps' samples. Min/max markers for the first selected lap only. Top legend row: `■ Lap N m:ss.s` per lap (best lap suffixed "(best)"). Cursor readout in `chart-cursors.ts`: one value per lap at `toSessionMs(t, lap)`, colored per lap; delta panel uses lap-relative times. Chip in toolbar: `Compare: Lap 3, Lap 7` + ✕ button (`aria-label="Exit lap compare"`). Pass `selectedLaps`/`onClearLapSelection` from `App.tsx`.
- [ ] **Step 4:** Tests pass; check + client tests. Manually: select two laps of different length, verify overlay lines up at 0 and shorter lap ends early; toggle overlay chart mode; delta drag works in compare.
- [ ] **Step 5:** Commit `feat(chart): time-aligned lap compare overlay`.

---

### Task 9: GPS lap highlight and per-lap cursor markers

**Files:**
- Modify: `client/src/components/GPSMapView.tsx`, `AnalysisPanel.tsx` (pass `session.lapMarkers`, `selectedLaps`)
- Test: `client/src/lib/lap-compare.test.ts` (extend)

**Interfaces:**
- Consumes: `buildLapWindows`, `lapColor`, `toSessionMs` (Tasks 7–8).
- Produces: `export function segmentInLaps(tMs: number, laps: LapWindow[]): boolean` in `lap-compare.ts`. `GPSMapView` props add `lapMarkers?: LapMarker[]; selectedLaps?: number[]`.
  Note: GPS `timestamps` are session-relative ms (backend subtracts `min(timestamps)`); chart `cursorTime` is seconds — the existing marker code already aligns them; reuse that mapping.

- [ ] **Step 1: Failing tests:** `segmentInLaps(70000, [lap(60000,125000)]) === true`; `segmentInLaps(10, [lap(60000,125000)]) === false`; empty laps → `true` (no selection = everything highlighted).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: in the trail effect (Task 6), set segment `opacity` 0.9 when `segmentInLaps(segmentMidTime, selectedWindows)` else 0.2. Compare mode (≥2 selected): replace single cursor marker with one `L.circleMarker` per selected lap at `toSessionMs(cursorTime, lap)`, `fillColor: lapColor(i)`. Add `lapMarkers`/`selectedLaps` to the trail effect deps.
- [ ] **Step 4:** Tests pass; check + client tests. Manually: select a lap → only its loop is bright on the map.
- [ ] **Step 5:** Commit `feat(gps): highlight selected laps and per-lap cursor markers`.

---

## Final verification

- [ ] `npm run check`, `npm run test:client`, `npm test` all green.
- [ ] Manual pass with `npm run dev` + backend on a real `.xrk`: defaults look like today except min/max + GPS gradient; Imperial converts chart/stats/table/export; UI scale 80% and 150%; two-lap compare; delta drag in normal and compare modes; light and dark themes.
