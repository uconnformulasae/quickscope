# Remove Downsampling — Full-Fidelity Chart Rendering

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure all telemetry charts render every data point with full accuracy, improve time axis granularity for high-frequency data (>10Hz), and optimize rendering performance for large datasets without sacrificing data fidelity.

**Architecture:** Remove the unused LTTB downsampling function. Rename the misleading `getDownsampled` viewport-clipping function to `getVisibleSamples`. Add min-max per-pixel rendering optimization that produces pixel-identical output while reducing Canvas2D draw calls for large datasets. Add adaptive time axis formatting that shows millisecond precision when zoomed in. Add data point markers when zoomed in tight enough to see individual samples.

**Tech Stack:** TypeScript, React, HTML5 Canvas2D

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `client/src/lib/xrk-parser.ts` | Modify | Remove `lttbDownsample` function |
| `client/src/components/analysis/XYPlotTab.tsx` | Modify | Remove dead `lttbDownsample` import |
| `client/src/lib/chart-utils.ts` | Modify | Rename type, add `minMaxTrace`, update `formatTimeSec` |
| `client/src/components/TelemetryChart.tsx` | Modify | Rename `getDownsampled` → `getVisibleSamples` |
| `client/src/lib/chart-draw.ts` | Modify | Integrate min-max trace, draw data point markers, pass tick step to formatTimeSec |
| `AGENT.md` | Modify | Remove LTTB references, update chart documentation |

---

### Task 1: Create branch and remove `lttbDownsample`

**Files:**
- Modify: `client/src/lib/xrk-parser.ts:55-97` (delete lttbDownsample function and its JSDoc comment)
- Modify: `client/src/components/analysis/XYPlotTab.tsx:3` (remove dead import)

- [ ] **Step 1: Create the branch**

```bash
git checkout -b remove-downsampling
```

- [ ] **Step 2: Remove `lttbDownsample` from xrk-parser.ts**

Delete lines 55-97 in `client/src/lib/xrk-parser.ts` — the JSDoc comment and the entire `lttbDownsample` function:

```typescript
// DELETE THIS ENTIRE BLOCK (lines 55-97):

/**
 * Largest-Triangle-Three-Buckets downsampling
 */
export function lttbDownsample(data: ChannelSample[], targetPoints: number): ChannelSample[] {
  // ... entire function body ...
}
```

- [ ] **Step 3: Remove dead import from XYPlotTab.tsx**

In `client/src/components/analysis/XYPlotTab.tsx`, line 3, change:

```typescript
// FROM:
import { lttbDownsample } from '../../lib/xrk-parser';

// TO: (delete this entire line)
```

- [ ] **Step 4: Verify no other references remain**

```bash
cd /Users/manthan/Documents/development/quickscope && grep -r "lttbDownsample" client/src/
```

Expected: no output (zero matches).

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/xrk-parser.ts client/src/components/analysis/XYPlotTab.tsx
git commit -m "Remove unused lttbDownsample function and dead import"
```

---

### Task 2: Rename `getDownsampled` → `getVisibleSamples`

This function only clips to the visible viewport (binary search + slice). Its name falsely implies downsampling. Rename it everywhere for clarity.

**Files:**
- Modify: `client/src/lib/chart-utils.ts:46` (DrawContext interface)
- Modify: `client/src/components/TelemetryChart.tsx:177-213,286,307` (function definition + references)
- Modify: `client/src/lib/chart-draw.ts:24,111` (call sites)

- [ ] **Step 1: Rename in DrawContext interface**

In `client/src/lib/chart-utils.ts`, line 46, change:

```typescript
// FROM:
getDownsampled: (channelId: number, allSamples: ChannelSample[], xRange: [number, number], canvasWidth: number) => ChannelSample[];

// TO:
getVisibleSamples: (channelId: number, allSamples: ChannelSample[], xRange: [number, number], canvasWidth: number) => ChannelSample[];
```

- [ ] **Step 2: Rename function definition in TelemetryChart.tsx**

In `client/src/components/TelemetryChart.tsx`, line 177, change the comment and function name:

```typescript
// FROM:
// ─── Downsampling helper ───────────────────────────────────────────────
const getDownsampled = useCallback((

// TO:
// ─── Visible-range filter ────────────────────────────────────────────
const getVisibleSamples = useCallback((
```

- [ ] **Step 3: Update DrawContext construction in TelemetryChart.tsx**

In `client/src/components/TelemetryChart.tsx`, line 286, change:

```typescript
// FROM:
timeToX, getDownsampled, overlayAxisLayout, session,

// TO:
timeToX, getVisibleSamples, overlayAxisLayout, session,
```

- [ ] **Step 4: Update useCallback dependency array in TelemetryChart.tsx**

In `client/src/components/TelemetryChart.tsx`, line 307, change:

```typescript
// FROM:
}, [session, sessionDuration, channelDataMap, visibleChannels, computeStripLayouts, timeToX, getDownsampled, leftMargin, rightMargin, chartMode, overlayAxisLayout]);

// TO:
}, [session, sessionDuration, channelDataMap, visibleChannels, computeStripLayouts, timeToX, getVisibleSamples, leftMargin, rightMargin, chartMode, overlayAxisLayout]);
```

- [ ] **Step 5: Update call sites in chart-draw.ts**

In `client/src/lib/chart-draw.ts`, line 24, change:

```typescript
// FROM:
? dc.getDownsampled(strip.channelId, data.allSamples, dc.xRange, dc.plotW)

