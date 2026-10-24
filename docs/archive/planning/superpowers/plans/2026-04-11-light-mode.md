# Light Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable light mode to QuickScope with localStorage persistence, Clean White palette, and theme-aware canvas/chart colors.

**Architecture:** CSS variable swap approach — toggle `.dark`/`.light` class on `<html>`. A `useTheme` hook manages state and localStorage. Canvas chart colors read CSS variables at draw time via a `getChartColors()` helper passed through the existing `DrawContext`.

**Tech Stack:** React, Tailwind CSS v3 (class-based dark mode), CSS custom properties, lucide-react icons, localStorage API.

**Spec:** `docs/superpowers/specs/2026-04-11-light-mode-design.md`

---

### Task 1: Theme Infrastructure (useTheme hook + main.tsx)

**Files:**
- Create: `client/src/lib/useTheme.ts`
- Modify: `client/src/main.tsx`

- [ ] **Step 1: Create useTheme hook**

Create `client/src/lib/useTheme.ts`:

```ts
import { useState, useCallback, useEffect } from 'react';

type Theme = 'dark' | 'light';
const STORAGE_KEY = 'quickscope-theme';

function getInitialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggleTheme } as const;
}
```

- [ ] **Step 2: Update main.tsx to read localStorage**

In `client/src/main.tsx`, replace:

```ts
// QuickScope is dark-first — apply dark class immediately to prevent flash
document.documentElement.classList.add('dark');
```

with:

```ts
// Apply saved theme immediately to prevent flash
const savedTheme = localStorage.getItem('quickscope-theme') || 'dark';
document.documentElement.classList.add(savedTheme);
```

- [ ] **Step 3: Verify the app still loads in dark mode**

Run: `cd client && npm run dev`

Open in browser. The app should look identical — still dark mode. Check the console for errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/useTheme.ts client/src/main.tsx
git commit -m "Add useTheme hook with localStorage persistence"
```

---

### Task 2: ThemeToggle Component

**Files:**
- Create: `client/src/components/ThemeToggle.tsx`

- [ ] **Step 1: Create ThemeToggle component**

Create `client/src/components/ThemeToggle.tsx`:

```tsx
import { Moon, Sun } from 'lucide-react';

interface ThemeToggleProps {
  theme: 'dark' | 'light';
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  return (
    <button
      onClick={onToggle}
      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <Moon className="w-4 h-4" style={{ color: '#4361ee' }} />
      ) : (
        <Sun className="w-4 h-4" style={{ color: '#f5a623' }} />
      )}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/ThemeToggle.tsx
git commit -m "Add ThemeToggle icon component"
```

---

### Task 3: Wire ThemeToggle into SessionHeader and SessionBrowser

**Files:**
- Modify: `client/src/components/SessionHeader.tsx`
- Modify: `client/src/components/SessionBrowser.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Add useTheme to App.tsx and pass down**

In `client/src/App.tsx`, import useTheme and ThemeToggle:

```ts
import { useTheme } from './lib/useTheme';
```

Call the hook at the top of the App component:

```ts
const { theme, toggleTheme } = useTheme();
```

Pass `theme` and `toggleTheme` to both `SessionHeader` and `SessionBrowser` as props.

For `SessionHeader`, add props to the existing invocation:

```tsx
<SessionHeader
  // ... existing props ...
  theme={theme}
  onToggleTheme={toggleTheme}
/>
```

For `SessionBrowser`, add props to the existing invocation:

```tsx
<SessionBrowser
  // ... existing props ...
  theme={theme}
  onToggleTheme={toggleTheme}
/>
```

- [ ] **Step 2: Add ThemeToggle to SessionHeader**

In `client/src/components/SessionHeader.tsx`:

1. Import ThemeToggle:
```ts
import { ThemeToggle } from './ThemeToggle';
```

2. Add `theme` and `onToggleTheme` to the `SessionHeaderProps` interface:
```ts
interface SessionHeaderProps {
  // ... existing props ...
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}
```

3. Destructure the new props in the function signature.

4. Add the ThemeToggle in the right controls area, just before the right panel toggle button (line 136). Insert:

```tsx
<ThemeToggle theme={theme} onToggle={onToggleTheme} />
```

So the right controls section ends with:

