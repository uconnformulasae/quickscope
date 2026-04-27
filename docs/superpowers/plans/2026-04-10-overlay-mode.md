# Overlay Mode Implementation Plan

> **STATUS — SHIPPED.** This feature was implemented and is live on `main`. The
> chart-mode toggle (`ChartMode = 'separate' | 'overlay'`) is in
> `client/src/lib/useXRKStore.ts`, the segmented control is in
> `client/src/components/ChannelSidebar.tsx`, and the dynamic-margin / shared-
> strip / alternating-Y-axis rendering lives in
> `client/src/components/TelemetryChart.tsx` (search for `chartMode`,
> `overlayAxisLayout`).
>
> The implementation diverged from this plan in one notable way: instead of
> assigning each channel its own Y-axis on alternating sides, axes are grouped
> by **unit** (`overlayAxisLayout` → `unitAxes` map keyed by units string), so
> two channels in `°C` share one axis. The checkbox tasks below are kept as
> historical reference — do not re-execute them.

**Goal (original):** Add an overlay display mode that draws all selected channels on a single shared graph with independent color-coded Y-axes alternating left/right, toggled via a segmented control in the channel sidebar.

**Architecture:** A new `chartMode` state field controls whether `TelemetryChart` computes one strip (overlay) or N strips (separate). In overlay mode, the draw loop renders all channel traces in a single vertical area with dynamically expanded margins to accommodate alternating Y-axes. Cursor, delta, zoom, and pan behavior are unchanged.

**Tech Stack:** React 18, TypeScript, Canvas 2D API, existing useAppState hook

---

### Task 1: Add `chartMode` to State Store

**Files:**
- Modify: `client/src/lib/useXRKStore.ts`

- [ ] **Step 1: Add type and state field**

In `client/src/lib/useXRKStore.ts`, add the `ChartMode` type export after the `AnalysisTab` type (line 20), and add `chartMode` to the `AppState` interface:

```typescript
export type ChartMode = 'separate' | 'overlay';
```

Add to `AppState` interface after the `cursorTime` field (line 55):

```typescript
  // Chart display mode
  chartMode: ChartMode;
```

- [ ] **Step 2: Set default and add action**

In the `useState` initializer (around line 116), add:

```typescript
    chartMode: 'separate',
```

Add a `setChartMode` callback after `setShowOnlyWithData` (around line 216):

```typescript
  const setChartMode = useCallback((mode: ChartMode) => {
    setState(prev => ({ ...prev, chartMode: mode }));
  }, []);
```

- [ ] **Step 3: Expose in return object**

Add `setChartMode` to the return object (around line 353):

```typescript
    setChartMode,
```

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/useXRKStore.ts
git commit -m "feat: add chartMode state to store (separate/overlay)"
```

---

### Task 2: Add Segmented Toggle to ChannelSidebar

**Files:**
- Modify: `client/src/components/ChannelSidebar.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Add props to ChannelSidebar**

In `client/src/components/ChannelSidebar.tsx`, import `ChartMode`:

```typescript
import type { ActiveChannel, DerivedChannel, ChartMode } from '../lib/useXRKStore';
```

Add to `ChannelSidebarProps` interface:

```typescript
  chartMode: ChartMode;
  onChartModeChange: (mode: ChartMode) => void;
```

Add to the destructured props:

```typescript
  chartMode,
  onChartModeChange,
```

- [ ] **Step 2: Add the segmented control UI**

In the sidebar JSX, insert the toggle between the header `<div>` and the search `<div>`. Find the closing `</div>` of the header row (after the "Create derived channel" button, around line 101) and add this before the `{/* Search */}` comment:

```tsx
        {/* Chart mode toggle */}
        <div className="flex gap-1 mb-2">
          <button
            onClick={() => onChartModeChange('separate')}
            className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              chartMode === 'separate'
                ? 'bg-primary/20 text-primary border border-primary/40'
                : 'text-muted-foreground border border-border hover:text-foreground hover:border-muted-foreground/40'
            }`}
          >
            Separate
          </button>
          <button
            onClick={() => onChartModeChange('overlay')}
            className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              chartMode === 'overlay'
                ? 'bg-primary/20 text-primary border border-primary/40'
                : 'text-muted-foreground border border-border hover:text-foreground hover:border-muted-foreground/40'
            }`}
          >
            Overlay
          </button>
        </div>
```

- [ ] **Step 3: Wire props through App.tsx**

In `client/src/App.tsx`, add `setChartMode` to the destructured return from `useAppState()`:

```typescript
    setChartMode,
```

Pass the new props to `<ChannelSidebar>`:

```tsx
                chartMode={state.chartMode}
                onChartModeChange={setChartMode}
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ChannelSidebar.tsx client/src/App.tsx
git commit -m "feat: add separate/overlay toggle to channel sidebar"
```

---

### Task 3: Pass `chartMode` to TelemetryChart and Adjust Layout Computation

**Files:**
- Modify: `client/src/components/TelemetryChart.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Add `chartMode` prop to TelemetryChart**

In `client/src/components/TelemetryChart.tsx`, import `ChartMode`:

```typescript
import type { ActiveChannel, TimeRange, DerivedChannel, ChartMode } from '../lib/useXRKStore';
```

Add to `TelemetryChartProps` interface:

```typescript
  chartMode?: ChartMode;
```

Add to the destructured props:

```typescript
  chartMode = 'separate',
```

- [ ] **Step 2: Compute dynamic margins for overlay mode**

Add these constants after the existing constants (after line 49):

```typescript
const AXIS_WIDTH = 50; // width per Y-axis in overlay mode
```

Add a `useMemo` after the `channelDataMap` memo (around line 216) to compute margins:

```typescript
  // Dynamic margins for overlay mode (multiple Y-axes)
  const { leftMargin, rightMargin } = useMemo(() => {
    if (chartMode !== 'overlay' || visibleChannels.length <= 1) {
      return { leftMargin: LEFT_MARGIN, rightMargin: RIGHT_MARGIN };
    }
    const leftCount = Math.ceil(visibleChannels.length / 2);
    const rightCount = Math.floor(visibleChannels.length / 2);
    return {
      leftMargin: Math.max(LEFT_MARGIN, leftCount * AXIS_WIDTH),
      rightMargin: Math.max(RIGHT_MARGIN, rightCount * AXIS_WIDTH),
    };
  }, [chartMode, visibleChannels.length]);
```

- [ ] **Step 3: Modify `computeStripLayouts` for overlay mode**

Replace the existing `computeStripLayouts` callback (lines 324-342) with:

```typescript
  const computeStripLayouts = useCallback((canvasH: number): StripLayout[] => {
    const plotH = canvasH - BOTTOM_AXIS_HEIGHT;
    const numCh = visibleChannels.length;
    if (numCh === 0) return [];

    if (chartMode === 'overlay') {
      // All channels share one strip
      return visibleChannels.map((ac, i) => {
        const data = channelDataMap.get(ac.channelId);
        const label = data?.def.shortName || `Ch${ac.channelId}`;
        const units = data?.def.units || '';
        return {
          top: 0,
          height: plotH,
          channelId: ac.channelId,
          color: ac.color,
          label: label + (units ? ` (${units})` : ''),
          units,
        };
      });
    }

    // Separate mode (existing)
    const stripH = Math.max(MIN_STRIP_HEIGHT, plotH / numCh);
    return visibleChannels.map((ac, i) => {
      const data = channelDataMap.get(ac.channelId);
      const label = data?.def.shortName || `Ch${ac.channelId}`;
      const units = data?.def.units || '';
      return {
        top: i * stripH,
        height: stripH,
        channelId: ac.channelId,
        color: ac.color,
        label: label + (units ? ` (${units})` : ''),
        units,
      };
    });
  }, [visibleChannels, channelDataMap, chartMode]);
