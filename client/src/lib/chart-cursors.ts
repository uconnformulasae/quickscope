/**
 * Cursor and delta panel drawing for the telemetry chart.
 * Handles cursor lines, value readout pills, hover crosshair, and delta comparison panel.
 */
import type { DrawContext, StripLayout } from './chart-utils';
import {
  MONO_FONT, scaledFont,
  clamp, interpolateValue, nearestSample, formatValue,
} from './chart-utils';
import { formatChartCursorTime } from './time-format';

interface CursorState {
  cursorA: number | null;
  cursorB: number | null;
  hoverT: number | null;
  deltaMode: boolean;
}

function drawCursorLine(
  dc: DrawContext, t: number, color: string, axisY: number, showTimestamp = false,
) {
  const { ctx, w, lm, rm, xRange, plotW } = dc;
  const x = Math.round(dc.timeToX(t, xRange, plotW)) + 0.5;
  if (x < lm || x > w - rm) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, axisY);
  ctx.stroke();

  if (showTimestamp) {
    const label = formatChartCursorTime(t, dc.session.logStartMs);
    ctx.font = scaledFont(10, dc.fontScale);
    const tw = ctx.measureText(label).width;
    const pillW = tw + 8;
    const pillH = Math.round(16 * dc.fontScale);
    const pillX = Math.round(clamp(x - pillW / 2, lm, w - rm - pillW));
    const pillY = axisY + 2;
    ctx.fillStyle = dc.colors.cursorPill;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 3);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label, pillX + pillW / 2, pillY + 12);
  }
}

function getStripYRange(dc: DrawContext, strip: StripLayout, def: { units: string }): [number, number] {
  // Use the same smoothed Y-ranges that the trace was drawn with
  if (dc.chartMode === 'overlay') {
    const shared = dc.sharedYRanges.get(def.units || '');
    if (shared) return shared;
  } else {
    const smoothed = dc.smoothedYRanges.get(`ch:${strip.channelId}`);
    if (smoothed) return smoothed;
  }
  return [0, 1];
}

/** Compare mode: each lap's nearest value at lap-relative tMs, "a / b / c". */
function compareValueText(dc: DrawContext, channelId: number, tMs: number): string | null {
  const series = dc.compare?.series.get(channelId);
  if (!series) return null;
  return series.map((s, i) => {
    const endMs = dc.compare!.laps[i]?.durationMs ?? (s.length > 0 ? s[s.length - 1].timestamp : -1);
    if (tMs > endMs) return '–'; // this lap has already ended
    const snap = s.length > 0 ? nearestSample(s, tMs) : null;
    return snap ? formatValue(snap.value) : '–';
  }).join(' / ');
}

function stripValToY(strip: StripLayout, yRange: [number, number], v: number): number {
  const ySpan = yRange[1] - yRange[0] || 1;
  return strip.top + strip.height - 4 - ((v - yRange[0]) / ySpan) * (strip.height - 8);
}