```tsx
<ThemeToggle theme={theme} onToggle={onToggleTheme} />

<button
  onClick={onToggleRight}
  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
  title={rightOpen ? 'Hide analysis' : 'Show analysis'}
>
  {rightOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
</button>
```

- [ ] **Step 3: Add ThemeToggle to SessionBrowser**

In `client/src/components/SessionBrowser.tsx`:

1. Import ThemeToggle:
```ts
import { ThemeToggle } from './ThemeToggle';
```

2. Add `theme` and `onToggleTheme` to the `SessionBrowserProps` interface:
```ts
interface SessionBrowserProps {
  onSessionLoaded: (info: SessionInfo, sessionId: string, fileName: string) => void;
  onOpenSettings: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}
```

3. Destructure the new props.

4. In the header (around line 230-258), add `<ThemeToggle theme={theme} onToggle={onToggleTheme} />` right before the Settings button:

```tsx
<ThemeToggle theme={theme} onToggle={onToggleTheme} />

<button
  onClick={onOpenSettings}
  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
  title="Settings"
>
  <Settings className="w-4 h-4" />
</button>
```

- [ ] **Step 4: Test toggle in browser**

Run the dev server, click the moon icon. The page should swap to light mode (it won't look right yet — colors are still being tuned). Click again, it should return to dark mode. Refresh the page — it should remember the last choice.

- [ ] **Step 5: Commit**

```bash
git add client/src/App.tsx client/src/components/SessionHeader.tsx client/src/components/SessionBrowser.tsx
git commit -m "Wire ThemeToggle into SessionHeader and SessionBrowser"
```

---

### Task 4: Retune Light Mode CSS Variables

**Files:**
- Modify: `client/src/index.css`

- [ ] **Step 1: Replace the `.light` block**

In `client/src/index.css`, replace the entire `.light { ... }` block (lines 85-105) with:

```css
  .light {
    --background: 220 14% 96%;       /* #f0f1f5 light gray */
    --foreground: 230 25% 10%;       /* #131520 dark text */

    --card: 0 0% 100%;               /* #ffffff white */
    --card-foreground: 230 25% 10%;

    --popover: 0 0% 100%;
    --popover-foreground: 230 25% 10%;

    --primary: 232 82% 50%;          /* slightly deeper blue for white bg */
    --primary-foreground: 0 0% 100%;

    --secondary: 220 14% 92%;
    --secondary-foreground: 230 20% 25%;

    --muted: 220 14% 94%;
    --muted-foreground: 220 10% 42%;

    --accent: 28 100% 45%;
    --accent-foreground: 0 0% 100%;

    --destructive: 0 72% 51%;
    --destructive-foreground: 0 0% 100%;

    --border: 220 14% 85%;           /* #d4d7e0 */
    --input: 220 14% 90%;
    --ring: 232 82% 50%;
  }
```

- [ ] **Step 2: Test in browser**

Toggle to light mode. The overall layout should now show:
- Light gray background
- White cards/sidebars
- Dark text
- Soft gray borders

The canvas charts will still look wrong (hardcoded colors) — that's expected and fixed in Task 5.

- [ ] **Step 3: Commit**

```bash
git add client/src/index.css
git commit -m "Retune light mode CSS variables for Clean White palette"
```

---

### Task 5: Theme-Aware Canvas Chart Colors

**Files:**
- Modify: `client/src/index.css`
- Modify: `client/src/lib/chart-utils.ts`
- Modify: `client/src/lib/chart-draw.ts`
- Modify: `client/src/lib/chart-cursors.ts`
- Modify: `client/src/components/TelemetryChart.tsx`

This is the largest task. It replaces all hardcoded canvas colors with CSS variable reads.

- [ ] **Step 1: Add chart CSS variables to index.css**

In `client/src/index.css`, add the following variables inside the `:root { ... }` block (after the `--chart-6` line, before the closing `}`):

```css
    /* Canvas chart colors */
    --chart-grid: rgba(255,255,255,0.05);
    --chart-text: #8b93a8;
    --chart-cursor: rgba(255,255,255,0.5);
    --chart-cursor-pill: rgba(13,14,20,0.9);
    --chart-cursor-pill-text: #dde1ec;
    --chart-delta-fill: rgba(34,211,238,0.10);
    --chart-delta-line: rgba(34,211,238,0.7);
    --chart-delta-panel: rgba(13,14,20,0.92);
    --chart-delta-accent: #22d3ee;
    --chart-separator: rgba(255,255,255,0.08);
    --chart-hover-line: rgba(255,255,255,0.25);
    --chart-lap-marker: rgba(247,127,0,0.35);
    --chart-lap-text: #f77f00;
```

Add the same variables inside the `.dark { ... }` block (same values as `:root`).

Add light variants inside the `.light { ... }` block:

```css
    --chart-grid: rgba(0,0,0,0.06);
    --chart-text: hsl(220,10%,42%);
    --chart-cursor: rgba(0,0,0,0.35);
    --chart-cursor-pill: rgba(255,255,255,0.92);
    --chart-cursor-pill-text: #131520;
    --chart-delta-fill: rgba(34,211,238,0.12);
    --chart-delta-line: rgba(34,211,238,0.8);
    --chart-delta-panel: rgba(255,255,255,0.95);
    --chart-delta-accent: #0ea5c9;
    --chart-separator: rgba(0,0,0,0.06);
    --chart-hover-line: rgba(0,0,0,0.2);
    --chart-lap-marker: rgba(200,100,0,0.3);
    --chart-lap-text: #c56600;
```

- [ ] **Step 2: Add ChartColors type and getChartColors() to chart-utils.ts**

In `client/src/lib/chart-utils.ts`, replace the color constant block (lines 62-69):

```ts
export const GRID_COLOR = 'rgba(255,255,255,0.05)';
export const TEXT_COLOR = '#8b93a8';
export const CURSOR_COLOR = 'rgba(255,255,255,0.5)';
export const CURSOR_PILL_BG = 'rgba(13,14,20,0.9)';
export const DELTA_FILL = 'rgba(34,211,238,0.10)';
export const DELTA_LINE = 'rgba(34,211,238,0.7)';
export const DELTA_PANEL_BG = 'rgba(13,14,20,0.92)';
export const DELTA_ACCENT = '#22d3ee';
```

with:

```ts
export interface ChartColors {
  grid: string;
  text: string;
  cursor: string;
  cursorPill: string;
  cursorPillText: string;
  deltaFill: string;
  deltaLine: string;
  deltaPanel: string;
  deltaAccent: string;
  separator: string;
  hoverLine: string;
  lapMarker: string;
  lapText: string;
}

export function getChartColors(el: HTMLElement): ChartColors {
  const s = getComputedStyle(el);
  return {
    grid: s.getPropertyValue('--chart-grid').trim(),
    text: s.getPropertyValue('--chart-text').trim(),
    cursor: s.getPropertyValue('--chart-cursor').trim(),
    cursorPill: s.getPropertyValue('--chart-cursor-pill').trim(),
    cursorPillText: s.getPropertyValue('--chart-cursor-pill-text').trim(),
    deltaFill: s.getPropertyValue('--chart-delta-fill').trim(),
    deltaLine: s.getPropertyValue('--chart-delta-line').trim(),
    deltaPanel: s.getPropertyValue('--chart-delta-panel').trim(),
    deltaAccent: s.getPropertyValue('--chart-delta-accent').trim(),
    separator: s.getPropertyValue('--chart-separator').trim(),
    hoverLine: s.getPropertyValue('--chart-hover-line').trim(),
    lapMarker: s.getPropertyValue('--chart-lap-marker').trim(),
    lapText: s.getPropertyValue('--chart-lap-text').trim(),
  };
}
```

- [ ] **Step 3: Add `colors` to DrawContext**

In `client/src/lib/chart-utils.ts`, add `colors: ChartColors;` to the `DrawContext` interface (after the `needsDrawRef` field on line 50):

```ts
export interface DrawContext {
  // ... existing fields ...
  needsDrawRef: { current: boolean };
  colors: ChartColors;
}
```

- [ ] **Step 4: Update TelemetryChart.tsx to pass colors into DrawContext**

In `client/src/components/TelemetryChart.tsx`:

1. Add `getChartColors` to the import from `chart-utils`:
```ts
import {
  type TelemetryChartProps, type StripLayout, type DrawContext,
  LEFT_MARGIN, RIGHT_MARGIN, BOTTOM_AXIS_HEIGHT, MIN_STRIP_HEIGHT, AXIS_WIDTH,
  DEBOUNCE_MS,
  clamp, niceAxisTicks, getChartColors,
} from '../lib/chart-utils';
```

2. In the `draw` callback (around line 264-288), read chart colors from the canvas element and pass them into the DrawContext. Add this line before the `dc` construction:

```ts
const colors = getChartColors(canvas);
```

3. Add `colors` to the `dc` object:

```ts
const dc: DrawContext = {
  ctx, w, h, lm, rm, plotW, xRange, xTicks, strips,
  channelDataMap, chartMode, sharedYRanges,
  timeToX, getDownsampled, overlayAxisLayout, session,
  smoothedYRanges: smoothedYRanges.current,
  needsDrawRef,
  colors,
};
```

- [ ] **Step 5: Update chart-draw.ts to use dc.colors**

In `client/src/lib/chart-draw.ts`:

1. Remove `GRID_COLOR` and `TEXT_COLOR` from the import (line 8):
```ts
import {
  MONO_FONT, AXIS_WIDTH,
  BOTTOM_AXIS_HEIGHT,
  niceAxisTicks, formatValue, formatTimeSec, clamp, brightenColor,
} from './chart-utils';
```

2. Replace every usage of `GRID_COLOR` with `dc.colors.grid`.
3. Replace every usage of `TEXT_COLOR` with `dc.colors.text`.
4. Replace inline hardcoded colors:
   - `'rgba(247,127,0,0.35)'` → `dc.colors.lapMarker`
   - `'#f77f00'` (lap text fill) → `dc.colors.lapText`
   - `'rgba(255,255,255,0.08)'` → `dc.colors.separator`
   - `'rgba(255,255,255,0.15)'` → `dc.colors.separator`

Search for all occurrences of these patterns and replace them. The replacements are:
- Line 124: `ctx.strokeStyle = GRID_COLOR` → `ctx.strokeStyle = dc.colors.grid`
- Line 145: `ctx.strokeStyle = 'rgba(247,127,0,0.35)'` → `ctx.strokeStyle = dc.colors.lapMarker`
- Line 162: `ctx.fillStyle = '#f77f00'` → `ctx.fillStyle = dc.colors.lapText`
- Line 214: `ctx.strokeStyle = 'rgba(255,255,255,0.08)'` → `ctx.strokeStyle = dc.colors.separator`
- Line 300: `ctx.fillStyle = TEXT_COLOR` → `ctx.fillStyle = dc.colors.text`
- Line 310: `ctx.strokeStyle = 'rgba(255,255,255,0.15)'` → `ctx.strokeStyle = dc.colors.separator`
- Line 319: `ctx.fillStyle = TEXT_COLOR` → `ctx.fillStyle = dc.colors.text`
- Line 369: `ctx.strokeStyle = 'rgba(255,255,255,0.08)'` → `ctx.strokeStyle = dc.colors.separator`
- Line 377: `ctx.fillStyle = TEXT_COLOR` → `ctx.fillStyle = dc.colors.text`
- Line 391: `ctx.fillStyle = TEXT_COLOR` → `ctx.fillStyle = dc.colors.text`

- [ ] **Step 6: Update chart-cursors.ts to use dc.colors**

In `client/src/lib/chart-cursors.ts`:

1. Remove cursor/delta color imports (lines 9-10):
```ts
import {
  MONO_FONT,
  clamp, interpolateValue, nearestSample, formatValue, formatTimeSec,
} from './chart-utils';
```

2. Replace all color references:
   - `CURSOR_COLOR` → `dc.colors.cursor`
   - `CURSOR_PILL_BG` → `dc.colors.cursorPill`
   - `DELTA_FILL` → `dc.colors.deltaFill`
   - `DELTA_LINE` → `dc.colors.deltaLine`
   - `DELTA_PANEL_BG` → `dc.colors.deltaPanel`
   - `DELTA_ACCENT` → `dc.colors.deltaAccent`
   - `'#e2e4e9'` (line 120, pill text) → `dc.colors.cursorPillText`
   - `'rgba(255,255,255,0.25)'` (line 135, hover line) → `dc.colors.hoverLine`
   - `'rgba(13,14,20,0.75)'` (line 168) → `dc.colors.cursorPill`
   - `'rgba(139,147,168,0.6)'` (line 244) → `dc.colors.text`
   - `'rgba(255,255,255,0.06)'` (line 253) → `dc.colors.separator`
   - `'#a0a8b8'` (line 270) → `dc.colors.text`

- [ ] **Step 7: Test charts in both themes**

Toggle between dark and light mode. The chart should show:
- Dark: same as before (white grid on dark background)
- Light: dark grid on white background, dark cursor lines, white pill backgrounds

- [ ] **Step 8: Commit**

```bash
git add client/src/index.css client/src/lib/chart-utils.ts client/src/lib/chart-draw.ts client/src/lib/chart-cursors.ts client/src/components/TelemetryChart.tsx
git commit -m "Make canvas chart colors theme-aware via CSS variables"
```

---

### Task 6: Theme-Aware Plotly Charts

**Files:**
- Modify: `client/src/components/analysis/HistogramTab.tsx`
- Modify: `client/src/components/analysis/XYPlotTab.tsx`

- [ ] **Step 1: Add getPlotlyThemeColors helper**

This is a small inline helper — not worth a separate file. Add it to each component, or define it once and import. Since there are only 2 consumers, add a function at the top of each file.

In `client/src/components/analysis/HistogramTab.tsx`, add before the component function:

```ts
function getPlotlyColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    gridcolor: s.getPropertyValue('--chart-grid').trim(),
    tickfontColor: s.getPropertyValue('--chart-text').trim(),
    fontColor: s.getPropertyValue('--chart-text').trim(),
  };
}
```

Then in the `render` function, call it and use the values:

```ts
const render = () => {
  const Plotly = (window as any).Plotly;
  if (!Plotly || !chartRef.current) return;

  const pc = getPlotlyColors();
  // ... existing trace code ...

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    xaxis: {
      title: `${chan.shortName}${chan.units ? ` (${chan.units})` : ''}`,
      tickfont: { size: 10, color: pc.tickfontColor, family: 'JetBrains Mono' },
      gridcolor: pc.gridcolor,
    },
    yaxis: {
      title: 'Count',
      tickfont: { size: 10, color: pc.tickfontColor, family: 'JetBrains Mono' },
      gridcolor: pc.gridcolor,
    },
    margin: { l: 45, r: 15, t: 15, b: 45 },
    bargap: 0.05,
    font: { family: 'DM Sans', color: pc.fontColor, size: 11 },
  };
  // ... rest of render ...
};
```

- [ ] **Step 2: Apply same pattern to XYPlotTab.tsx**

In `client/src/components/analysis/XYPlotTab.tsx`, add the same `getPlotlyColors()` function and replace the hardcoded colors in the layout object:

```ts
function getPlotlyColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    gridcolor: s.getPropertyValue('--chart-grid').trim(),
    tickfontColor: s.getPropertyValue('--chart-text').trim(),
    fontColor: s.getPropertyValue('--chart-text').trim(),
  };
}
```

In the `render` function, call `const pc = getPlotlyColors();` and replace:
- `color: '#8b93a8'` → `color: pc.tickfontColor` (in tickfont objects)
- `gridcolor: 'rgba(255,255,255,0.05)'` → `gridcolor: pc.gridcolor`
- `color: '#8b93a8'` → `color: pc.fontColor` (in the font object)

- [ ] **Step 3: Test Plotly charts in both themes**

Open a session, switch to the Histogram or XY Plot tab. Toggle themes. The grid lines and axis text should match the theme.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/analysis/HistogramTab.tsx client/src/components/analysis/XYPlotTab.tsx
git commit -m "Make Plotly chart colors theme-aware"
```

---

### Task 7: QuickScopeLogo Theme Support

**Files:**
- Modify: `client/src/components/QuickScopeLogo.tsx`

- [ ] **Step 1: Make the rect fill theme-aware**

In `client/src/components/QuickScopeLogo.tsx`, the `<rect>` on line 5 has `fill="hsl(230 25% 10%)"`. Replace it with a CSS variable fill:

Replace the entire SVG section:

```tsx
export function QuickScopeLogo({ size = 28, textClass = 'text-base' }: { size?: number; textClass?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-label="QuickScope">
        <rect width="40" height="40" rx="8" className="fill-card" />
        <circle cx="20" cy="20" r="11" stroke="#4361ee" strokeWidth="2.5" />
        <line x1="20" y1="5" x2="20" y2="13" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="20" y1="27" x2="20" y2="35" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="5" y1="20" x2="13" y2="20" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="27" y1="20" x2="35" y2="20" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round" />
        <polyline points="13,22 16,17 19,23 22,18 25,21 27,20" stroke="#f77f00" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle cx="20" cy="20" r="2" fill="#f77f00" />
      </svg>
      <span className={`${textClass} font-semibold text-foreground tracking-tight`}>QuickScope</span>
    </div>
  );
}
```

The key change is `fill="hsl(230 25% 10%)"` → `className="fill-card"`. In dark mode, `--card` is the dark surface; in light mode, `--card` is white which blends with the white header, effectively making the rect invisible.

- [ ] **Step 2: Test logo in both themes**

Toggle themes. In dark mode the logo should have a dark background rect. In light mode the rect should blend away, showing just the crosshair and trace on white.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/QuickScopeLogo.tsx
git commit -m "Make QuickScopeLogo rect fill theme-aware"
```

---

### Task 8: DerivedChannelDialog Hardcoded Colors

**Files:**
- Modify: `client/src/components/DerivedChannelDialog.tsx`

- [ ] **Step 1: Replace hardcoded background colors**

In `client/src/components/DerivedChannelDialog.tsx`:

1. Line 99: Replace `bg-[#080910]` with `bg-background` on the canvas preview:
```tsx
className="w-full rounded border border-border/50 bg-background"
```

2. Line 179: Replace `bg-[#0d0e14]` with `bg-card` on the dialog container:
```tsx
className="relative w-[480px] max-h-[90vh] flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
```

3. Line 287: Replace `bg-[#080910]` with `bg-background` on the expression textarea:
```tsx
className="w-full px-2.5 py-2 bg-background border border-border rounded text-xs text-foreground placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary font-mono resize-y leading-relaxed"
```

- [ ] **Step 2: Make MiniPreviewChart canvas colors theme-aware**

In the `MiniPreviewChart` component (around lines 68-83), replace the hardcoded colors:

```ts
ctx.strokeStyle = '#4361ee';
```

Leave this as-is — it's the primary brand color and works on both backgrounds.

```ts
ctx.fillStyle = '#8b93a8';
```

Replace with a CSS variable read:

```ts
const textColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-text').trim();
ctx.fillStyle = textColor;
```

- [ ] **Step 3: Test the dialog in both themes**

Open the Derived Channel dialog. It should use the correct background colors in both dark and light mode.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/DerivedChannelDialog.tsx
git commit -m "Replace hardcoded colors in DerivedChannelDialog with theme tokens"
```

---

### Task 9: Status Badge Colors

**Files:**
- Modify: `client/src/components/SessionBrowser.tsx`
- Modify: `client/src/components/AimSessionPicker.tsx`
- Modify: `client/src/components/SettingsDialog.tsx`
- Modify: `client/src/App.tsx`

Status colors use -400 in dark and -500 in light. Use the pattern `text-{color}-500 dark:text-{color}-400`.

- [ ] **Step 1: Update SessionBrowser.tsx status config**

In `client/src/components/SessionBrowser.tsx`, update the `SYNC_STATUS_CONFIG` (lines 45-51):

```ts
const SYNC_STATUS_CONFIG = {
  synced: { icon: CheckCircle, label: 'Synced', color: 'text-emerald-500 dark:text-emerald-400' },
  local_only: { icon: HardDrive, label: 'Local only', color: 'text-amber-500 dark:text-amber-400' },
  remote_only: { icon: Cloud, label: 'Remote', color: 'text-blue-500 dark:text-blue-400' },
  uploading: { icon: Loader2, label: 'Uploading...', color: 'text-amber-500 dark:text-amber-400 animate-spin' },
  downloading: { icon: Loader2, label: 'Downloading...', color: 'text-blue-500 dark:text-blue-400 animate-spin' },
} as const;
```

Also update the AiM connected indicator (around line 237):
```tsx
<div className="flex items-center gap-1.5 text-emerald-500 dark:text-emerald-400" title={...}>
```

The "Download from AiM" button (around line 293):
```tsx
className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
```

The error banner (around line 317):
```tsx
<div className="mx-4 mt-2 px-3 py-2 rounded-md text-xs bg-red-500/10 text-red-500 dark:text-red-400 border border-red-500/20">
```

The "new" badge (around line 386):
```tsx
<span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 dark:text-blue-400 flex-shrink-0">
```

The delete button hover (around line 422):
```tsx
className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 dark:hover:text-red-400 transition-all"
```

- [ ] **Step 2: Update AimSessionPicker.tsx**

In `client/src/components/AimSessionPicker.tsx`:

- Line 113: `text-emerald-400` → `text-emerald-500 dark:text-emerald-400`
- Line 159: `text-emerald-400` → `text-emerald-500 dark:text-emerald-400` (in the conditional)
- Line 170: `text-emerald-400` → `text-emerald-500 dark:text-emerald-400`
- Line 198: `text-red-400` → `text-red-500 dark:text-red-400`
- Line 203: `text-emerald-400` → `text-emerald-500 dark:text-emerald-400`

For the border conditionals (line 152):
```tsx
? 'border-emerald-500/50 bg-emerald-500/20'
```
This stays unchanged — the green border/bg works on both themes.

- [ ] **Step 3: Update SettingsDialog.tsx**

In `client/src/components/SettingsDialog.tsx`:

- Line 123: `text-red-400` → `text-red-500 dark:text-red-400`
- Line 126: `text-emerald-400` → `text-emerald-500 dark:text-emerald-400`

- [ ] **Step 4: Update App.tsx error text**

In `client/src/App.tsx`, line 356:
```tsx
<p className="text-sm font-medium text-red-500 dark:text-red-400 mb-1">Failed to load file</p>
```

And in `ChannelSidebar.tsx`, line 383:
```tsx
className="p-1 rounded text-muted-foreground/60 hover:text-red-500 dark:hover:text-red-400 transition-colors"
```

- [ ] **Step 5: Test status badges in both themes**

Open the session browser. Status badges should be slightly bolder on the white background in light mode, and the familiar -400 shade in dark mode.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SessionBrowser.tsx client/src/components/AimSessionPicker.tsx client/src/components/SettingsDialog.tsx client/src/App.tsx client/src/components/ChannelSidebar.tsx
git commit -m "Use darker status badge colors in light mode for readability"
```

---

### Task 10: GPSMapView Theme Fix

**Files:**
- Modify: `client/src/components/GPSMapView.tsx`

- [ ] **Step 1: Make marker fillColor theme-aware**

In `client/src/components/GPSMapView.tsx`, around line 141, the cursor marker has:

```ts
fillColor: '#ffffff',
```

Replace with a CSS variable read:

```ts
const fg = getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim();
const fillColor = `hsl(${fg})`;
```

Then use `fillColor` in the marker:

```ts
const marker = L.circleMarker(coords[0], {
  radius: 6,
  fillColor: fillColor,
  fillOpacity: 1,
  color: '#4361ee',
  weight: 2,
}).addTo(map);
```

Actually, on reflection: in dark mode we want a white dot, in light mode a dark dot. Using `--foreground` (which is light text in dark, dark text in light) is a good semantic match — it contrasts with the map background in both cases. But the map tile background doesn't change with our theme (it's from OpenStreetMap). So `#ffffff` is fine for a map marker on any tile. Keep it unchanged.

No changes needed for this file.

- [ ] **Step 2: Commit (skip if no changes)**

No commit needed — GPSMapView marker colors work as-is on OpenStreetMap tiles.

---

### Task 11: Final Verification

- [ ] **Step 1: Full walkthrough in dark mode**

Toggle to dark mode. Walk through:
1. Session browser — logo, status badges, AiM indicator, settings
2. Open a session — header, sidebar, chart, analysis panel
3. Histogram tab, XY Plot tab
4. Derived channel dialog
5. GPS map view

Everything should look identical to the original dark theme.

- [ ] **Step 2: Full walkthrough in light mode**

Toggle to light mode. Walk through the same screens. Verify:
1. White cards, light gray background, dark text
2. Chart grid lines are subtle on white
3. Cursor/delta overlays are visible
4. Status badges are readable
5. Logo has no dark rect background
6. Dialogs use correct backgrounds

- [ ] **Step 3: Test persistence**

1. Set to light mode, refresh the page — should stay light
2. Set to dark mode, refresh — should stay dark
3. Clear localStorage, refresh — should default to dark

- [ ] **Step 4: Commit any fixes**

If any issues are found during verification, fix and commit them.
