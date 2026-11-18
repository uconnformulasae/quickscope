# Analysis UI customization & lap compare — design

Date: 2026-11-03 · Branch: `appletest`

## Why

Team feedback after using QuickScope next to AiM RaceStudio:

- Min/max points on the chart are hard to read (tiny 8px text) compared to RaceStudio.
- Engineers want to read data in their preferred units (mph vs km/h, °F vs °C, psi vs bar).
- Text is too small on some screens/resolutions — no way to adjust.
- The GPS speed trail's green→red gradient is hard to read and not adjustable.
- No way to focus on specific laps or compare laps against each other.
- Delta cursors can only be re-placed by clicking; users want to drag them.

Success: an engineer can open a session, switch to imperial, bump the text size, tick two laps
in the Laps tab, see them overlaid, and drag delta bars to measure a corner — without leaving the
analysis view.

## Goals

1. RaceStudio-style min/max: boxed labels, dashed reference lines, visible-window extremes, min/max in the strip readout.
2. Global unit system (Logger / Metric / Imperial) with per-channel override.
3. One UI scale slider affecting app text and chart canvas text.
4. Configurable GPS speed gradient + legend; better default gradient.
5. Lap selection from the Laps tab: 1 lap = zoom to it; 2+ laps = time-aligned overlay compare.
6. Draggable delta A/B cursors.

## Non-goals

- Distance-aligned lap overlay (time-aligned only for now; distance can come later).
- Cross-session lap compare (only laps within the loaded session).
- Changing units of raw data, stored files, or backend responses.
- Per-element font sizes.
- Syncing these preferences to the backend / Data-Development.

## Anti-goals

