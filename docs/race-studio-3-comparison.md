# QuickScope vs Race Studio 3: gap analysis and roadmap

_Compared 2026-11-05 against `race_studio_3_deep_research_report.md` (a third-party research
summary; its claims about RS3 were not independently verified). QuickScope state is the
`appletest` branch including uncommitted work._

## Summary

QuickScope already beats RS3 on the things the report lists as RS3's biggest structural
complaints: it runs natively on macOS (Apple Silicon), Windows and Linux; it has a modern
HiDPI canvas chart; it streams live telemetry over WiFi; and it ships with a large automated
test suite (the report's "regression bugs" complaint). The core analysis features RS3 users rely
on are also present in basic form: stacked/overlaid time plots, histogram, X/Y, GPS map, lap list
and lap-compare overlay, math channels, and CSV/PNG export.

The real gap is **distance-based lap analysis**. RS3's most valuable workflow (compare laps by
distance → Δt trace → sectors → theoretical best → "where did I lose time") is missing end to
end, and every piece depends on a **distance channel that our XRK files don't contain** (the
endurance fixture has `GPS Speed`, `GPS Latitude/Longitude`, `LateralAcc`, `InlineAcc`, but no
distance or odometer). Building that one foundation unlocks most of the high-value items below.

The second gap is **lap data hygiene**: laps can't be deleted, split, merged or excluded, which
the report calls out as a top RS3 frustration and which we just hit ourselves (lap 1 gap).

## Feature scorecard

✅ have · 🟡 partial · ❌ missing · ➖ out of scope for QuickScope

### Analysis panels (report §1A)

| RS3 feature | QuickScope | Evidence / notes |
|---|---|---|
| Session database with search/preview | 🟡 | `SessionBrowser.tsx` search + date grouping, GPS thumbnail preview (`gps_preview.py`). No filters by track/driver/vehicle, no SQL index. |
| Custom profiles / multi-monitor layouts | 🟡 | Per-session view state is remembered (`sessionViewState.ts`); live dashboards have saved grid layouts (`live_layout_store.py`). No named analysis profiles, no tear-off windows. |
| Time/Distance plot | 🟡 | Excellent time plot (`TelemetryChart.tsx`: separate/overlay, delta cursors A/B, min/max markers, click-to-change units). **No distance X-axis.** |
| Stack / tile / overlay, colour palettes | ✅ | Separate + overlay modes, per-channel colour picker (`ChannelColorPicker.tsx`). |
| Histogram | 🟡 | `HistogramTab.tsx`: fixed `nbinsx: 50`, sample counts. No bin control, no % of time/lap, no per-lap, no damper-velocity preset. |
| Channels report (min/max/avg/median/std) | 🟡 | `StatsTab.tsx`: min/max with jump-to-time, mean, std, for session or zoom range. **No median, no per-lap / per-sector matrix.** |
| Split times, theoretical best, rolling best | ❌ | Laps tab has lap times, best lap, gap to best, "slow" flag. No sectors at all. |
| X/Y scatter with colour channel | 🟡 | `XYPlotTab.tsx`: X vs Y only. No third colour channel, no g-g preset. |
| Track map coloured by channel | 🟡 | `GPSMapView.tsx`: speed gradient, lap highlighting, cursor markers. Only speed can colour the trace. OSM tiles **online only**. |
| Storyboard / Δt trace vs reference lap | 🟡 | Lap-compare overlay aligns laps by lap-relative **time** (`lap-compare.ts`). No Δt trace, no distance alignment. |
| Math channels | 🟡 | Formula engine (`formula-engine.ts`: arithmetic, `abs sqrt sin cos tan log exp floor ceil round sign`) + sandboxed Python/numpy (`derived_eval.py`). No derivative/integral/filter/if/lookup in formulas, no preset library. |
| Video panel / SmartyCam sync | ❌ | None. |

### Device / ecosystem (report §1B, §1C)

| RS3 feature | QuickScope | Notes |
|---|---|---|
| Dash/logger config, PDM, CAN/DBC builder, overlay designer | ➖ | Keep RS3 for device configuration. QuickScope is the analysis + live tool. |
| WiFi session download | ✅ | AiM pull with progress, keepalive, trace logs (`routes/sessions.py`, `aim_*`). |
| Live telemetry | ✅ | Live WS dashboards with saved layouts. Not covered by the report; a genuine QuickScope advantage. |
| Track database / weather / predictive laps | ❌ | Low value for FSAE: cone courses change every event. |
| Cloud sharing | ❌ | Local-only by design (cloud sync was removed). File-based sharing of sessions + views would cover the team need. |
| Sim racing import (`.ibt`) | ❌ | Not relevant. |
| Mobile app | ❌ | Electron + responsive web UI; no phone build. |