/** Draw cursor value readout pills for a given cursor time */
function drawCursorPills(dc: DrawContext, cursorT: number, axisY: number) {
  const { ctx, w, rm, xRange, plotW, strips, channelDataMap, chartMode } = dc;
  let pillIndex = 0;
  for (const strip of strips) {
    const data = channelDataMap.get(strip.channelId);
    if (!data || data.allSamples.length === 0) continue;

    // Snap to nearest real sample for the displayed value
    const snap = nearestSample(data.allSamples, cursorT * 1000);
    if (!snap) continue;

    // Interpolate for dot position so it sits on the drawn line
    const lineVal = interpolateValue(data.allSamples, cursorT * 1000) ?? snap.value;
    const yRange = getStripYRange(dc, strip, data.def);
    const dotX = dc.timeToX(cursorT, xRange, plotW);
    const dotY = stripValToY(strip, yRange, lineVal);

    // Dot on trace
    ctx.fillStyle = strip.color;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
    ctx.fill();

    // Value pill — nearest real measured value (every lap's, in compare mode)
    const valText = compareValueText(dc, strip.channelId, cursorT * 1000) ?? formatValue(snap.value);
    const nameText = data.def.shortName;
    ctx.font = scaledFont(10, dc.fontScale, 'bold');
    const nameW = ctx.measureText(nameText).width;
    ctx.font = scaledFont(10, dc.fontScale);
    const valW = ctx.measureText(valText).width;
    const pillGap = 6;
    const pillPadX = 8;
    const pillW = nameW + pillGap + valW + pillPadX * 2;
    const pillH = Math.round(20 * dc.fontScale);
    const pillX = w - rm - pillW - 4;
    const pillY = chartMode === 'overlay'
      ? strip.top + 4 + pillIndex * (pillH + 3)
      : strip.top + 4; // fixed at top of strip in separate mode

    ctx.fillStyle = dc.colors.cursorPill;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 4);
    ctx.fill();

    ctx.font = scaledFont(10, dc.fontScale, 'bold');
    ctx.fillStyle = strip.color;
    ctx.textAlign = 'left';
    ctx.fillText(nameText, pillX + pillPadX, pillY + 14);

    ctx.font = scaledFont(10, dc.fontScale);
    ctx.fillStyle = dc.colors.cursorPillText;
    ctx.fillText(valText, pillX + pillPadX + nameW + pillGap, pillY + 14);
    pillIndex++;
  }
}

/** Draw hover crosshair with hollow dots */
function drawHoverCrosshair(dc: DrawContext, cursor: CursorState, axisY: number, showPills = true) {
  const { ctx, xRange, plotW, strips, channelDataMap, chartMode } = dc;
  const hoverT = cursor.hoverT;
  if (hoverT === null) return;

  const isHoverSameAsCursorA = cursor.cursorA !== null && Math.abs(hoverT - cursor.cursorA) < (xRange[1] - xRange[0]) * 0.002;
  const isHoverSameAsCursorB = cursor.cursorB !== null && Math.abs(hoverT - cursor.cursorB) < (xRange[1] - xRange[0]) * 0.002;
  if (!isHoverSameAsCursorA && !isHoverSameAsCursorB) {
    drawCursorLine(dc, hoverT, dc.colors.hoverLine, axisY, true);
  }

  if (showPills && (!cursor.deltaMode || cursor.cursorA !== null || cursor.cursorB !== null)) {
    let hoverPillIndex = 0;
    for (const strip of strips) {
      const data = channelDataMap.get(strip.channelId);
      if (!data || data.allSamples.length === 0) continue;

      const snap = nearestSample(data.allSamples, hoverT * 1000);
      if (!snap) continue;

      const lineVal = interpolateValue(data.allSamples, hoverT * 1000) ?? snap.value;
      const yRange = getStripYRange(dc, strip, data.def);
      const dotX = dc.timeToX(hoverT, xRange, plotW);
      const dotY = stripValToY(strip, yRange, lineVal);

      ctx.strokeStyle = strip.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
      ctx.stroke();

      const pillText = compareValueText(dc, strip.channelId, hoverT * 1000) ?? formatValue(snap.value);
      ctx.font = scaledFont(8, dc.fontScale);
      const tw = ctx.measureText(pillText).width;
      const pillW = tw + 6;
      const pillH = Math.round(14 * dc.fontScale);
      // Right of the dot, flipped to the left near the plot's right edge.
      const pillX = dotX + 8 + pillW > dc.w - dc.rm ? dotX - 8 - pillW : dotX + 8;
      const pillY = chartMode === 'overlay'
        ? strip.top + 4 + hoverPillIndex * (pillH + 2)
        : Math.round(clamp(dotY - pillH / 2, strip.top + 2, strip.top + strip.height - pillH - 2));

      ctx.fillStyle = dc.colors.cursorPill;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 2);
      ctx.fill();
      ctx.fillStyle = strip.color;
      ctx.globalAlpha = 0.85;
      ctx.textAlign = 'left';
      ctx.fillText(pillText, pillX + 3, pillY + 10);
      ctx.globalAlpha = 1.0;
      hoverPillIndex++;
    }
  }
}

