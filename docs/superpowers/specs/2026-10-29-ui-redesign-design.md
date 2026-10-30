# QuickScope UI Redesign — Design

**Date:** 2026-10-29
**Branch:** `feature/ui_improvements`
**Platforms:** macOS and Windows (Electron), plus the browser dev build

## Intent

Bring QuickScope in line with Apple's design philosophy — clean, calm, content-first, with every
feature thought through — without losing any existing capability. The telemetry is the hero; chrome
recedes until it's needed. It must feel native and correct on **both macOS and Windows**: the design
principles are Apple's, but platform conventions (menu placement, modifier keys, window chrome) follow
each OS.

## Principles (apply to every screen)

1. **Content first.** Charts, maps and numbers get the space; controls are quiet and grouped.
2. **One primary action per screen.** Exactly one filled-blue button per view; everything else is
   plain/tinted.
3. **Progressive disclosure.** Secondary info (sample counts, Hz, hints, source details) appears on
   hover, in a popover, or in a menu — not always-on.
4. **Depth over lines.** Separate surfaces with elevation (tone steps), not 1px borders on everything.
5. **Color means something.** Blue = selection / primary action. Orange = laps and reference marks
   only. Green/amber/red = status only. Channel colors are the only other color on screen.
6. **Consistent rhythm.** 4/8 px spacing grid, a fixed type scale, one corner-radius family.
7. **Platform-correct.** `⌘` on macOS, `Ctrl` on Windows (shown correctly everywhere a shortcut is
   displayed). Native window chrome on each OS — no faux traffic lights on Windows.
8. **Never lose work.** Destructive actions are undoable; state is remembered.

## Non-goals / anti-goals

- **Not** changing the color identity: `#0d0e14` background, `#4361ee` blue, `#f77f00` orange stay.
- **Not** removing any existing feature (delta, derived channels, histogram, XY, GPS, CSV/image export,
  live layouts, AiM pull, activity log, rename, session info, resizable sidebars).
- **Not** replacing the canvas chart engine or adding a UI framework/component library. Tailwind +
  lucide-react stay.
- Anti-goal: a "minimal" look that hides things users need trackside. Anything moved must stay
  reachable in ≤ 2 clicks or one shortcut.
- Anti-goal: a Mac-only feel that looks foreign or broken on Windows.

---

## Phase 1 — Visual redesign

### 1.1 Design tokens (`client/src/index.css`, `tailwind.config.ts`)

Reference implementation of every value below: the v4 mockup's `:root` / `.light` blocks
(`.superpowers/brainstorm/*/content/redesign-v4.html`, "Style guide" tab).

**Surfaces** (depth replaces borders):

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0d0e14` (unchanged) | `#f5f5f7` | window background |
| `--canvas` | `#0d0e14` | `#ffffff` | chart / table area |
| `--surface-1` | `#13151d` | `#fbfbfd` | header, sidebars, bars |
| `--surface-2` | `#1a1d28` | `#ffffff` | cards, list rows, popovers, sheets |
| `--surface-3` | `#232736` | `#ececf0` | control fill, hover |
| `--surface-4` | `#2c3142` | `#e1e1e6` | pressed, selected segment (dark) |
| `--separator` | `rgba(255,255,255,.07)` | `rgba(0,0,0,.08)` | 0.5 px hairlines between list rows / bars only |

**Text** — four levels modeled on Apple's label colors. Light mode moves from the current
navy-tinted `#131520` text to near-black and neutral grays:

| Token | Dark | Light | Use |
|---|---|---|---|
| `--label` | `#eceef3` | `#1d1d1f` | names, values, titles |
| `--label-2` | `#a3a9b9` | `#5e5e66` | subtitles, field labels (AA on all surfaces) |
| `--label-3` | `#6f768a` | `#86868b` | captions, units, counts |
| `--label-4` | `#4b5163` | `#c1c1c6` | disabled, empty swatch outlines |

**Brand & status** — brand unchanged; status colors become tokens (replacing hardcoded
`emerald-500`, `red-500`, `cyan-400`, …), each with a 10–16 % tint variant for backgrounds:

| Token | Dark | Light |
|---|---|---|
| `--primary` (blue) | `#4361ee` (text-on-dark variant `#6b84ff`) | `#3451e0` |
| `--accent` (orange — laps/reference only) | `#f77f00` | `#c75f00` |
| `--success` / `--warning` / `--danger` | `#30d158` / `#ffb340` / `#ff6961` | `#1f9d48` / `#b86e00` / `#d70015` |