### Gripes and bugs (report §2, §3), QuickScope status

| RS3 problem | QuickScope status |
|---|---|
| Steep learning curve, hidden right-click menus | 🟡 Better: units and colours are click-to-change on the chart. Still no onboarding, shortcuts or command palette. |
| No coaching insights | ❌ Same gap. |
| RS2-style speed (spacebar channel toggle) | ❌ No keyboard channel toggling; only Ctrl/Cmd+G in Table view. |
| Windows-only / Apple Silicon pain | ✅ Solved: dmg/zip arm64 + x64, NSIS, Linux (`package.json` build targets), libxrk parser on mac/linux. |
| Mobile analysis ceiling | ❌ n/a |
| Burned-in overlays / GoPro sync | ❌ No video. |
| No FFT / contour maps / heavy math | 🟡 Python derived channels can do FFT maths but there is no FFT *plot*. |
| Can't delete/split bad laps | ❌ Same gap, and the auto-detected GPS laps (`lap_detection.py`) make it more likely. |
| WiFi subnet conflicts (10.0.0.x) | 🟡 Broadcast discovery + candidate IPs (`aim_discovery.py`), macOS Local Network issue documented. No detection of a conflicting 10.0.0.0/24 route/VPN. |
| HiDPI blur | ✅ Canvas scales by `devicePixelRatio`; vector UI. |
| Database bloat | 🟡 `sessions.json` is re-read and re-parsed on every store call (8 `_load()` sites in `session_store.py`). Fine now, O(n) per request at thousands of sessions. |
| Corrupted video files | ➖ n/a |
| GPS map offset, no nudge tool | ❌ Same gap. |
| Update regressions | ✅ Mitigated: ~1,190 automated tests (675 backend, 514 client) incl. DLL/libxrk golden regressions. |

## Recommended roadmap

Ordered by value to an FSAE team and by dependency. Effort: S ≈ ≤1 day, M ≈ 2–4 days, L ≈ 1–2 weeks.

### P0: distance-based lap analysis (the RS3 core workflow)

**1. Distance channel (foundation): M**
- `client/src/lib/distance.ts`: integrate `GPS Speed` over time (trapezoidal, unit-aware via
  `units.ts`), falling back to haversine over lat/lon. Reset to 0 at each lap marker to get
  *lap distance*. Expose as a virtual channel `Distance` / `Lap Distance` so it works in
  Table, X/Y and export for free.
- Backend option if it gets heavy: compute once in `extract_session_info` and cache with the
  session (`session_cache.py`).
- Tests: constant-speed ramp gives exact distance; unit conversion (km/h, mph, m/s); NaN gaps.