export interface DeltaRow {
  channelId: number;
  label: string;
  color: string;
  valA: string;
  valB: string;
  delta: string;
}

/** Values at the two delta cursors for each plotted channel (Δ = B − A).
 *  Shown in the readout docked under the chart, not over the plot. */
export function computeDelta(
  strips: Pick<StripLayout, 'channelId' | 'color'>[],
  channelDataMap: DrawContext['channelDataMap'],
  cursorA: number,
  cursorB: number,
): { deltaT: number; rows: DeltaRow[] } {
  const rows: DeltaRow[] = [];
  for (const strip of strips) {
    const data = channelDataMap.get(strip.channelId);
    if (!data || data.allSamples.length === 0) continue;
    const snapA = nearestSample(data.allSamples, cursorA * 1000);
    const snapB = nearestSample(data.allSamples, cursorB * 1000);
    if (!snapA || !snapB) continue;
    rows.push({
      channelId: strip.channelId,
      label: data.def.shortName,
      color: strip.color,
      valA: formatValue(snapA.value),
      valB: formatValue(snapB.value),
      delta: formatValue(snapB.value - snapA.value),
    });
  }
  return { deltaT: Math.abs(cursorB - cursorA), rows };
}

/** Draw all cursor overlays: cursor lines, value pills, hover, delta panel */
export function drawCursors(dc: DrawContext, cursor: CursorState, axisY: number): void {
  const { ctx, lm, rm, w, xRange, plotW } = dc;

  // Delta region fill
  if (cursor.cursorA !== null && cursor.cursorB !== null) {
    const xA = dc.timeToX(cursor.cursorA, xRange, plotW);
    const xB = dc.timeToX(cursor.cursorB, xRange, plotW);
    const left = Math.max(lm, Math.min(xA, xB));
    const right = Math.min(w - rm, Math.max(xA, xB));
    // Both cursors off the same side of the plot: nothing visible to shade
    // (a negative width would paint backwards over the axis margin).
    if (right > left) {
      ctx.fillStyle = dc.colors.deltaFill;
      ctx.fillRect(left, 0, right - left, axisY);
    }
  }

  // With both delta cursors placed, values live in the delta readout docked
  // under the chart — per-cursor and hover pills would just repeat them.
  const panelOpen = cursor.cursorA !== null && cursor.cursorB !== null;

  // Cursor A line + pills
  if (cursor.cursorA !== null) {
    const lineColor = cursor.cursorB !== null ? dc.colors.deltaLine : dc.colors.cursor;
    drawCursorLine(dc, cursor.cursorA, lineColor, axisY, true);
    if (!panelOpen) drawCursorPills(dc, cursor.cursorA, axisY);
  }

  // Cursor B line
  if (cursor.cursorB !== null) {
    drawCursorLine(dc, cursor.cursorB, dc.colors.deltaLine, axisY, true);
  }

  // Hover crosshair
  drawHoverCrosshair(dc, cursor, axisY, !panelOpen);

}

/** Which delta cursor (if any) is under the mouse. Inputs are canvas-px x
 *  positions; the nearer cursor wins, ties go to B. */
export function hitTestCursor(
  mouseX: number, cursorAX: number | null, cursorBX: number | null, tolerancePx: number,
): 'A' | 'B' | null {
  const dA = cursorAX === null ? Infinity : Math.abs(mouseX - cursorAX);
  const dB = cursorBX === null ? Infinity : Math.abs(mouseX - cursorBX);
  if (Math.min(dA, dB) > tolerancePx) return null;
  return dB <= dA ? 'B' : 'A';
}