Channel trace colors that fail contrast on white (e.g. yellow `#facc15`) already go through
`resolveChartColor`; extend it so yellows map to `#ca8a04` in light mode.

- Remove the duplicated `:root` / `.dark` blocks (define dark once; `.light` overrides).
- Remove hardcoded `hsl(225,…)` values in `SessionBrowser` rows; use tokens.
- Radius: 6 px icon buttons, 7–8 px controls, 9 px tiles, 11–13 px cards/panels, 14 px sheets.
- Spacing: 4 px base grid (4 · 8 · 12 · 16 · 24 · 32).
- Shadows only on floating things (popovers, sheets, toasts, selected segment); cards in light
  mode get a 0.5 px hairline ring instead of a border.
- Motion: 120–150 ms ease-out for hover/press, 200 ms for popovers/sheets; respect
  `prefers-reduced-motion`.

### 1.1b Typography

Use **Apple's system font** through the system font stack — no web-font download:

```css
--font-ui:      -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
--font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
--font-mono:    ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
```

- **macOS:** SF Pro (Text below 20 px, Display at 20 px and above) and SF Mono.
- **Windows:** Segoe UI Variable and Cascadia Mono, the platform equivalents. SF Pro can't be
  bundled for Windows: Apple's font license limits it to Apple platforms. Segoe is also what Windows
  users expect from a native app.
- **Why this matters beyond looks:** `client/index.html` currently loads DM Sans and JetBrains Mono
  from Google Fonts at runtime. Offline at the track, those requests fail and the UI silently
  falls back to a default font. System fonts are always present. Remove the Google Fonts `<link>`s.
- **Numbers:** values (stats, live tiles, table cells, durations) use the UI font with
  `font-variant-numeric: tabular-nums`, as Apple's own data apps do. Monospace is only for chart axis
  ticks, timestamps, cursor/time pills and formula text.
- Centralize font strings in `client/src/lib/fonts.ts`. Canvas (`chart-draw.ts` `MONO_FONT`,
  `chart-export.ts` `MONO`) and Plotly (`HistogramTab`, `XYPlotTab`) read from it instead of
  hardcoding `'JetBrains Mono'` and `'DM Sans'`. Canvas can't resolve CSS variables, so use the literal stack.
- Text uses −0.6 % tracking at 13 px and tighter tracking on display sizes (see scale).

| Style | Size / weight | Tracking | Example use |
|---|---|---|---|
| Large Title | 28 / 700 | −2.2 % | "Sessions" |
| Title | 17 / 600 | −1.5 % | sheet titles, style-guide headings |
| Headline | 13.5 / 600 | −1.2 % | session name in header, panel titles |
| Body | 13 / 400 | −0.6 % | default UI text, menu items |
| Callout | 12.5 / 500 | — | buttons, segmented controls |
| Subhead | 12 / 400, `--label-2` | — | row subtitles, header subtitle |
| Caption | 11 / 600, `--label-3` | +1 % | sidebar section heads, field captions |
| Data L | 24 / 500 tabular | −2 % | live tiles |
| Data M | 17 / 500 tabular | −1.5 % | stats cards |
| Mono | 10–11 / 400 | 0 | axes, timestamps |

### 1.1c Logo — "Gauge"

Chosen concept: a tach-style 270° sweep. The track runs from 135° to 405°, drawn as a dim ring.
The blue gradient arc (`#7f95ff → #4361ee → #3048c9`) runs from 135° to 330° and ends in an
orange `#f77f00` needle-tip dot. A small white telemetry trace sits inside. Reference geometry:
`logo-v3.html` in the brainstorm folder (100-unit box: center 50,53, r 28, stroke 9, tip r 7,
trace stroke 4.5).

Deliverables:
- `build/icon.svg` master: 1024 px, Apple superellipse tile, navy gradient `#242a42 → #0b0c13`
  with a soft top-left highlight and a 0.5 px inner rim. Glyph scaled to 86 % of the tile.
- `build/icon.png` (1024) regenerated from it. electron-builder derives .icns / .ico from the PNG.
- `client/src/components/QuickScopeLogo.tsx`: the bare glyph (no tile) plus the "QuickScope" wordmark
  in SF Pro Display Semibold. The track uses `--label-4`, and the trace uses `currentColor`
  (primary label color).
- Favicon (`client/public/favicon.svg`), the tile version.
- Monochrome glyph variant for small and high-contrast use.

### 1.2 Shared primitives (new, in `client/src/components/ui/`)

