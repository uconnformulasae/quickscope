/**
 * Chart drawing functions — grid, traces, axes, labels, legend, x-axis.
 * Separated from TelemetryChart.tsx for readability.
 */
import type { ChannelSample } from './xrk-parser';
import type { DrawContext, StripLayout } from './chart-utils';
import {
  MONO_FONT, AXIS_WIDTH, scaledFont,
  BOTTOM_AXIS_HEIGHT,
  niceAxisTicks, formatValue, clamp, minMaxTrace,
  visibleMinMax, contrastText, layoutLegendRows, thinLabels, chooseLabelBox,
  type LabelRect, type TracePoints,
} from './chart-utils';
import { formatChartAxisTime } from './time-format';
import { convertibleUnits } from './units';
import { lapColor } from './lap-compare';
import { formatLapTime } from './xrk-parser';

const LERP_RATE = 0.18;

/** Visible samples feeding a y-range: every compared lap in compare mode. */
function visibleForRange(dc: DrawContext, channelId: number, allSamples: ChannelSample[]): ChannelSample[] {
  const series = dc.compare?.series.get(channelId);
  if (!series) {
    return allSamples.length > 0 ? dc.getVisibleSamples(channelId, allSamples, dc.xRange, dc.plotW) : [];
  }
  return series.flatMap(s => (s.length > 0 ? dc.getVisibleSamples(channelId, s, dc.xRange, dc.plotW) : []));
}