// TO:
? dc.getVisibleSamples(strip.channelId, data.allSamples, dc.xRange, dc.plotW)
```

In `client/src/lib/chart-draw.ts`, line 111, change:

```typescript
// FROM:
? dc.getDownsampled(strip.channelId, allSamples, xRange, plotW)

// TO:
? dc.getVisibleSamples(strip.channelId, allSamples, xRange, plotW)
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/chart-utils.ts client/src/components/TelemetryChart.tsx client/src/lib/chart-draw.ts
git commit -m "Rename getDownsampled to getVisibleSamples for clarity

The function only clips data to the visible viewport range via binary
search. The old name falsely implied data reduction was occurring."
```

---

### Task 3: Adaptive time axis formatting

`formatTimeSec` currently uses `toFixed(1)` everywhere, capping precision at 0.1s. For data logged at >10Hz (e.g., 50Hz = 20ms intervals), this makes it impossible to read precise timestamps when zoomed in. The formatter should adapt precision based on the tick step size.

**Files:**
- Modify: `client/src/lib/chart-utils.ts:187-195` (formatTimeSec function)
- Modify: `client/src/lib/chart-draw.ts:362-396` (drawXAxis — pass tick step to formatter)

- [ ] **Step 1: Update `formatTimeSec` to accept tick step and adapt precision**

In `client/src/lib/chart-utils.ts`, replace the `formatTimeSec` function (lines 187-195) with:

```typescript
/** Format time in seconds for the x-axis.
 *  Precision adapts to tick spacing so zoomed-in views show milliseconds. */
export function formatTimeSec(sec: number, tickStep?: number): string {
  // Determine decimal places from tick spacing
  let decimals = 1;
  if (tickStep !== undefined) {
    if (tickStep < 0.1) decimals = 3;
    else if (tickStep < 1) decimals = 2;
  }

  const mins = Math.floor(sec / 60);
  const secs = sec % 60;
  if (mins > 0) {
    return `${mins}:${secs.toFixed(decimals).padStart(decimals + 3, '0')}`;
  }
  return secs.toFixed(decimals) + 's';
}
```

Precision mapping:
| Tick step | Decimals | Example | Use case |
|-----------|----------|---------|----------|
| >= 1s | 1 | `12.4s` | Normal zoom |
| 0.1s–1s | 2 | `12.42s` | Moderate zoom on >10Hz data |
| < 0.1s | 3 | `12.423s` | Deep zoom, millisecond-level |

- [ ] **Step 2: Pass tick step from `drawXAxis` in chart-draw.ts**

In `client/src/lib/chart-draw.ts`, in the `drawXAxis` function, compute the tick step and pass it to `formatTimeSec`. Find the line (around line 386):

```typescript
// FROM:
ctx.fillText(formatTimeSec(xt), x, axisY + 18);

// TO:
const tickStep = xTicks.length >= 2 ? xTicks[1] - xTicks[0] : undefined;
```

Move the `tickStep` calculation **before** the for-loop (around line 378, before `for (const xt of xTicks)`), then update the fillText call:

```typescript
ctx.fillText(formatTimeSec(xt, tickStep), x, axisY + 18);
```

The full modified section of `drawXAxis` should look like:

```typescript
ctx.font = `10px ${MONO_FONT}`;
ctx.fillStyle = dc.colors.text;
ctx.textAlign = 'center';
const tickStep = xTicks.length >= 2 ? xTicks[1] - xTicks[0] : undefined;
for (const xt of xTicks) {
  const x = dc.timeToX(xt, xRange, plotW);
  if (x >= lm && x <= w - rm) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, axisY);
    ctx.lineTo(Math.round(x) + 0.5, axisY + 5);
    ctx.stroke();
    ctx.fillText(formatTimeSec(xt, tickStep), x, axisY + 18);
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/chart-utils.ts client/src/lib/chart-draw.ts
git commit -m "Add adaptive time axis precision based on zoom level

