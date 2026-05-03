/**
 * Cursor and delta panel drawing for the telemetry chart.
 * Handles cursor lines, value readout pills, hover crosshair, and delta comparison panel.
 */
import type { ChannelSample } from './xrk-parser';
import type { DrawContext, StripLayout } from './chart-utils';
import {
  MONO_FONT,
  clamp, interpolateValue, nearestSample, formatValue, formatTimeSec,
} from './chart-utils';

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
    const tickStep = dc.xTicks.length >= 2 ? dc.xTicks[1] - dc.xTicks[0] : undefined;
    const label = formatTimeSec(t, tickStep);
    ctx.font = `10px ${MONO_FONT}`;
    const tw = ctx.measureText(label).width;
    const pillW = tw + 8;
    const pillH = 16;
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

function stripValToY(strip: StripLayout, yRange: [number, number], v: number): number {
  const ySpan = yRange[1] - yRange[0] || 1;
  return strip.top + strip.height - 4 - ((v - yRange[0]) / ySpan) * (strip.height - 8);
}

/** Draw cursor value readout pills for a given cursor time.
 *  Each visible primary channel gets a pill; if overlays are present, a
 *  smaller #N pill is stacked under each channel's pill. */
function drawCursorPills(dc: DrawContext, cursorT: number, _axisY: number) {
  const { ctx, w, rm, xRange, plotW, strips, channelDataMap, chartMode } = dc;
  let pillIndex = 0;
  for (const strip of strips) {
    const data = channelDataMap.get(strip.channelId);
    if (!data || data.allSamples.length === 0) continue;

    const snap = nearestSample(data.allSamples, cursorT * 1000);
    if (!snap) continue;
    const lineVal = interpolateValue(data.allSamples, cursorT * 1000) ?? snap.value;
    const yRange = getStripYRange(dc, strip, data.def);
    const dotX = dc.timeToX(cursorT, xRange, plotW);
    const dotY = stripValToY(strip, yRange, lineVal);

    ctx.fillStyle = strip.color;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
    ctx.fill();

    const valText = formatValue(snap.value);
    const nameText = data.def.shortName;
    ctx.font = `bold 10px ${MONO_FONT}`;
    const nameW = ctx.measureText(nameText).width;
    ctx.font = `10px ${MONO_FONT}`;
    const valW = ctx.measureText(valText).width;
    const pillGap = 6;
    const pillPadX = 8;
    const pillW = nameW + pillGap + valW + pillPadX * 2;
    const pillH = 20;
    const pillX = w - rm - pillW - 4;
    const pillY = chartMode === 'overlay'
      ? strip.top + 4 + pillIndex * (pillH + 3)
      : strip.top + 4;

    ctx.fillStyle = dc.colors.cursorPill;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 4);
    ctx.fill();

    ctx.font = `bold 10px ${MONO_FONT}`;
    ctx.fillStyle = strip.color;
    ctx.textAlign = 'left';
    ctx.fillText(nameText, pillX + pillPadX, pillY + 14);

    ctx.font = `10px ${MONO_FONT}`;
    ctx.fillStyle = dc.colors.cursorPillText;
    ctx.fillText(valText, pillX + pillPadX + nameW + pillGap, pillY + 14);
    pillIndex++;

    // Overlay pills for this channel
    for (const ov of dc.overlays) {
      const ovSamples = ov.samplesByPrimaryId.get(strip.channelId);
      if (!ovSamples || ovSamples.length === 0) continue;
      const ovSnap = nearestSample(ovSamples, cursorT * 1000);
      if (!ovSnap) continue;

      const ovValText = formatValue(ovSnap.value);
      ctx.font = `10px ${MONO_FONT}`;
      const ovValW = ctx.measureText(ovValText).width;
      const ovTagText = `#${ov.index}`;
      ctx.font = `bold 9px ${MONO_FONT}`;
      const ovTagW = ctx.measureText(ovTagText).width;
      const ovPillW = ovTagW + pillGap + ovValW + pillPadX * 2;
      const ovPillH = 16;
      const ovPillX = w - rm - ovPillW - 4;
      const ovPillY = chartMode === 'overlay'
        ? strip.top + 4 + pillIndex * (ovPillH + 2)
        : pillY + pillH + 2 + (ov.index - 1) * (ovPillH + 2);

      ctx.fillStyle = dc.colors.cursorPill;
      ctx.beginPath();
      ctx.roundRect(ovPillX, ovPillY, ovPillW, ovPillH, 3);
      ctx.fill();

      ctx.font = `bold 9px ${MONO_FONT}`;
      ctx.fillStyle = strip.color;
      ctx.fillText(ovTagText, ovPillX + pillPadX, ovPillY + 11);

      ctx.font = `10px ${MONO_FONT}`;
      ctx.fillStyle = dc.colors.cursorPillText;
      ctx.fillText(ovValText, ovPillX + pillPadX + ovTagW + pillGap, ovPillY + 11);

      if (chartMode === 'overlay') pillIndex++;
    }
  }
}