- Anything that slows chart pan/zoom (draw loop must stay per-frame cheap; no React re-render per pointermove).
- Breaking existing derived-channel formulas (they keep operating on raw units).
- Changing behaviour when no new option is used (defaults must reproduce today's experience except the deliberate min/max and GPS-gradient visual upgrades).

## Constraints / existing architecture

- Custom Canvas2D chart: `components/TelemetryChart.tsx` (interaction, refs) + `lib/chart-draw.ts` (strips, min/max, axes) + `lib/chart-cursors.ts` (cursors, delta panel) + `lib/chart-utils.ts` (`DrawContext`, constants). Off-screen PNG renderer in `lib/chart-export.ts`.
- Global state in `lib/useXRKStore.ts` (single `useState` store). Per-viewer UI prefs already live in localStorage hooks (`useTheme.ts`, `useSidebarWidths.ts`) — follow that pattern.
- `SettingsDialog.tsx` currently only holds AiM WiFi settings persisted via backend `/api/settings`.
- Timestamps are ms in store/samples, seconds in the chart's x-range.
- Style: lucide-react icons only, Tailwind, JetBrains Mono for data, light + dark themes.

## Design

### 0. Preferences store (shared foundation)

New `client/src/lib/usePreferences.ts`: localStorage key `quickscope-preferences`, JSON, all reads/writes in try/catch, sane defaults when missing/corrupt.

```ts
interface Preferences {
  uiScale: number;                     // 0.8–1.5, default 1.0
  unitSystem: 'logger' | 'metric' | 'imperial'; // default 'logger' = as recorded (today's behaviour)
  unitOverrides: Record<string, string>; // key = channel shortName, value = target unit string
  gpsGradient: {
    preset: 'turbo' | 'classic' | 'viridis' | 'custom'; // default 'turbo'
    customLow: string; customHigh: string;               // hex, used when preset='custom'
    rangeMode: 'auto' | 'fixed';                         // default 'auto' (session min–max)
    fixedMin: number; fixedMax: number;                  // in the *display* speed unit
  };
}
```

Exposed via a React context provider (wrapping `App`) so the chart, analysis tabs, GPS map and settings all read the same object. Overrides keyed by `shortName` so they survive reloading the same car's sessions.

Settings dialog gets a new **Display** section above the AiM section: UI scale slider (with % readout and Reset), Units (Logger / Metric / Imperial segmented control), GPS trail gradient (preset swatches, custom low/high color inputs, Auto/Fixed range with min/max inputs). Display prefs apply immediately (no Save button needed); the existing Save button stays for AiM settings only.

### 1. Min/max markers (RaceStudio style)

In `lib/chart-draw.ts` `drawMinMaxMarkers`:

- **Source of extremes:** visible window, not whole session. Compute min/max over samples whose timestamp is inside `xRange` (reuse the start/end index search already done for trace drawing; avoid a second full scan). Whole-session `globalMinMaxCache` stays for the PNG header and off-screen arrows are dropped (the extreme is always on screen now).
- **Reference lines:** dashed (`setLineDash([4,4])`), 1px, channel color at ~40% alpha, full plot width at the min and max y.
- **Label:** rounded-rect box filled with the channel color, text in contrasting color (white/black by luminance), `▲ 123.4 unit` / `▼ 12.3 unit`, font `11px * uiScale` bold mono. Placed right of the point; flips left when it would overflow the right edge; nudged vertically to stay inside the strip; max and min labels must not overlap each other (if they collide, offset the min label down).
- Small filled triangle/dot at the exact point retained.
- **Overlay mode:** same, per channel, in each channel's color.
- **Strip readout:** the strip label / cursor value area appends `min X · max Y` (visible window) in muted text. In overlay mode the overlay legend gets the same per channel.
- **PNG export (`chart-export.ts`):** use the same marker style (my call).

### 2. Unit conversion

New `client/src/lib/units.ts`:

- Table of known units with a canonical normalised key (case/spacing-insensitive aliases: `km/h`, `kph`, `kmh`; `°C`, `C`, `degC`; `bar`, `kPa`, `psi`; `m`, `km`, `ft`, `mi`; `Nm`, `lb·ft`/`lbft`; `m/s`; `g` unchanged, etc.).
- `metricToImperial` / `imperialToMetric` target map: km/h↔mph, m/s→mph (imperial) / stays m/s (metric), °C↔°F, bar↔psi, kPa↔psi, m↔ft, km↔mi, Nm↔lb·ft, L↔gal, kg↔lb.
- `getConverter(rawUnit, targetUnit) → { fn: (v)=>number, unit: string }`; identity when unknown/unconvertible. Affine conversions (temperature) handled correctly.
- `resolveDisplayUnit(shortName, rawUnit, prefs)`: per-channel override wins, else system mapping, else raw.

Application point: a single display layer, not the sample store.
- Chart: when building the channel data map in `TelemetryChart.tsx`, wrap samples with converted values **lazily and cached per (channelId, targetUnit)** (memoised arrays, recomputed only when prefs or data change) and set `def.units` to the display unit. Overlay unit groups therefore regroup by display unit.
- Stats, Histogram, XY, Lap tab, TableView, CSV export: go through a shared helper (`resolveDisplaySamples` alongside `resolveSamples` in `analysis-helpers.ts`) so every view converts the same way.
- Derived channels: formulas evaluate on raw values (unchanged); their *output* unit string is then converted for display like any other channel if recognised.
- Per-channel override UI: in `ChannelSidebar.tsx`, each active channel gets a small unit dropdown (only shown when the unit is convertible), listing compatible units + "Default".

### 3. UI scale

- App text: set `document.documentElement.style.fontSize` to `calc(<current clamp> * uiScale)` — implemented by moving the existing `clamp(...)` on `body` to `html` as `font-size: calc(clamp(0.875rem, 0.8rem + 0.35vw, 1rem) * var(--ui-scale, 1))`, so Tailwind's rem sizes scale. Hook sets `--ui-scale`.
- Chart canvas: add `fontScale` to `DrawContext`; replace hard-coded `8px/9px/10px` font sizes in `chart-draw.ts`, `chart-cursors.ts` with `${Math.round(n * fontScale)}px`. Axis margins (`LEFT_MARGIN`, `AXIS_WIDTH`, `BOTTOM_AXIS_HEIGHT`) scale too so labels don't clip. Pill heights scale.
- Chart redraws when scale changes (it's a dependency of the draw effect).
- PNG export stays at its fixed design size (it's already 2x / 1600px).

### 4. GPS speed trail

`components/GPSMapView.tsx`:

- Gradient implemented as multi-stop interpolation in `lib/gradients.ts` (`sampleGradient(stops, t) → rgb`). Presets:
  - `turbo` (default): blue → cyan → green → yellow → orange → red.
  - `classic`: today's green → yellow → red.
  - `viridis`: purple → blue → teal → green → yellow (color-blind friendly).
  - `custom`: two-stop low→high from user colors.
- Range: `auto` = session speed min–max (not 0–max, so slow tracks still use the whole gradient); `fixed` = user min/max in display speed unit, clamped.
- Speed values pass through the unit converter so fixed ranges and the legend use the display unit.
- Finer segments: color per segment of ~3 points instead of the current averaging stride, capped for performance.
- Legend: small bottom-left overlay card with the gradient bar and min/max labels (`62 – 118 km/h`).
- Map re-colors when gradient prefs change without re-creating the Leaflet map.

### 5. Lap selection & compare

State (in `useXRKStore`, session-scoped so it resets on session switch): `selectedLaps: number[]` (lap indices into `lapMarkers` pairs). Actions: `toggleLapSelected`, `setSelectedLaps`, `clearSelectedLaps`.

Laps tab (`LapAnalysisTab.tsx`):
- Checkbox per lap card (click card body also toggles). Header row: "Select best", "Clear", and a count "2 selected — comparing".
- Selected laps show their compare color swatch.

Chart behaviour:
- **0 selected:** unchanged.
- **1 selected:** set `viewRange` to that lap's `[startMs, endMs]` (normal mode, user can still zoom/pan).
- **2+ selected → compare mode:**
  - X axis = lap-relative time `0 … longest selected lap`. Axis labels formatted as lap time.
  - Each channel strip draws one trace per selected lap, offset by that lap's start. Lap 1st-selected = channel color solid 1.5px; subsequent laps = distinct lap palette (fixed palette of ~6 high-contrast colors; channel identity carried by strip label) — my call: in compare mode **color encodes lap**, not channel, because separate strips already identify channels; in overlay chart mode, lap is encoded by dash pattern + lightness of the channel color.
  - Legend row at top: `■ Lap 3 1:12.4  ■ Lap 7 1:11.9 (best)`.
  - Cursor readout shows each lap's value at the cursor's lap-relative time; delta mode measures lap-relative time.
  - Min/max markers in compare mode use the first selected lap only (avoids clutter).
  - A "Compare: Lap 3, Lap 7 ✕" chip in the chart toolbar exits compare mode (clears selection).
  - Pan/zoom clamp to `[0, longestLap]`.
- **GPS map:** selected laps' track segments drawn at full opacity, rest dimmed to ~25%; in compare mode cursor shows a marker per lap (lap colors).
- Laps tab stats stay per lap (already) but use display units.

### 6. Draggable delta bars

In `TelemetryChart.tsx` mouse/touch handlers:

- On mousedown in delta mode, hit-test cursor A and B x-positions with an 6px (×uiScale) tolerance; if hit, enter `dragCursor: 'A' | 'B'` instead of pan.
- While hovering within tolerance, CSS cursor `ew-resize`.
- On move, update `cursorXRef`/`cursor2XRef` directly (refs + `requestDraw`, no React state), clamped to x-range. Dragging A also emits `onCursorTimeChange` (throttled like hover) so the GPS marker follows.
- On mouseup, end drag; it must not be interpreted as a click (no re-placement).
- Touch: same hit-test on single-touch start.
- Existing click-to-place and Shift+Click retained.
- If both cursors are within tolerance, pick the nearer one.

## Build order

1. Preferences store + Settings Display section skeleton.
2. Delta drag (self-contained).
3. Min/max redesign.
4. UI scale.
5. Units.
6. GPS gradient + legend.
7. Lap selection & compare.

Each step lands with unit tests (Vitest) where logic is pure (`units.ts`, `gradients.ts`, visible-window min/max, cursor hit-test, lap-relative mapping) and `npm run check` + `npm run test:client` green.

## Calls made by Claude (please check)

- Preferences in localStorage, not backend settings.
- Added a third unit option, "Logger" (as recorded), as the default so nothing changes until a user opts in.
- Unit overrides keyed by channel short name.
- Default GPS gradient `turbo`; auto range = session min–max (not 0–max).
- Compare mode: color = lap in separate mode; dash/lightness = lap in overlay mode.
- Min/max in compare mode for first selected lap only.
- Single-lap selection zooms rather than filters.
- PNG export adopts new min/max style but ignores UI scale.
- Derived formulas stay on raw units.

## Left to the builder

- Exact colors of the lap palette and preset stops (must pass contrast in light & dark).
- Label collision heuristics details.
- Whether to memoise converted samples in the chart or in a shared hook.