/** Stroke one trace (already min-max reduced). */
function strokeTrace(dc: DrawContext, ds: ChannelSample[], valToY: (v: number) => number) {
  if (ds.length < 2) return;
  const { ctx, xRange, plotW } = dc;
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

/** Compute smoothed Y-range for overlay mode shared axes */
export function computeOverlayYRanges(dc: DrawContext): void {
  if (dc.chartMode !== 'overlay') return;
  const unitMinMax = new Map<string, { min: number; max: number }>();
  for (const strip of dc.strips) {
    const data = dc.channelDataMap.get(strip.channelId);
    if (!data) continue;
    const units = data.def.units || '';
    const visible = visibleForRange(dc, strip.channelId, data.allSamples);
    let mn = Infinity, mx = -Infinity;
    for (const s of visible) {
      if (s.value < mn) mn = s.value;
      if (s.value > mx) mx = s.value;
    }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    const existing = unitMinMax.get(units);
    if (existing) {
      existing.min = Math.min(existing.min, mn);
      existing.max = Math.max(existing.max, mx);
    } else {
      unitMinMax.set(units, { min: mn, max: mx });
    }
  }
  for (const [units, { min, max }] of unitMinMax) {
    const pad = (max - min) * 0.08 || 0.5;
    const targetMin = min - pad;
    const targetMax = max + pad;
    const key = `overlay:${units}`;
    const prev = dc.smoothedYRanges.get(key);
    let sMin: number, sMax: number;
    if (prev) {
      sMin = prev[0] + (targetMin - prev[0]) * LERP_RATE;
      sMax = prev[1] + (targetMax - prev[1]) * LERP_RATE;
    } else {
      sMin = targetMin;
      sMax = targetMax;
    }
    dc.smoothedYRanges.set(key, [sMin, sMax]);
    dc.sharedYRanges.set(units, [sMin, sMax]);
    const span = Math.abs(targetMax - targetMin) || 1;
    if (Math.abs(sMin - targetMin) / span > 0.001 || Math.abs(sMax - targetMax) / span > 0.001) {
      dc.needsDrawRef.current = true;
    }
  }
}

/** Compute Y-range for a single strip (separate mode), with lerp smoothing */
function computeStripYRange(
  dc: DrawContext, strip: StripLayout, ds: ChannelSample[], defUnits: string,
): [number, number] {
  const sharedRange = dc.chartMode === 'overlay' ? dc.sharedYRanges.get(defUnits) : undefined;
  if (sharedRange) return sharedRange;

  let tMin = Infinity, tMax = -Infinity;
  for (const s of ds) {
    if (s.value < tMin) tMin = s.value;
    if (s.value > tMax) tMax = s.value;
  }
  if (!isFinite(tMin)) { tMin = 0; tMax = 1; }
  const yPad = (tMax - tMin) * 0.08 || 0.5;
  const targetMin = tMin - yPad;
  const targetMax = tMax + yPad;
  const key = `ch:${strip.channelId}`;
  const prev = dc.smoothedYRanges.get(key);
  let yMin: number, yMax: number;
  if (prev) {
    yMin = prev[0] + (targetMin - prev[0]) * LERP_RATE;
    yMax = prev[1] + (targetMax - prev[1]) * LERP_RATE;
  } else {
    yMin = targetMin;
    yMax = targetMax;
  }
  dc.smoothedYRanges.set(key, [yMin, yMax]);
  const span = Math.abs(targetMax - targetMin) || 1;
  if (Math.abs(yMin - targetMin) / span > 0.001 || Math.abs(yMax - targetMax) / span > 0.001) {
    dc.needsDrawRef.current = true;
  }
  return [yMin, yMax];
}

/** Draw all strip content: grid, traces, min/max markers, y-axes, labels */
export function drawStrips(dc: DrawContext): void {
  const { ctx, w, lm, rm, plotW, xRange, xTicks, strips, channelDataMap, chartMode, session } = dc;
  const pendingMarkers: { strip: StripLayout; mm: VisibleMinMax; valToY: (v: number) => number; units: string; trace: TracePoints }[] = [];
  let gridDrawnForOverlay = false;
  const overlayAxesDrawn = new Set<string>();

  for (const strip of strips) {
    const data = channelDataMap.get(strip.channelId);
    if (!data) continue;
    const { allSamples, def } = data;
    const visible = allSamples.length > 0
      ? dc.getVisibleSamples(strip.channelId, allSamples, xRange, plotW)
      : [];

    const [yMin, yMax] = computeStripYRange(
      dc, strip, dc.compare ? visibleForRange(dc, strip.channelId, allSamples) : visible, def.units || '',
    );
    // Min-max per-pixel optimization for rendering (pixel-identical output)
    const ds = minMaxTrace(visible, (tSec) => dc.timeToX(tSec, xRange, plotW), plotW);
    const ySpan = yMax - yMin || 1;
    const valToY = (v: number) =>
      strip.top + strip.height - 4 - ((v - yMin) / ySpan) * (strip.height - 8);

    // Grid
    const yTicks = niceAxisTicks(yMin, yMax, Math.max(2, Math.floor(strip.height / 30)));
    const shouldDrawGrid = chartMode !== 'overlay' || !gridDrawnForOverlay;

    if (shouldDrawGrid) {
      ctx.strokeStyle = dc.colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const yt of yTicks) {
        const y = Math.round(valToY(yt)) + 0.5;
        ctx.moveTo(lm, y);
        ctx.lineTo(w - rm, y);
      }
      ctx.stroke();

      ctx.beginPath();
      for (const xt of xTicks) {
        const x = Math.round(dc.timeToX(xt, xRange, plotW)) + 0.5;
        if (x >= lm && x <= w - rm) {
          ctx.moveTo(x, strip.top);
          ctx.lineTo(x, strip.top + strip.height);
        }
      }
      ctx.stroke();

      // Lap markers
      ctx.strokeStyle = dc.colors.lapMarker;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (const lap of session.lapMarkers) {
        const lt = lap.timestamp / 1000;
        if (lt >= xRange[0] && lt <= xRange[1]) {
          const x = Math.round(dc.timeToX(lt, xRange, plotW)) + 0.5;
          ctx.moveTo(x, strip.top);
          ctx.lineTo(x, strip.top + strip.height);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (strip === strips[0]) {
        ctx.font = scaledFont(9, dc.fontScale);
        ctx.fillStyle = dc.colors.lapText;
        ctx.textAlign = 'center';
        // Dense laps: skip labels that would overlap the previous one.
        const shown = session.lapMarkers
          .map((lap, i) => ({ t: lap.timestamp / 1000, label: `L${i + 1}` }))
          .filter(l => l.t >= xRange[0] && l.t <= xRange[1]);
        const xs = shown.map(l => dc.timeToX(l.t, xRange, plotW));
        const keep = thinLabels(xs, shown.map(l => ctx.measureText(l.label).width), 4);
        shown.forEach((l, i) => { if (keep[i]) ctx.fillText(l.label, xs[i], strip.top + 10 * dc.fontScale); });
      }

      if (chartMode === 'overlay') gridDrawnForOverlay = true;
    }

    // Line trace(s), clipped to the plot: getVisibleSamples pads past the
    // window edges so lines run to the border, but must not draw past it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(lm, strip.top, plotW, strip.height);
    ctx.clip();
    ctx.lineJoin = 'round';
    let labelTrace = ds; // trace min/max boxes should avoid (first lap in compare)
    const lapSeries = dc.compare?.series.get(strip.channelId);
    if (lapSeries) {
      // Compare: one trace per lap. Separate strips colour by lap; overlay
      // keeps the channel colour and tells laps apart by dash + fade.
      for (let i = lapSeries.length - 1; i >= 0; i--) {
        const lapVisible = lapSeries[i].length > 0
          ? dc.getVisibleSamples(strip.channelId, lapSeries[i], xRange, plotW) : [];
        const lapDs = minMaxTrace(lapVisible, (tSec) => dc.timeToX(tSec, xRange, plotW), plotW);
        if (i === 0) labelTrace = lapDs;
        ctx.save();
        if (chartMode === 'overlay') {
          ctx.strokeStyle = strip.color;
          ctx.globalAlpha = Math.max(0.4, 1 - 0.2 * i);
          ctx.setLineDash(i === 0 ? [] : [6, 3]);
        } else {
          ctx.strokeStyle = lapColor(i);
        }
        ctx.lineWidth = i === 0 ? 2.0 : 1.5;
        strokeTrace(dc, lapDs, valToY);
        ctx.restore();
      }
    } else if (ds.length > 1) {
      ctx.strokeStyle = strip.color;
      ctx.lineWidth = 2.0;
      strokeTrace(dc, ds, valToY);
    }

    // Data point markers — visible when zoomed in tight (>8px between points)
    if (visible.length > 1 && visible.length <= plotW / 4) {
      ctx.fillStyle = strip.color;
      ctx.beginPath();
      for (const s of visible) {
        const x = dc.timeToX(s.timestamp / 1000, xRange, plotW);
        const y = valToY(s.value);
        if (x >= lm && x <= w - rm) {
          ctx.moveTo(x + 2.5, y);
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    ctx.restore(); // end trace clip

    // Min/Max markers (visible window) are drawn after every trace (below),
    // so no later channel's line paints over a box.
    const mm = visibleMinMax(allSamples, xRange[0] * 1000, xRange[1] * 1000);
    pendingMarkers.push({
      strip, mm, valToY, units: def.units || '',
      trace: {
        xs: labelTrace.map(p => dc.timeToX(p.timestamp / 1000, xRange, plotW)),
        ys: labelTrace.map(p => valToY(p.value)),
      },
    });
    if (chartMode !== 'overlay') drawMinMaxReadout(dc, strip, mm, def.units || '');

    // Y-axis
    drawYAxis(dc, strip, yTicks, valToY, def, overlayAxesDrawn);

    // Channel name (separate mode)
    if (chartMode !== 'overlay') {
      ctx.save();
      ctx.font = scaledFont(10, dc.fontScale, 'bold');
      ctx.fillStyle = strip.color;
      ctx.textAlign = 'center';
      ctx.translate(12, strip.top + strip.height / 2);
      ctx.rotate(-Math.PI / 2);
      const maxChars = Math.floor(strip.height / 6);
      // ▾ marks a clickable unit (opens the unit menu).
      const suffix = convertibleUnits(strip.units).length > 0 ? ' ▾' : '';
      let nameText = strip.label;
      const room = maxChars - suffix.length;
      if (nameText.length > room) nameText = nameText.slice(0, Math.max(1, room - 1)) + '…';
      nameText += suffix;
      ctx.fillText(nameText, 0, 0);
      ctx.restore();
    }

    // Strip separator (separate mode)
    if (chartMode !== 'overlay') {
      ctx.strokeStyle = dc.colors.separator;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const sepY = Math.round(strip.top + strip.height) + 0.5;
      ctx.moveTo(0, sepY);
      ctx.lineTo(w, sepY);
      ctx.stroke();
    }
  }
  // Second pass: all reference lines, then all boxes (on top of every trace).
  // Overlay strips share one plot, so boxes there avoid every channel's line
  // and each other; separate strips only their own.
  for (const m of pendingMarkers) drawMinMaxLines(dc, m.strip, m.mm, m.valToY);
  const placed: LabelRect[] = [];
  const allTraces = pendingMarkers.map(m => m.trace);
  for (const m of pendingMarkers) {
    drawMinMaxBoxes(dc, m.strip, m.mm, m.valToY, m.units, chartMode === 'overlay' ? allTraces : [m.trace], placed);
  }
}

export type VisibleMinMax = ReturnType<typeof visibleMinMax>;

function minMaxText(mm: NonNullable<VisibleMinMax>, units: string): string {
  return `min ${formatValue(mm.min.value)} · max ${formatValue(mm.max.value)}${units ? ` ${units}` : ''}`;
}

/** RaceStudio-style dashed reference lines across the plot at the window's min and max. */
function drawMinMaxLines(dc: DrawContext, strip: StripLayout, mm: VisibleMinMax, valToY: (v: number) => number) {
  if (!mm) return;
  const { ctx, w, lm, rm } = dc;
  ctx.save();
  ctx.strokeStyle = strip.color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (const s of [mm.max, mm.min]) {
    const y = Math.round(valToY(s.value)) + 0.5;
    ctx.moveTo(lm, y);
    ctx.lineTo(w - rm, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Dot + boxed value at the window's min and max, each placed where traces
 *  don't run through it and it doesn't cover another box. */
function drawMinMaxBoxes(
  dc: DrawContext, strip: StripLayout, mm: VisibleMinMax,
  valToY: (v: number) => number, units: string, traces: TracePoints[], placed: LabelRect[],
) {
  if (!mm) return;
  const { ctx, w, lm, rm, xRange, plotW } = dc;
  const bounds = { left: lm, right: w - rm, top: strip.top + 2, bottom: strip.top + strip.height - 2 };
  const textColor = contrastText(strip.color);
  const fontPx = Math.round(11 * dc.fontScale);
  const boxH = fontPx + 6;
  ctx.font = `bold ${fontPx}px ${MONO_FONT}`;
  const draw = (s: typeof mm.max, isMax: boolean) => {
    const x = dc.timeToX(s.timestamp / 1000, xRange, plotW);
    const y = valToY(s.value);
    ctx.fillStyle = strip.color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();

    const label = `${isMax ? '▲' : '▼'} ${formatValue(s.value)}${units ? ` ${units}` : ''}`;
    const boxW = ctx.measureText(label).width + 8;
    const pos = chooseLabelBox(x, y, boxW, boxH, bounds, isMax ? 'above' : 'below', traces, placed);
    placed.push({ x: pos.x, y: pos.y, w: boxW, h: boxH });
    ctx.fillStyle = strip.color;
    ctx.beginPath();
    ctx.roundRect(pos.x, pos.y, boxW, boxH, 3);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.fillText(label, pos.x + 4, pos.y + boxH - 5);
  };
  draw(mm.max, true);
  draw(mm.min, false);
}

/** "min X · max Y unit" at the bottom-right of a strip (separate mode). */
function drawMinMaxReadout(dc: DrawContext, strip: StripLayout, mm: VisibleMinMax, units: string) {
  if (!mm) return;
  const { ctx, w, rm } = dc;
  ctx.font = scaledFont(10, dc.fontScale);
  ctx.fillStyle = dc.colors.text;
  ctx.textAlign = 'right';
  // Bottom-right: the cursor value pill occupies the top-right.
  ctx.fillText(minMaxText(mm, units), w - rm - 4, strip.top + strip.height - 6);

}

function drawYAxis(
  dc: DrawContext, strip: StripLayout, yTicks: number[],
  valToY: (v: number) => number,
  def: { shortName: string; units: string; color: string },
  overlayAxesDrawn: Set<string>,
) {
  const { ctx, w, lm, rm, chartMode } = dc;

  if (chartMode === 'overlay') {
    const units = def.units || '';
    const axisInfo = dc.overlayAxisLayout.unitAxes.get(units);
    if (!axisInfo) return;
    const { side, sideIndex } = axisInfo;
    const isLeft = side === 'left';
    if (overlayAxesDrawn.has(units)) return;
    overlayAxesDrawn.add(units);

    const axX = isLeft
      ? lm - 5 - sideIndex * AXIS_WIDTH * dc.fontScale
      : w - rm + 5 + sideIndex * AXIS_WIDTH * dc.fontScale;

    ctx.font = scaledFont(10, dc.fontScale);
    ctx.fillStyle = dc.colors.text;
    ctx.textAlign = isLeft ? 'right' : 'left';
    for (const yt of yTicks) {
      const y = valToY(yt);
      if (y >= strip.top + 5 && y <= strip.top + strip.height - 5) {
        ctx.fillText(formatValue(yt), axX, y + 3);
      }
    }

    const lineX = isLeft ? axX + 3 : axX - 3;
    ctx.strokeStyle = dc.colors.separator;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lineX, strip.top);
    ctx.lineTo(lineX, strip.top + strip.height);
    ctx.stroke();

    if (units) {
      ctx.font = scaledFont(8, dc.fontScale);
      ctx.fillStyle = dc.colors.text;
      ctx.textAlign = isLeft ? 'right' : 'left';
      ctx.fillText(units, axX, strip.top + strip.height - 4);
    }
  } else {
    ctx.font = scaledFont(10, dc.fontScale);
    ctx.fillStyle = strip.color;
    ctx.textAlign = 'right';
    for (const yt of yTicks) {
      const y = valToY(yt);
      if (y >= strip.top + 5 && y <= strip.top + strip.height - 5) {
        ctx.fillText(formatValue(yt), lm - 5, y + 3);
      }
    }
  }
}

/** Lap legend for compare mode: "■ Lap 3 1:12.400" per compared lap. */
export function drawCompareLegend(dc: DrawContext): void {
  // Overlay mode lists the laps in the legend band instead (drawOverlayLegend).
  if (!dc.compare || dc.strips.length === 0 || dc.chartMode === 'overlay') return;
  const { ctx, lm } = dc;
  ctx.font = scaledFont(9, dc.fontScale, 'bold');
  let x = lm + 6;
  const y = Math.round(12 * dc.fontScale);
  dc.compare.laps.forEach((lap, i) => {
    const color = lapColor(i);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x + 14, y - 3);
    ctx.stroke();
    x += 18;
    const label = `Lap ${lap.lapNumber} ${formatLapTime(lap.durationMs / 1000)}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(label, x, y);
    x += ctx.measureText(label).width + 14;
  });
}

interface LegendEntry { label: string; color: string; dash: number[] }

/** Overlay legend entries: each channel (with its window min/max), then the
 *  compared laps when lap compare is on. */
function overlayLegendEntries(dc: DrawContext): LegendEntry[] {
  const entries: LegendEntry[] = [];
  for (const strip of dc.strips) {
    const data = dc.channelDataMap.get(strip.channelId);
    if (!data) continue;
    const mm = visibleMinMax(data.allSamples, dc.xRange[0] * 1000, dc.xRange[1] * 1000);
    const label = mm ? `${data.def.shortName} (${minMaxText(mm, data.def.units || '')})` : data.def.shortName;
    entries.push({ label, color: strip.color, dash: [] });
  }
  dc.compare?.laps.forEach((lap, i) => entries.push({
    label: `Lap ${lap.lapNumber} ${formatLapTime(lap.durationMs / 1000)}`,
    color: dc.colors.text,
    dash: i > 0 ? [6, 3] : [],
  }));
  return entries;
}

const LEGEND_SWATCH = 15; // line sample + gap before the text
const LEGEND_PAD = 4;

function overlayLegendLayout(dc: DrawContext) {
  const { ctx } = dc;
  ctx.font = scaledFont(9, dc.fontScale, 'bold');
  const entries = overlayLegendEntries(dc);
  const widths = entries.map(e => LEGEND_SWATCH + ctx.measureText(e.label).width + LEGEND_PAD * 2);
  const places = layoutLegendRows(widths, Math.max(1, dc.plotW - 12), 6);
  const rowH = Math.round(18 * dc.fontScale);
  const rows = places.length ? places[places.length - 1].row + 1 : 0;
  return { entries, widths, places, rowH, height: rows ? rows * rowH + 6 : 0 };
}

/** Height of the legend band above the plot (overlay mode only). */
export function overlayLegendHeight(dc: DrawContext): number {
  if (dc.chartMode !== 'overlay' || dc.strips.length === 0) return 0;
  return overlayLegendLayout(dc).height;
}

/** Overlay legend: wrapped rows in a band above the plot, each entry on a
 *  backdrop so it stays legible over the grid. */
export function drawOverlayLegend(dc: DrawContext): void {
  if (dc.chartMode !== 'overlay' || dc.strips.length === 0) return;
  const { ctx, lm } = dc;
  const { entries, widths, places, rowH } = overlayLegendLayout(dc);
  entries.forEach((e, i) => {
    const x = lm + 6 + places[i].x;
    const top = 3 + places[i].row * rowH;
    const midY = top + rowH / 2;
    ctx.fillStyle = dc.colors.cursorPill;
    ctx.beginPath();
    ctx.roundRect(x, top + 1, widths[i], rowH - 2, 3);
    ctx.fill();
    ctx.strokeStyle = e.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(e.dash);
    ctx.beginPath();
    ctx.moveTo(x + LEGEND_PAD, midY);
    ctx.lineTo(x + LEGEND_PAD + 11, midY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = e.color;
    ctx.textAlign = 'left';
    ctx.fillText(e.label, x + LEGEND_PAD + LEGEND_SWATCH, midY + 3 * dc.fontScale);
  });
}

/** Draw the bottom X-axis with ticks and labels */
export function drawXAxis(dc: DrawContext): number {
  const { ctx, w, h, lm, rm, plotW, xRange, xTicks, strips } = dc;

  const axisY = strips.length > 0
    ? strips[strips.length - 1].top + strips[strips.length - 1].height
    : h - BOTTOM_AXIS_HEIGHT * dc.fontScale;

  ctx.strokeStyle = dc.colors.separator;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lm, Math.round(axisY) + 0.5);
  ctx.lineTo(w - rm, Math.round(axisY) + 0.5);
  ctx.stroke();

  ctx.font = scaledFont(10, dc.fontScale);
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
      ctx.fillText(formatChartAxisTime(xt, dc.session.logStartMs, tickStep), x, axisY + 18);
    }
  }

  ctx.font = scaledFont(9, dc.fontScale);
  ctx.fillStyle = dc.colors.text;
  ctx.textAlign = 'right';
  ctx.fillText(dc.session.logStartMs !== null ? 'Time' : 'Time (s)', w - rm, axisY + 30);

  return axisY;
}