/** Draw hover crosshair with hollow dots */
function drawHoverCrosshair(dc: DrawContext, cursor: CursorState, axisY: number) {
  const { ctx, xRange, plotW, strips, channelDataMap, chartMode } = dc;
  const hoverT = cursor.hoverT;
  if (hoverT === null) return;

  const isHoverSameAsCursorA = cursor.cursorA !== null && Math.abs(hoverT - cursor.cursorA) < (xRange[1] - xRange[0]) * 0.002;
  const isHoverSameAsCursorB = cursor.cursorB !== null && Math.abs(hoverT - cursor.cursorB) < (xRange[1] - xRange[0]) * 0.002;
  if (!isHoverSameAsCursorA && !isHoverSameAsCursorB) {
    drawCursorLine(dc, hoverT, dc.colors.hoverLine, axisY, true);
  }

  if (cursor.deltaMode && (cursor.cursorA !== null || cursor.cursorB !== null)) {
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

      const pillText = formatValue(snap.value);
      ctx.font = `8px ${MONO_FONT}`;
      const tw = ctx.measureText(pillText).width;
      const pillW = tw + 6;
      const pillH = 14;
      const pillX = dotX + 8;
      const pillY = chartMode === 'overlay'
        ? strip.top + 4 + hoverPillIndex * (pillH + 2)
        : Math.round(clamp(dotY - pillH / 2, strip.top + 2, strip.top + strip.height - pillH - 2));

      ctx.fillStyle = dc.colors.cursorPill;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 2);
      ctx.fill();
      ctx.fillStyle = strip.color + 'aa';
      ctx.textAlign = 'left';
      ctx.fillText(pillText, pillX + 3, pillY + 10);
      hoverPillIndex++;
    }
  }
}

/** Draw the delta comparison panel — within-session A/B always, plus
 *  per-overlay {A, B, Δ@A, Δ@B} columns when overlays are present. */