Small, hand-rolled (no new dependency): `Button` (primary / tinted / plain / icon),
`SegmentedControl`, `Popover`, `Menu` (also used for right-click context menus), `Sheet` (modal
dialog shell with consistent header/footer), `Tooltip` (shows label + platform-correct shortcut),
`EmptyState`. All existing dialogs (`SettingsDialog`, `ExportDialog`, `ImageExportDialog`,
`DerivedChannelDialog`, `SessionInfoModal`, `AimSessionPicker`, `WidgetConfigDialog`) move onto
`Sheet` for consistent layout, Esc-to-close, and focus trapping.

A `lib/platform.ts` helper exposes `isMac` and `modKey` (`⌘` / `Ctrl`) for display and key handling.

### 1.3 Sessions screen (`SessionBrowser.tsx`)

- **Header:** logo left; right side holds the **AiM status chip** (dot + device name or
  "No device"), theme, settings. Clicking the chip opens a popover with *Pull sessions…*, *Open live
  view*, connection details, and a link to Settings.
- **Title row:** large "Sessions" title + count; search field; one primary **Import** button
  (file picker; drag-and-drop anywhere still works).
- **Activity log** moves out of the action bar into the header's overflow menu, opening as a `Sheet`
  (same two tabs, same data).
- **List:** grouped by recorded date — *Today*, *This Week*, *Earlier* (month headers beyond that).
  Rows on `--surface-2`, no border; larger GPS thumbnail (48 px). Line 1: session name. Line 2
  (secondary): venue · driver · vehicle · date. Right side: duration, laps, source icon.
  The track/event pill is shown only when it varies between visible sessions (today every row
  repeats "Standardized").
- **Row actions:** hover shows a `⋯` button; right-click opens the same context menu: *Open*,
  *Rename*, *Session info*, *Delete*. Inline rename stays.
- Upload progress and errors become toasts in Phase 2; in Phase 1 they become a single slim
  status strip under the title row (replaces the two separate banners).
- Footer removed (count moves next to the title).

### 1.4 Analysis screen

**Header (`SessionHeader.tsx`)**
- Left: back, left-sidebar toggle.
- Center-left: **session name** (primary text) with a one-line secondary subtitle
  `CT16-EV · Oct 22, 2026 · 43:59 · 31 laps · Standardized`. Clicking the title/subtitle opens
  Session Info. Replaces the seven metadata pills and the separate filename pill.
- Center: **Chart / Table** `SegmentedControl`.
- Right: Export menu (CSV, Save image), theme, right-sidebar toggle. The sample count moves into
  Session Info. The `⋮` menu's *Load file* moves into the Export/File area as *Open…*.

**Chart toolbar (`TelemetryChart.tsx`)**
- Left: visible time range.
- Right: **Separate / Overlay** segmented control (moved from the channel sidebar), Δ Delta toggle,
  Save image, Reset zoom (only when zoomed).
- Remove the always-on "scroll to zoom · drag to pan" text; the same info lives in tooltips (and the
  shortcuts sheet in Phase 2). Show it once as a dismissible first-run tip.

**Chart canvas (`chart-draw.ts`)**
- **Lap label thinning:** draw a lap label only if it is at least ~28 px from the previous drawn
  label; marker lines still draw for every lap. Fixes "L10L11L12…" overlap.
- Grid and axis text use the updated tokens; no other behavior change.

**Channel sidebar (`ChannelSidebar.tsx`)**
- Top: search field and "Has data" filter. Derived-channel creation becomes a `+` icon button next to
  the section title.
- **Active section pinned at the top** (replaces the chip cloud at the bottom): color swatch, name,
  unit, remove on hover, click to toggle.
- **Channels grouped** by name prefix (`BMS_`, `APPS_`, `BSE_`, `CAN…`, `Cell_`, …; channels with no
  shared prefix go in *Other*) in collapsible groups, with the collapsed state remembered.
  Derived channels keep their own group.
- Rows: swatch + name + unit. Point count and Hz show on hover (tooltip) only.

**Analysis panel (`AnalysisPanel.tsx` + tabs)**
- Tabs become a compact `SegmentedControl` with icons + labels (Stats, Laps, Histogram, XY, GPS).
- Stats cards: drop inner borders; channel color as a 3 px leading bar; value typography on the
  type scale.
- Laps tab: best lap highlighted with the orange accent (laps = orange).

**Table view** — header and rows adopt surface tokens; no behavior change.

### 1.5 Live screen (`LiveView.tsx`, `live/*`)