```

- [ ] **Step 4: Pass chartMode from App.tsx**

In `client/src/App.tsx`, add the prop to `<TelemetryChart>`:

```tsx
              chartMode={state.chartMode}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TelemetryChart.tsx client/src/App.tsx
git commit -m "feat: compute overlay strip layout and dynamic margins"
```

---

### Task 4: Update Draw Function for Overlay Mode

**Files:**
- Modify: `client/src/components/TelemetryChart.tsx`

This is the core change. The draw function needs to:
1. Use dynamic margins instead of constants
2. In overlay mode, skip duplicate grid/lap drawing (only draw once for the shared strip)
3. Draw Y-axes alternating left/right with color coding
4. Skip the rotated channel name label and strip separator in overlay mode

- [ ] **Step 1: Replace hardcoded margins with dynamic values in `draw()`**

In the `draw` function, replace the `plotW` calculation (line 366) and all references to `LEFT_MARGIN` and `RIGHT_MARGIN` within `draw()` with the dynamic values. The simplest approach is to add local variables at the top of draw:

After `if (w === 0 || h === 0) return;` (line 363), add:

```typescript
    const lm = leftMargin;
    const rm = rightMargin;
```

Then replace `LEFT_MARGIN` with `lm` and `RIGHT_MARGIN` with `rm` throughout the draw function. The line `const plotW = w - LEFT_MARGIN - RIGHT_MARGIN;` becomes:

```typescript
    const plotW = w - lm - rm;
```

Also update `timeToX` and `xToTime` to accept margin as parameter, OR simpler: make them use the dynamic margin. Since they're used both inside and outside draw, the cleanest approach is to update them:

Replace the `timeToX` callback:

```typescript
  const timeToX = useCallback((t: number, xRange: [number, number], plotW: number): number => {
    return leftMargin + ((t - xRange[0]) / (xRange[1] - xRange[0])) * plotW;
  }, [leftMargin]);
```

Replace the `xToTime` callback:

```typescript
  const xToTime = useCallback((px: number, xRange: [number, number], plotW: number): number => {
    return xRange[0] + ((px - leftMargin) / plotW) * (xRange[1] - xRange[0]);
  }, [leftMargin]);