**2. Distance X-axis toggle in the chart: M**
- `TelemetryChart.tsx` already abstracts x via `timeToX`/`xToTime`; add an x-domain mode
  (`time | distance`) that maps each sample through the distance channel. In lap-compare mode
  this aligns laps by position on track instead of elapsed time (RS3's main compare mode).
- Toolbar toggle `Time | Distance`, persisted in `sessionViewState.ts`.

**3. Δt (time-delta) trace vs a reference lap: M**
- For each compared lap, resample lap time onto the reference lap's distance grid;
  Δt(d) = t_lap(d) − t_ref(d). Draw as a dedicated strip (green below 0, red above) in compare
  mode; the first selected lap is the reference (already ordered: `selectedLaps`).
- Also feeds #6 (map colour) and #12 (coach).

**4. Lap editor: delete / ignore / split / merge / drop start-finish pin: M**
- Persist overrides per session in `sessions.json` (`lap_overrides: {excluded: [...],
  extra_markers_ms: [...], removed_markers_ms: [...]}`), applied after `lap_detection.detect_laps`.
- UI: row actions in `LapAnalysisTab.tsx` (Exclude, Split here at cursor, Merge with next) and
  a global "Ignore out/in laps" toggle using the existing `isSlow` heuristic. Excluded laps drop
  out of best lap, gaps, theoretical best and stats.
- Lets the lap-1 rule we just added become user-controllable.

**5. Sectors, theoretical best, rolling best: M**
- Sectors = N equal-distance splits by default (needs #1), editable as distance markers.
- Split report in the Laps tab: lap × sector table with heat-map colouring, **theoretical best**
  (sum of best sectors) and **best rolling lap** (min over any start distance of a one-lap-long
  window: sliding window on the distance/time arrays).

### P1: close the analysis-panel gaps

**6. Map colouring by any channel and by Δt; offline tiles; map nudge: M**
- Generalise the speed gradient in `GPSMapView.tsx` to any selected channel.
- Cache OSM tiles (Electron: a service worker or main-process cache) so the map works in the
  paddock with no internet. **Today the map is blank offline.**
- X/Y offset nudge (arrow keys + reset), stored per track location.

**7. Channels report matrix: S**
- Extend `StatsTab.tsx` with **median** and a lap × channel matrix (min/max/mean/median/std per
  lap, later per sector). `computeStats` in `xrk-parser.ts` is the single place to add median.

**8. Histogram upgrade: S–M**
- Bin count/width control, y as % of time (weight samples by Δt) or % of lap, per-lap filter.
- "Damper velocity" preset: derivative of a damper-pot channel, bump/rebound split at 0 and
  low/high-speed split at a configurable threshold.

**9. X/Y colour channel + g-g diagram preset: S**
- Third channel → Plotly `marker.color` with colourbar. One-click "Friction circle" using
  `LateralAcc` vs `InlineAcc` (or `GPS LatAcc/LonAcc`) with a 1 g reference circle.

**10. Math engine upgrades + preset library: M**
- Add to `formula-engine.ts`: `deriv(x)`, `integ(x)`, `smooth(x, n)` / `lowpass(x, hz)`,
  `if(cond, a, b)` with comparisons, `clamp`, `min/max(a,b)`, `lookup(x, table)`.
- Presets in `DerivedChannelDialog.tsx`: shock velocity, corner radius `v²/a_lat`, gear
  (RPM/speed ratio clustering), brake balance %, power (V×I for the EV), energy (∫P dt).

**11. Speed for power users: S**
- Keyboard: Space toggles the focused channel, ↑/↓ moves through the list, `R` resets zoom,
  `D` toggles delta cursors, `?` shows a shortcut sheet. Optional ⌘K command palette.

**12. Named workspace profiles: M**
- "Driver", "Powertrain", "Suspension" profiles = saved channel sets + chart mode + analysis
  tab, applicable to any session (generalise `SavedSessionView` to be session-independent;
  channels already stored by name).

### P2: differentiators and polish

**13. Coach view: L** (after #3 and #5)
- Rank the top 3 sectors by time lost vs theoretical best; for each, compare brake-start
  distance, minimum speed and throttle-pickup distance against the best sector and emit
  rule-based plain-English lines ("Braked 6 m earlier into sector 4, min speed 3 km/h lower").
  Rule-based first; no AI dependency needed.

**14. FFT / PSD panel: M**
- New analysis tab; backend endpoint using numpy (`np.fft.rfft`, Welch PSD), resampling
  uneven timestamps first. Use for suspension, motor/inverter vibration.

**15. WiFi diagnostics: S**
- On connect failure, list local interfaces/routes overlapping `10.0.0.0/24` (VPN, Ethernet)
  and the macOS Local Network permission state, and say which one to disable.

**16. Session library at scale: M** (only when needed)
- Swap `sessions.json` for SQLite (stdlib `sqlite3`) with indexes on date/track/driver/vehicle;
  add filters in `SessionBrowser.tsx`.

**17. Multi-zone tyre temperature contour: L** (only if IR tyre sensors are fitted)

**18. Video sync + overlay export: L/XL**: defer. Large scope (decode, frame sync, render);
revisit after P0/P1.

### Not recommended

Device configuration, PDM logic, CAN/DBC builder, SmartyCam overlay designer, track database,
cloud sync, sim-racing import. These are RS3's domain or irrelevant to FSAE; QuickScope should
stay the fast analysis + live tool next to RS3, not replace its configuration side.

## Strengths to protect

- Native macOS/Windows/Linux and Apple Silicon (the report's #1 wishlist item).
- Live WiFi telemetry dashboards (no RS3 equivalent in the report).
- Click-to-change units / colours directly on the chart (addresses the "hidden menus" gripe).
- Test suite and golden parser regressions (addresses "update regressions").
- Remembered per-session views and lap selection.