function drawDeltaPanel(dc: DrawContext, cursorA: number, cursorB: number) {
  const { ctx, w, rm, strips, channelDataMap, overlays } = dc;

  const deltaT = Math.abs(cursorB - cursorA);
  type OvCell = { tag: string; valA: string; valB: string; deltaA: string; deltaB: string };
  type Row = {
    label: string;
    valA: string;
    valB: string;
    delta: string;
    color: string;
    overlayCells: OvCell[];
  };
  const rows: Row[] = [];

  for (const strip of strips) {
    const data = channelDataMap.get(strip.channelId);
    if (!data || data.allSamples.length === 0) continue;
    const snapA = nearestSample(data.allSamples, cursorA * 1000);
    const snapB = nearestSample(data.allSamples, cursorB * 1000);
    if (!snapA || !snapB) continue;

    const overlayCells: OvCell[] = [];
    for (const ov of overlays) {
      const ovSamples = ov.samplesByPrimaryId.get(strip.channelId);
      if (!ovSamples || ovSamples.length === 0) continue;
      const ovSnapA = nearestSample(ovSamples, cursorA * 1000);
      const ovSnapB = nearestSample(ovSamples, cursorB * 1000);
      if (!ovSnapA || !ovSnapB) continue;
      overlayCells.push({
        tag: `#${ov.index}`,
        valA: formatValue(ovSnapA.value),
        valB: formatValue(ovSnapB.value),
        deltaA: formatValue(ovSnapA.value - snapA.value),
        deltaB: formatValue(ovSnapB.value - snapB.value),
      });
    }

    rows.push({
      label: data.def.shortName,
      valA: formatValue(snapA.value),
      valB: formatValue(snapB.value),
      delta: formatValue(snapB.value - snapA.value),
      color: strip.color,
      overlayCells,
    });
  }

  ctx.font = `bold 10px ${MONO_FONT}`;
  let maxNameW = ctx.measureText('Channel').width;
  for (const row of rows) {
    const tw = ctx.measureText(row.label).width;
    if (tw > maxNameW) maxNameW = tw;
  }
  const nameColW = maxNameW + 14;
  const valColW = 64;
  const ovValColW = 56;
  const numOverlayCols = overlays.length;

  const panelPad = 10;
  const headerH = 22;
  const colHeaderH = 18;
  const baseLineH = 20;
  const ovLineH = 16;
  let totalLines = 0;
  for (const r of rows) {
    totalLines += baseLineH + r.overlayCells.length * ovLineH;
  }
  const panelH = headerH + colHeaderH + totalLines + panelPad * 2;
  // Columns: name | A | B | Δ(A→B) | per-overlay {A, B, Δ-vs-prim@A, Δ-vs-prim@B}
  const ovColW = numOverlayCols * (ovValColW * 4);
  const panelW = nameColW + valColW * 3 + ovColW + panelPad * 2;
  const panelX = w - rm - panelW - 10;
  const panelY = 8;

  ctx.fillStyle = dc.colors.deltaPanel;
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, panelW, panelH, 6);
  ctx.fill();
  ctx.strokeStyle = dc.colors.deltaLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, panelW, panelH, 6);
  ctx.stroke();

  ctx.font = `bold 11px ${MONO_FONT}`;
  ctx.fillStyle = dc.colors.deltaAccent;
  ctx.textAlign = 'left';
  ctx.fillText(`Δt = ${deltaT.toFixed(3)}s`, panelX + panelPad, panelY + panelPad + 12);

  const col1 = panelX + panelPad;
  const col2 = panelX + panelPad + nameColW + valColW;
  const col3 = col2 + valColW;
  const col4 = col3 + valColW;

  const colY = panelY + panelPad + headerH + 10;
  ctx.font = `9px ${MONO_FONT}`;
  ctx.fillStyle = dc.colors.text;
  ctx.textAlign = 'left';
  ctx.fillText('Channel', col1, colY);
  ctx.textAlign = 'right';
  ctx.fillText('A', col2, colY);
  ctx.fillText('B', col3, colY);
  ctx.fillText('Δ', col4, colY);
  for (let i = 0; i < overlays.length; i++) {
    const baseX = col4 + (i * 4 + 1) * ovValColW;
    ctx.fillText(`#${overlays[i].index}A`, baseX, colY);
    ctx.fillText(`#${overlays[i].index}B`, baseX + ovValColW, colY);
    ctx.fillText(`Δ@A`, baseX + ovValColW * 2, colY);
    ctx.fillText(`Δ@B`, baseX + ovValColW * 3, colY);
  }

  const sepY = colY + 5;
  ctx.strokeStyle = dc.colors.separator;
  ctx.beginPath();
  ctx.moveTo(col1, sepY);
  ctx.lineTo(panelX + panelW - panelPad, sepY);
  ctx.stroke();

  let ry = sepY + 4 + 12;
  for (const row of rows) {
    ctx.font = `bold 10px ${MONO_FONT}`;
    ctx.fillStyle = row.color;
    ctx.textAlign = 'left';
    ctx.fillText(row.label, col1, ry);

    ctx.font = `10px ${MONO_FONT}`;
    ctx.fillStyle = dc.colors.text;
    ctx.textAlign = 'right';
    ctx.fillText(row.valA, col2, ry);
    ctx.fillText(row.valB, col3, ry);

    ctx.font = `bold 10px ${MONO_FONT}`;
    ctx.fillStyle = dc.colors.deltaAccent;
    ctx.fillText(row.delta, col4, ry);

    let ovRy = ry + ovLineH;
    for (const ovCell of row.overlayCells) {
      const ovIdx = overlays.findIndex(o => `#${o.index}` === ovCell.tag);
      if (ovIdx < 0) { ovRy += ovLineH; continue; }
      const baseX = col4 + (ovIdx * 4 + 1) * ovValColW;

      ctx.font = `9px ${MONO_FONT}`;
      ctx.fillStyle = dc.colors.text;
      ctx.textAlign = 'left';
      ctx.fillText(ovCell.tag, col1 + 12, ovRy);

      ctx.textAlign = 'right';
      ctx.fillText(ovCell.valA, baseX, ovRy);
      ctx.fillText(ovCell.valB, baseX + ovValColW, ovRy);
      ctx.fillStyle = dc.colors.deltaAccent;
      ctx.fillText(ovCell.deltaA, baseX + ovValColW * 2, ovRy);
      ctx.fillText(ovCell.deltaB, baseX + ovValColW * 3, ovRy);

      ovRy += ovLineH;
    }
    ry = ovRy + 4;
  }
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
    ctx.fillStyle = dc.colors.deltaFill;
    ctx.fillRect(left, 0, right - left, axisY);
  }

  // Cursor A line + pills
  if (cursor.cursorA !== null) {
    const lineColor = cursor.cursorB !== null ? dc.colors.deltaLine : dc.colors.cursor;
    drawCursorLine(dc, cursor.cursorA, lineColor, axisY, true);
    drawCursorPills(dc, cursor.cursorA, axisY);
  }

  // Cursor B line
  if (cursor.cursorB !== null) {
    drawCursorLine(dc, cursor.cursorB, dc.colors.deltaLine, axisY, true);
  }

  // Hover crosshair
  drawHoverCrosshair(dc, cursor, axisY);

  // Delta panel
  if (cursor.cursorA !== null && cursor.cursorB !== null) {
    drawDeltaPanel(dc, cursor.cursorA, cursor.cursorB);
  }
}