formatTimeSec now accepts an optional tickStep parameter. When zoomed
into sub-second ranges, the axis shows 2-3 decimal places instead of
always 1, making individual high-frequency data points readable."
```

---

### Task 4: Min-max per-pixel rendering optimization

When zoomed out, hundreds of data points can map to the same pixel column. Currently all get `lineTo` calls — redundant work. Min-max per-pixel keeps only the first, min, max, and last sample per pixel column (in temporal order). This produces **pixel-identical** visual output while reducing draw calls from N to at most 4 * pixelWidth.

This is NOT downsampling — every visual extreme is preserved. Points "removed" are invisible at the current zoom level because they overlap with other points at the same pixel.

**Files:**
- Modify: `client/src/lib/chart-utils.ts` (add `minMaxTrace` function)
- Modify: `client/src/lib/chart-draw.ts:97-189` (apply min-max trace before drawing)

- [ ] **Step 1: Add `minMaxTrace` to chart-utils.ts**

Add the following function at the end of `client/src/lib/chart-utils.ts` (after the existing `formatTimeSec` function):

```typescript
/**
 * Min-max per-pixel trace for rendering optimization.
 * For each pixel column, keeps the first, min, max, and last samples
 * in temporal order. Produces pixel-identical output to drawing all
 * points, while reducing Canvas2D draw calls for dense data.
 *
 * Returns the original array unchanged when point density is already
 * low enough (fewer than 4 points per pixel on average).
 */
export function minMaxTrace(
  samples: ChannelSample[],
  timeToX: (tSec: number) => number,
  plotW: number,
): ChannelSample[] {
  const n = samples.length;
  if (n <= plotW * 4) return samples;

  const trace: ChannelSample[] = [];
  let i = 0;

  while (i < n) {
    const px = Math.round(timeToX(samples[i].timestamp / 1000));
    let minIdx = i, maxIdx = i;
    let j = i + 1;

    while (j < n && Math.round(timeToX(samples[j].timestamp / 1000)) === px) {
      if (samples[j].value < samples[minIdx].value) minIdx = j;
      if (samples[j].value > samples[maxIdx].value) maxIdx = j;
      j++;
    }

    const lastIdx = j - 1;

    // Emit first sample (entry point for this pixel)
    trace.push(samples[i]);

    // Emit min and max in temporal order (skip if same as first or last)
    const lo = Math.min(minIdx, maxIdx);
    const hi = Math.max(minIdx, maxIdx);
    if (lo > i && lo < lastIdx) trace.push(samples[lo]);
    if (hi > i && hi < lastIdx && hi !== lo) trace.push(samples[hi]);

    // Emit last sample (exit point, skip if same as first)
    if (lastIdx > i) trace.push(samples[lastIdx]);

    i = j;
  }

  return trace;
}
```

- [ ] **Step 2: Import `minMaxTrace` in chart-draw.ts**

In `client/src/lib/chart-draw.ts`, line 8, update the import to include `minMaxTrace`:

```typescript
// FROM:
import {
  MONO_FONT, AXIS_WIDTH,
  BOTTOM_AXIS_HEIGHT,
  niceAxisTicks, formatValue, formatTimeSec, clamp, brightenColor,
} from './chart-utils';

// TO:
import {
  MONO_FONT, AXIS_WIDTH,
  BOTTOM_AXIS_HEIGHT,
  niceAxisTicks, formatValue, formatTimeSec, clamp, brightenColor, minMaxTrace,
} from './chart-utils';
```

- [ ] **Step 3: Apply min-max trace in `drawStrips`**

In `client/src/lib/chart-draw.ts`, in the `drawStrips` function, after getting visible samples and computing Y-range, apply `minMaxTrace` before the line trace drawing.

Find in `drawStrips` (around lines 110-112):

```typescript
const ds = allSamples.length > 0
  ? dc.getVisibleSamples(strip.channelId, allSamples, xRange, plotW)
  : [];
```

Replace with:

```typescript
const visible = allSamples.length > 0
  ? dc.getVisibleSamples(strip.channelId, allSamples, xRange, plotW)
  : [];
```

Then find the Y-range computation (line ~114):

```typescript
const [yMin, yMax] = computeStripYRange(dc, strip, ds, def.units || '');
```

Change to use `visible` (full data for accurate Y-range):

```typescript
const [yMin, yMax] = computeStripYRange(dc, strip, visible, def.units || '');
```

Then add the min-max trace computation right after Y-range:

```typescript
// Min-max per-pixel optimization for rendering (pixel-identical output)
const ds = minMaxTrace(visible, (tSec) => dc.timeToX(tSec, xRange, plotW), plotW);
```

The resulting block should read:

```typescript
const visible = allSamples.length > 0
  ? dc.getVisibleSamples(strip.channelId, allSamples, xRange, plotW)
  : [];