- Merge the two bars into one header: back, "Live", layout picker, Edit, `⋯`, and a single
  **connection status** on the right (dot + device name + rate / Connecting… / Not connected), followed
  by the contextual action (Connect / Retry / Pause / Resume). The pin toggle moves into `⋯`.
- Remove the separate in-page "Connecting to the AiM logger…" banner.
- **Offline must never block the layout.** Editing layouts while disconnected already works
  (`fetchLiveChannels` gives the picker channels from the car's earlier sessions), and the redesign
  keeps that fully available:
  - **Not connected:** a slim, non-modal notice under the header, e.g. "Not connected. Showing the
    last values received 12 min ago. Join the logger's Wi-Fi to go live. You can still edit this
    layout." with *Network Settings…*. Tiles show last-received values in `--label-3`, or "—" if
    nothing was ever received. Bars go gray. No overlay or blur.
  - The Local Network permission hint (macOS) appears in this notice only after a connection
    attempt fails.
- **Edit mode** (connected or not): the header becomes "Editing “<layout>”", with *Add Widget*,
  *Cancel* and *Done* (primary). A tinted instruction bar explains moving and resizing. Widgets get a
  blue focus ring with ✎ / ✕ tools and a resize corner. Built-in layouts note "edited as a copy".
- **Widget sheet** (`WidgetConfigDialog` on `Sheet`): title, channel search plus a checklist. While
  offline, each channel shows a tag with when it was last seen ("Seen Oct 27"), and live channels show
  a green "Live" tag. Threshold fields ("Warn above") sit next to the channels they affect.
- Widget cards: depth instead of colored outlines. A tile is tinted amber or red only when its value
  crosses a configured threshold.
- Labels in title case ("Pack Voltage"), not all caps.

### 1.6 Phase 1 acceptance

- All existing tests pass; touched components get updated/added tests (`npm test`, `npm run check`).
- Screens verified in dark and light, at 1280×800 and 1920×1080, on macOS and Windows (CI build or a
  Windows machine) for the packaged app.
- No feature removed; every relocated control reachable in ≤ 2 clicks.
- Launched with networking off: fonts render correctly (no Google Fonts dependency), and live
  layouts can be opened, edited and saved.
- Primary and secondary text pass WCAG AA (4.5:1) on every surface in both themes. Checked for the
  proposed values: secondary is 6.3–8.2:1 in dark mode and 5.5–6.4:1 in light mode. Tertiary is
  3.1–4.3:1, so it's used only for captions, units and counts, never for information that exists
  nowhere else.

---

## Phase 2 — Features

### 2.1 Shortcuts, command palette, shortcut sheet

- Global key handler (`lib/shortcuts.ts`) with a single registry used by the handler, menus, tooltips
  and the sheet, so they can never disagree. Uses `metaKey` on macOS, `ctrlKey` on Windows.
- Default bindings (`Mod` = ⌘ / Ctrl):
  - `Mod+O` open file · `Mod+E` export CSV · `Mod+Shift+S` save image · `Mod+,` settings
  - `Mod+1` / `Mod+2` chart / table · `Mod+Alt+L` / `Mod+Alt+R` toggle sidebars
  - `D` delta · `O` separate/overlay · `Esc` reset zoom / close · `←` / `→` previous/next lap
  - `Mod+K` command palette · `?` shortcut sheet · `Mod+[` back to sessions
- Single-letter keys are ignored while typing in inputs.
- **Command palette (`Mod+K`):** fuzzy search over channels (toggle), channel sets, laps (zoom to), and
  every registered action. Hand-rolled, no new dependency.

### 2.2 App menus (Electron)

- `electron/main.cjs`: add **File** (Open…, Export CSV…, Save Image…, Close Session), **View** (Chart,
  Table, Show Channels, Show Analysis, Theme ▸ Dark/Light/Match System, plus existing zoom/fullscreen),
  **Go** (Sessions, Live, Previous Lap, Next Lap), **Help** (Keyboard Shortcuts, About). On macOS it's
  the top menu bar; on Windows it's the in-window menu bar.
- Menu items send IPC (`quickscope:command`, `{ id }`) to the renderer; `preload.cjs` exposes
  `window.quickscope.onCommand(cb)` and `setMenuState(state)` so items can be enabled/disabled/checked
  based on the current view. Accelerators come from the same registry ids (`CmdOrCtrl+…`).
- In the browser dev build the bridge is absent and keyboard shortcuts still work.

### 2.3 Toasts + undo

- `ToastProvider` (bottom-center, stacked, auto-dismiss 5 s, pause on hover).
- **Delete session:** removed from the list immediately with a toast "Deleted *name* · Undo"; the
  backend delete runs after the toast expires (or on app close). Replaces `window.confirm`.
- **Rename:** toast with Undo (calls rename back).
- Upload/AiM-pull progress and errors move to toasts (progress toast updates in place).

### 2.4 Match-system theme

- Theme becomes `'dark' | 'light' | 'system'` (default stays `'dark'` for existing users;
  new installs default to `'system'`). `system` follows `prefers-color-scheme`, which Electron maps
  to macOS appearance and the Windows app-mode setting. The `ThemeToggle` becomes a 3-way menu.
  Canvas colors re-resolve on change.

### 2.5 Remember workspace

- Per session id, persist active channels (ids + colors), derived channels, view range, chart mode,
  view mode, analysis tab, histogram/XY selections in `localStorage`
  (`quickscope-workspace:<sessionId>`), saved with a debounce (500 ms) and restored on load (fetching
  sample data for restored channels). Missing channels are skipped silently.
- New sessions with no saved workspace fall back to the current "first five channels" behavior, or the
  default channel set if one is chosen (2.6).
- "Reset workspace" in the session's menu.

### 2.6 Channel sets & favorites

- **Favorites:** star a channel (hover action or palette); starred channels appear in a *Favorites*
  group at the top of the sidebar across all sessions (matched by channel name).
- **Channel sets:** save the current active channels (+ chart mode) as a named set; apply from the
  sidebar's set menu or the palette. Sets match channels by name, so they work across sessions; missing
  channels are reported in a toast. Built-in suggestions are not shipped — sets are user-made.
  One set can be marked *default for new sessions*.
- Stored in backend `settings.json` (via the existing settings store) so they survive reinstalls and are
  shared across both platforms' installs on one machine; mirrored to localStorage only as a cache.

### 2.7 Lap navigation

- Click a lap in the Laps tab → zoom the chart to that lap (with small padding) and set the cursor.
- Click a lap label on the chart → same.
- `←` / `→` (and Go menu) step to previous/next lap while zoomed to a lap; status shows "Lap 7 of 31".
- The current lap is highlighted in the Laps tab.

### 2.8 Lap comparison overlay

- Pick a **reference lap** and a **comparison lap** (same session, or a lap from another saved session)
  from the Laps tab ("Compare…").
- Chart enters **Compare mode**: each active channel shows the reference lap (solid, channel color) and
  comparison lap (dashed, lighter) on a shared x-axis. X-axis is **distance** when GPS speed/distance is
  available, else **lap time**; user can switch.
- A **Δ time** strip at the top shows cumulative time gained/lost vs reference.
- Cross-session comparison needs the backend to serve a second session's channel data without
  replacing the loaded one: add `GET /api/sessions/{id}/data?channels=…&start_ms=&end_ms=` that parses
  from the cached file (with a small LRU of parsed sessions).
- Exit Compare with `Esc` or the toolbar button. Image export supports Compare mode.
- This is the largest item; it gets its own implementation plan after 2.1–2.7.

---

## Decisions I made (please check)

- Fonts: system stack (SF Pro / SF Mono on macOS, Segoe UI Variable / Cascadia Mono on Windows)
  instead of bundling SF Pro (license) or Inter (would look non-native on both).
- Light mode uses Apple-style neutral text (`#1d1d1f` and grays) instead of navy-tinted text, with
  a gray window and white content.
- Live view offline is a notice, never an overlay; edit mode works the same online and offline.
- Native title bar on each OS (no custom/frameless window) — lowest risk, most native on Windows.
- Session rows grouped by date; the track pill only shows when it differs between sessions.
- Channel grouping by name prefix is automatic (no manual grouping UI in this project).
- New dependencies: none planned. Palette, toasts, popovers are hand-rolled to match existing style.
- Existing users keep Dark as default; new installs default to Match System.
- Delete is deferred until the undo toast expires, rather than soft-delete in the backend.
- Channel sets/favorites stored in backend `settings.json`; workspaces in localStorage (per machine,
  per session, disposable).
- Lap comparison x-axis prefers distance, falls back to lap time.

## Order of work

1. Phase 1: tokens + primitives → Sessions → Analysis → Live → cross-platform check.
2. Phase 2: shortcuts/palette + menus → toasts/undo → system theme → workspace → sets/favorites →
   lap navigation.
3. Phase 2b: lap comparison overlay (separate plan).
