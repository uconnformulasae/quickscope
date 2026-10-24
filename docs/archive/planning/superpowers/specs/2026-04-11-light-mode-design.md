# Light Mode for QuickScope

**Date:** 2026-04-11
**Approach:** CSS Variable Swap (Approach A)

## Overview

Add a light mode toggle to QuickScope that switches between the existing dark motorsport theme and a new Clean White light theme. The toggle is a bare icon (moon/sun) present in both the Session Browser and Session Header. Theme preference persists to localStorage.

## Toggle Component

### ThemeToggle

A minimal clickable icon using lucide-react's `Moon` and `Sun` icons:

- **Dark mode**: Moon icon in Electric Blue (`#4361ee`)
- **Light mode**: Sun icon in Bright Gold (`#f5a623`)
- No background, no border — bare icon only
- Placed in both `SessionHeader` (right side, next to sidebar toggles) and `SessionBrowser` (top area, next to settings)

### useTheme Hook

- Reads initial theme from `localStorage.getItem('quickscope-theme')`, defaulting to `'dark'`
- `toggleTheme()`: swaps `dark`/`light` class on `document.documentElement`, writes to localStorage
- Returns `{ theme, toggleTheme }`

### main.tsx

Replace the hardcoded `document.documentElement.classList.add('dark')` with:

```ts
const saved = localStorage.getItem('quickscope-theme') || 'dark';
document.documentElement.classList.add(saved);
```

This prevents flash-of-wrong-theme on load.

## Light Mode CSS Variables (Clean White)

Retune the existing `.light` block in `index.css`:

| Token | Dark (`:root`) | Light (`.light`) |
|---|---|---|
| `--background` | `232 28% 7%` | `220 14% 96%` |
| `--foreground` | `220 15% 88%` | `230 25% 10%` |
| `--card` | `230 25% 10%` | `0 0% 100%` |
| `--card-foreground` | `220 15% 88%` | `230 25% 10%` |
| `--popover` | `230 25% 10%` | `0 0% 100%` |
| `--popover-foreground` | `220 15% 88%` | `230 25% 10%` |
| `--primary` | `232 82% 59%` | `232 82% 50%` |
| `--primary-foreground` | `0 0% 100%` | `0 0% 100%` |
| `--secondary` | `230 20% 16%` | `220 14% 92%` |
| `--secondary-foreground` | `220 15% 75%` | `230 20% 25%` |
| `--muted` | `230 20% 14%` | `220 14% 94%` |
| `--muted-foreground` | `220 10% 50%` | `220 10% 42%` |
| `--accent` | `28 100% 49%` | `28 100% 45%` |
| `--accent-foreground` | `0 0% 100%` | `0 0% 100%` |
| `--destructive` | `0 72% 51%` | `0 72% 51%` |
| `--destructive-foreground` | `0 0% 100%` | `0 0% 100%` |
| `--border` | `230 20% 20%` | `220 14% 85%` |
| `--input` | `230 20% 18%` | `220 14% 90%` |
| `--ring` | `232 82% 59%` | `232 82% 50%` |

Chart colors (`--chart-1` through `--chart-6`) remain unchanged — they work on both backgrounds.

## Canvas & Chart Colors

### New CSS Variables

Add theme-aware CSS variables for canvas drawing colors:

| Variable | Dark | Light |
|---|---|---|
| `--chart-grid` | `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.06)` |
| `--chart-text` | `#8b93a8` | `hsl(220,10%,42%)` |
| `--chart-cursor` | `rgba(255,255,255,0.5)` | `rgba(0,0,0,0.35)` |
| `--chart-cursor-pill` | `rgba(13,14,20,0.9)` | `rgba(255,255,255,0.92)` |
| `--chart-cursor-pill-text` | `#dde1ec` | `#131520` |
| `--chart-delta-fill` | `rgba(34,211,238,0.10)` | `rgba(34,211,238,0.12)` |
| `--chart-delta-line` | `rgba(34,211,238,0.7)` | `rgba(34,211,238,0.8)` |
| `--chart-delta-panel` | `rgba(13,14,20,0.92)` | `rgba(255,255,255,0.95)` |
| `--chart-delta-accent` | `#22d3ee` | `#0ea5c9` |
| `--chart-separator` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.06)` |
| `--chart-hover-line` | `rgba(255,255,255,0.25)` | `rgba(0,0,0,0.2)` |
| `--chart-lap-marker` | `rgba(247,127,0,0.35)` | `rgba(200,100,0,0.3)` |
| `--chart-lap-text` | `#f77f00` | `#c56600` |

### getChartColors() Function

In `chart-utils.ts`, replace the 8 exported constants with a `getChartColors(el: HTMLElement)` function:

- Reads CSS variables once via `getComputedStyle(el)`
- Returns a typed object with all chart color values
- Called once per draw frame (no performance concern — single DOM read)

### DrawContext Integration

Add a `colors` field to the existing `DrawContext` interface. All draw functions (`chart-draw.ts`, `chart-cursors.ts`) reference `dc.colors.gridColor` instead of the old `GRID_COLOR` constant.

### Inline Hardcoded Colors

Replace ~12 inline hex/rgba values in `chart-draw.ts` and `chart-cursors.ts` with references to `dc.colors`:

- `chart-draw.ts`: lap marker stroke/fill, grid separator lines
- `chart-cursors.ts`: hover cursor color, pill backgrounds, delta panel text

## Plotly Charts (HistogramTab, XYPlotTab)

Create a shared `getPlotlyThemeColors()` helper that reads CSS variables and returns Plotly-compatible layout colors:

```ts
{ gridcolor, tickfontColor, fontColor, paperBgColor, plotBgColor }
```

Used in both `HistogramTab.tsx` and `XYPlotTab.tsx` to replace hardcoded `gridcolor: 'rgba(255,255,255,0.05)'`, `color: '#8b93a8'`, etc.

## Component Fixes

### QuickScopeLogo.tsx

The `<rect>` fill is hardcoded to `hsl(230 25% 10%)` (dark surface). Make it theme-aware:

- **Dark**: Keep the filled rect (`hsl(var(--card))`)
- **Light**: `fill="none"` — the crosshair and trace float directly on the header

Use `hsl(var(--card))` for the rect fill — in dark mode this renders as the dark surface, in light mode the card is white which effectively disappears against the white header. Alternatively, read the current theme and conditionally render the rect. The SVG strokes (`#4361ee`, `#f77f00`) stay unchanged — they're brand colors that work on both backgrounds.

### DerivedChannelDialog.tsx

Replace hardcoded background colors with semantic Tailwind classes:

- `bg-[#080910]` → `bg-background`
- `bg-[#0d0e14]` → `bg-card` (for the dialog container)
- Canvas preview colors (`#4361ee`, `#8b93a8`) → use `getChartColors()`

### Status Badges (SessionBrowser, AimSessionPicker, SettingsDialog)

Status colors need slightly darker variants in light mode for readability:

| Status | Dark | Light |
|---|---|---|
| Success/Synced | `text-emerald-400` | `text-emerald-500` |
| Warning/Local | `text-amber-400` | `text-amber-500` |
| Info/Remote | `text-blue-400` | `text-blue-500` |
| Error | `text-red-400` | `text-red-500` |

Use `dark:text-{color}-400 text-{color}-500` pattern, or a helper that returns the appropriate class.

Background tints (`bg-emerald-500/10`, `bg-red-500/10`, etc.) work on both themes without changes.

## GPSMapView

The map has hardcoded marker colors:

- `fillColor: '#ffffff'` → use foreground CSS variable
- `color: '#4361ee'` → primary, works on both

The speed-gradient coloring (`rgb(...)` computed values) works on any background since it uses saturated colors.

## Files Changed

| File | Change |
|---|---|
| `client/src/index.css` | Retune `.light` variables, add `--chart-*` variables to both themes |
| `client/src/main.tsx` | Read localStorage for initial theme |
| `client/src/lib/chart-utils.ts` | Replace color constants with `getChartColors()`, add `colors` to `DrawContext` |
| `client/src/lib/chart-draw.ts` | Use `dc.colors` instead of hardcoded values |
| `client/src/lib/chart-cursors.ts` | Use `dc.colors` instead of hardcoded values |
| `client/src/components/ThemeToggle.tsx` | **New** — bare icon toggle component |
| `client/src/lib/useTheme.ts` | **New** — theme hook with localStorage persistence |
| `client/src/components/SessionHeader.tsx` | Add ThemeToggle |
| `client/src/components/SessionBrowser.tsx` | Add ThemeToggle, update status badge classes |
| `client/src/components/QuickScopeLogo.tsx` | Theme-aware rect fill |
| `client/src/components/DerivedChannelDialog.tsx` | Replace hardcoded bg colors, use chart color helper |
| `client/src/components/analysis/HistogramTab.tsx` | Use `getPlotlyThemeColors()` |
| `client/src/components/analysis/XYPlotTab.tsx` | Use `getPlotlyThemeColors()` |
| `client/src/components/GPSMapView.tsx` | Theme-aware marker fillColor |
| `client/src/components/AimSessionPicker.tsx` | Update status badge classes |
| `client/src/components/SettingsDialog.tsx` | Update status badge classes |
| `client/src/App.tsx` | Update error text class |
| `client/src/components/ChannelSidebar.tsx` | No changes needed (uses CSS variables already) |
| `client/src/components/TelemetryChart.tsx` | Pass chart colors into draw context |