```

Update all `LEFT_MARGIN` references inside `draw()` to `lm`, and all `RIGHT_MARGIN` to `rm`.

Update all `LEFT_MARGIN` references in mouse/touch event handlers to `leftMargin` (these are: `handleWheel` plotW calc, `handleMouseMove` plotW calc, `handleMouseUp` plotW calc, `handleTouchMove` plotW calc, `handleTouchEnd` plotW calc).

- [ ] **Step 2: Track which strips have been drawn (for overlay dedup)**

At the start of the strip loop in `draw()`, add a Set to track whether we've already drawn grid/laps for the shared overlay area:

After `const xTicks = ...` and before `for (const strip of strips) {`, add:

```typescript
    const overlayGridDrawn = chartMode === 'overlay';
    let gridDrawnForOverlay = false;
```

- [ ] **Step 3: Deduplicate grid drawing in overlay mode**

Wrap the grid and lap marker drawing inside the strip loop so they only execute once in overlay mode. At the start of the strip loop body, add:

```typescript
      const skipGrid = chartMode === 'overlay' && gridDrawnForOverlay;
```

Wrap the horizontal grid, vertical grid, and lap marker sections in `if (!skipGrid) { ... }`. After the lap labels section, add:

```typescript
      if (chartMode === 'overlay') gridDrawnForOverlay = true;
```

- [ ] **Step 4: Draw alternating Y-axes in overlay mode**

Replace the Y-axis tick drawing section (lines 532-541) with mode-aware logic:

```typescript
      // ── Y-axis ticks and labels ──
      if (chartMode === 'overlay') {
        const chIndex = visibleChannels.findIndex(vc => vc.channelId === strip.channelId);
        const isLeft = chIndex % 2 === 0;
        const sideIndex = Math.floor(chIndex / 2);
        const axisX = isLeft
          ? lm - 5 - sideIndex * AXIS_WIDTH
          : w - rm + 5 + sideIndex * AXIS_WIDTH;

        ctx.font = `10px ${MONO_FONT}`;
        ctx.fillStyle = strip.color;
        ctx.textAlign = isLeft ? 'right' : 'left';
        for (const yt of yTicks) {
          const y = valToY(yt);
          if (y >= strip.top + 5 && y <= strip.top + strip.height - 5) {
            ctx.fillText(formatValue(yt), axisX, y + 3);
          }
        }

        // Axis line
        const lineX = isLeft
          ? lm - sideIndex * AXIS_WIDTH - (sideIndex > 0 ? 0 : 0)
          : w - rm + sideIndex * AXIS_WIDTH;
        ctx.strokeStyle = strip.color + '40';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(lineX) + 0.5, strip.top);
        ctx.lineTo(Math.round(lineX) + 0.5, strip.top + strip.height);
        ctx.stroke();

        // Channel name label along the axis
        ctx.font = `bold 9px ${MONO_FONT}`;
        ctx.fillStyle = strip.color;
        ctx.textAlign = isLeft ? 'right' : 'left';
        ctx.fillText(strip.label, axisX, strip.top + 12);
      } else {
        // Separate mode (existing)
        ctx.font = `10px ${MONO_FONT}`;
        ctx.fillStyle = strip.color;
        ctx.textAlign = 'right';
        for (const yt of yTicks) {
          const y = valToY(yt);
          if (y >= strip.top + 5 && y <= strip.top + strip.height - 5) {
            ctx.fillText(formatValue(yt), lm - 5, y + 3);
          }
        }
      }
```

- [ ] **Step 5: Skip rotated channel name and separator in overlay mode**

Wrap the channel name rotation section (lines 543-555) in a condition:

```typescript
      if (chartMode !== 'overlay') {
        // ── Channel name (rotated on left margin) ──
        ctx.save();
        ctx.font = `bold 10px ${MONO_FONT}`;
        ctx.fillStyle = strip.color;
        ctx.textAlign = 'center';
        ctx.translate(12, strip.top + strip.height / 2);
        ctx.rotate(-Math.PI / 2);
        const maxChars = Math.floor(strip.height / 6);
        let nameText = strip.label;
        if (nameText.length > maxChars) nameText = nameText.slice(0, maxChars - 1) + '…';
        ctx.fillText(nameText, 0, 0);
        ctx.restore();
      }
```

Wrap the strip separator section (lines 557-564) in a condition:

```typescript
      if (chartMode !== 'overlay') {
        ctx.strokeStyle = SEPARATOR_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const sepY = Math.round(strip.top + strip.height) + 0.5;
        ctx.moveTo(0, sepY);
        ctx.lineTo(w, sepY);
        ctx.stroke();
      }
```

- [ ] **Step 6: Add `leftMargin`, `rightMargin`, and `chartMode` to draw's dependency array**

Update the dependency array of the `draw` useCallback (line 842):

```typescript
  }, [session, sessionDuration, channelDataMap, visibleChannels, computeStripLayouts, timeToX, getDownsampled, leftMargin, rightMargin, chartMode]);