const [yMin, yMax] = computeStripYRange(dc, strip, visible, def.units || '');
// Min-max per-pixel optimization for rendering (pixel-identical output)
const ds = minMaxTrace(visible, (tSec) => dc.timeToX(tSec, xRange, plotW), plotW);
```

Do the **same** change in `computeOverlayYRanges` (around line 23-25). Change:

```typescript
const ds = data.allSamples.length > 0
  ? dc.getVisibleSamples(strip.channelId, data.allSamples, dc.xRange, dc.plotW)
  : [];
```

To:

```typescript
const visible = data.allSamples.length > 0
  ? dc.getVisibleSamples(strip.channelId, data.allSamples, dc.xRange, dc.plotW)
  : [];
const ds = visible;
```

Note: `computeOverlayYRanges` only computes Y-ranges, it doesn't draw — so no min-max optimization needed here. Just rename the variable for consistency, keeping the same data.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/chart-utils.ts client/src/lib/chart-draw.ts
git commit -m "Add min-max per-pixel rendering for large datasets

For each pixel column, keeps first/min/max/last samples in temporal
order. Produces pixel-identical output while reducing Canvas2D draw
calls from N to at most 4*pixelWidth. Activates only when point
density exceeds 4 samples per pixel."
```

---

### Task 5: Data point markers when zoomed in

When zoomed in tight enough that individual samples are clearly separated (>8px apart), draw small filled circles at each data point. This makes individual samples visible and distinguishable from the connecting line.

**Files:**
- Modify: `client/src/lib/chart-draw.ts:175-189` (add marker drawing after line trace)

- [ ] **Step 1: Add point markers after line trace in `drawStrips`**

In `client/src/lib/chart-draw.ts`, in the `drawStrips` function, after the line trace block (after `ctx.stroke();` on line ~188), add the point marker code. Find:

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

Add immediately after this block (before the `// Min/Max markers` comment):

```typescript
    // Data point markers — visible when zoomed in tight (>8px between points)
    if (visible.length > 1 && visible.length <= plotW / 8) {
      ctx.fillStyle = strip.color;
      for (const s of visible) {
        const x = dc.timeToX(s.timestamp / 1000, xRange, plotW);
        const y = valToY(s.value);
        if (x >= lm && x <= w - rm) {
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
```

Note: This uses `visible` (the full unoptimized samples), not `ds` (the min-max trace), so every real data point gets a marker. The condition `visible.length <= plotW / 8` means markers only appear when there's enough visual space to see them individually.

**Important:** The `visible` variable must be accessible in the scope where markers are drawn. Since Task 4 changed the variable from `ds` (which held visible samples) to `visible` (full samples) + `ds` (min-max trace), `visible` is already available in scope.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/chart-draw.ts
git commit -m "Draw data point markers when zoomed in tight

Small filled circles appear at each sample when points are spaced
more than 8px apart, making individual data points distinguishable
from the connecting line."
```

---

### Task 6: Update AGENT.md

Remove references to LTTB downsampling and update the chart engine documentation to reflect the new rendering approach.

**Files:**
- Modify: `AGENT.md:74,85` (remove LTTB references)

- [ ] **Step 1: Update line 74 in AGENT.md**

```markdown
-- **Downsampling**: LTTB algorithm via `lttbDownsample()`, cached per channel+range
+- **Rendering**: Min-max per-pixel optimization for large datasets; no data reduction — every visible data point is rendered accurately
```

- [ ] **Step 2: Update line 85 in AGENT.md**

```markdown
-- Downsample cache avoids re-running LTTB on every frame
+- Min-max trace reduces draw calls for dense data without dropping visible information
```

- [ ] **Step 3: Commit**

```bash
git add AGENT.md
git commit -m "Update AGENT.md to reflect removal of LTTB downsampling"
```

---

### Task 7: Visual verification

Start the dev server and verify all changes work correctly across zoom levels.

- [ ] **Step 1: Start the dev server**

```bash
cd /Users/manthan/Documents/development/quickscope && ./start.sh
```

- [ ] **Step 2: Load an XRK file and verify the following**

1. **Zoomed out (full session):** Chart renders all channels. Line traces look identical to before (min-max optimization is visually lossless). No visual artifacts at pixel boundaries.

2. **Moderate zoom:** Time axis ticks show 2 decimal places when tick spacing is sub-second (e.g., `12.42s`).

3. **Deep zoom (sub-100ms ticks):** Time axis shows 3 decimal places (e.g., `12.423s`). Individual data points are visible as small circles. Each circle corresponds to a real sample from the file.

4. **Performance:** Zoomed-out rendering with many channels should feel smooth. No lag or stuttering during zoom/pan.

5. **Derived channels:** Still render identically to before (no behavior change).

6. **Analysis panels:** XY Plot and Histogram still work (no import errors from removed `lttbDownsample`).

7. **Cursor snapping:** Hover cursor still snaps to nearest sample and shows correct values.