```

- [ ] **Step 7: Commit**

```bash
git add client/src/components/TelemetryChart.tsx
git commit -m "feat: overlay mode draw — shared grid, alternating Y-axes, trace overlay"
```

---

### Task 5: Update Cursor Value Pills for Overlay Mode

**Files:**
- Modify: `client/src/components/TelemetryChart.tsx`

In overlay mode, all cursor value pills stack on the right edge of a single strip. They need to be spaced vertically so they don't overlap.

- [ ] **Step 1: Stack value pills with offset in overlay mode**

In the cursor A value readout section (around lines 649-695), the pills are positioned at `dotY` (the Y position on the trace). In overlay mode, multiple pills may overlap since traces share the same vertical space. Add a counter and offset:

Before the cursor A value readout loop (`for (const strip of strips) {`), add:

```typescript
      let pillIndex = 0;
```

Inside the loop, replace the pill Y positioning. Change:

```typescript
        const pillY = Math.round(clamp(dotY - pillH / 2, strip.top + 2, strip.top + strip.height - pillH - 2));
```

To:

```typescript
        const pillY = chartMode === 'overlay'
          ? Math.round(strip.top + 4 + pillIndex * (pillH + 2))
          : Math.round(clamp(dotY - pillH / 2, strip.top + 2, strip.top + strip.height - pillH - 2));
```

After the pill drawing, increment:

```typescript
        pillIndex++;
```

- [ ] **Step 2: Same adjustment for hover readout pills**

Apply the same pill stacking logic in the hover readout section (around lines 714-761). Add `let hoverPillIndex = 0;` before the loop and use it similarly for the hover pill Y positioning.

- [ ] **Step 3: Update delta panel to use `visibleChannels` instead of `strips`**

The delta panel already iterates over `strips` which in overlay mode all share the same coordinates. It computes values per-channel correctly since it reads from `channelDataMap` using `strip.channelId`. No change needed here — the panel already works because each strip entry has a unique `channelId`.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/TelemetryChart.tsx
git commit -m "feat: stack cursor value pills vertically in overlay mode"
```

---

### Task 6: Update Mouse Event Handlers for Dynamic Margins

**Files:**
- Modify: `client/src/components/TelemetryChart.tsx`

- [ ] **Step 1: Update plotW calculations in event handlers**

In all mouse/touch event handlers, replace `LEFT_MARGIN` with `leftMargin` and `RIGHT_MARGIN` with `rightMargin` in plotW calculations:

In `handleWheel`:
```typescript
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
```

In `handleMouseMove`:
```typescript
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
```

In `handleMouseUp`:
```typescript
        const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
```

In `handleTouchMove`:
```typescript
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
```

In `handleTouchEnd`:
```typescript
          const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
```

- [ ] **Step 2: Update dependency arrays**

Add `leftMargin` and `rightMargin` to the dependency arrays of:
- `handleWheel`
- `handleMouseMove`
- `handleMouseUp`
- `handleTouchMove`
- `handleTouchEnd`

- [ ] **Step 3: Commit**

```bash
git add client/src/components/TelemetryChart.tsx
git commit -m "feat: use dynamic margins in all event handlers"
```

---

### Task 7: Verify and Test

- [ ] **Step 1: Start the dev server and verify**

```bash
npm run dev
```

Open `http://localhost:5173`, load an XRK file, select some channels.

- [ ] **Step 2: Test separate mode (regression)**

Verify the following work in separate mode (default):
- Channels display as stacked strips
- Zoom/pan works
- Cursor shows value pills
- Delta mode works
- Double-click resets zoom

- [ ] **Step 3: Test overlay mode**

Switch to overlay mode using the sidebar toggle:
- All channels render on one shared graph
- Y-axes alternate left/right, color-coded
- Cursor line spans full height with value pills for all channels
- Zoom/pan works
- Delta mode works with both cursors

- [ ] **Step 4: Test mode switching**

- Switch from separate to overlay: verify zoom range and cursors are preserved
- Switch from overlay to separate: verify zoom range and cursors are preserved
- Switch with delta mode active: verify both cursors preserved

- [ ] **Step 5: Test edge cases**

- Single channel in overlay mode (should look like a full-height single strip)
- Many channels (5+) in overlay mode — verify axes don't overflow
- No channels selected — empty state should still show

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: address overlay mode issues found during testing"
```
