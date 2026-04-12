/**
 * Chart drawing functions — grid, traces, axes, labels, legend, x-axis.
 * Separated from TelemetryChart.tsx for readability.
 */
import type { ChannelSample } from './xrk-parser';
import type { DrawContext, StripLayout } from './chart-utils';
import {
  MONO_FONT, AXIS_WIDTH,
  BOTTOM_AXIS_HEIGHT,
  niceAxisTicks, formatValue, formatTimeSec, clamp, brightenColor,
} from './chart-utils';

const LERP_RATE = 0.18;

/** Compute smoothed Y-range for overlay mode shared axes */
export function computeOverlayYRanges(dc: DrawContext): void {
  if (dc.chartMode !== 'overlay') return;
  const unitMinMax = new Map<string, { min: number; max: number }>();
  for (const strip of dc.strips) {
    const data = dc.channelDataMap.get(strip.channelId);
    if (!data) continue;
    const units = data.def.units || '';
    const ds = data.allSamples.length > 0
      ? dc.getVisibleSamples(strip.channelId, data.allSamples, dc.xRange, dc.plotW)
      : [];
    let mn = Infinity, mx = -Infinity;
    for (const s of ds) {
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
export function drawStrips(
  dc: DrawContext,
  globalMinMaxCache: Map<number, { minSample: ChannelSample; maxSample: ChannelSample }>,
): void {
  const { ctx, w, lm, rm, plotW, xRange, xTicks, strips, channelDataMap, chartMode, session } = dc;
  let gridDrawnForOverlay = false;
  const overlayAxesDrawn = new Set<string>();

  for (const strip of strips) {
    const data = channelDataMap.get(strip.channelId);
    if (!data) continue;
    const { allSamples, def } = data;
    const ds = allSamples.length > 0
      ? dc.getVisibleSamples(strip.channelId, allSamples, xRange, plotW)
      : [];

    const [yMin, yMax] = computeStripYRange(dc, strip, ds, def.units || '');
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
        ctx.font = `9px ${MONO_FONT}`;
        ctx.fillStyle = dc.colors.lapText;
        ctx.textAlign = 'center';
        session.lapMarkers.forEach((lap, i) => {
          const lt = lap.timestamp / 1000;
          if (lt >= xRange[0] && lt <= xRange[1]) {
            ctx.fillText(`L${i + 1}`, dc.timeToX(lt, xRange, plotW), strip.top + 10);
          }
        });
      }

      if (chartMode === 'overlay') gridDrawnForOverlay = true;
    }

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

    // Min/Max markers
    drawMinMaxMarkers(dc, strip, globalMinMaxCache, valToY);

    // Y-axis
    drawYAxis(dc, strip, yTicks, valToY, def, overlayAxesDrawn);

    // Channel name (separate mode)
    if (chartMode !== 'overlay') {
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
}

function drawMinMaxMarkers(
  dc: DrawContext, strip: StripLayout,
  cache: Map<number, { minSample: ChannelSample; maxSample: ChannelSample }>,
  valToY: (v: number) => number,
) {
  const { ctx, w, lm, rm, xRange, plotW } = dc;
  const globalMM = cache.get(strip.channelId);
  if (!globalMM) return;

  const bright = brightenColor(strip.color, 0.3);
  const chartLeft = lm;
  const chartRight = w - rm;

  const drawMarker = (sample: ChannelSample, isMax: boolean) => {
    const tSec = sample.timestamp / 1000;
    const rawX = dc.timeToX(tSec, xRange, plotW);
    const inView = rawX >= chartLeft && rawX <= chartRight;
    const markerY = valToY(sample.value);
    ctx.fillStyle = bright;
    ctx.font = `8px ${MONO_FONT}`;

    if (inView) {
      ctx.beginPath();
      if (isMax) {
        ctx.moveTo(rawX, markerY - 5); ctx.lineTo(rawX - 3, markerY); ctx.lineTo(rawX + 3, markerY);
      } else {
        ctx.moveTo(rawX, markerY + 5); ctx.lineTo(rawX - 3, markerY); ctx.lineTo(rawX + 3, markerY);
      }
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillText(`${isMax ? '▲' : '▼'} ${formatValue(sample.value)}`, rawX + 5, markerY + 3);
    } else {
      const edgeX = rawX < chartLeft ? chartLeft + 4 : chartRight - 4;
      const edgeY = clamp(markerY, strip.top + 8, strip.top + strip.height - 8);
      const arrowDir = rawX < chartLeft ? 1 : -1;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(edgeX + arrowDir * 6, edgeY);
      ctx.lineTo(edgeX + arrowDir * 2, edgeY - 4);
      ctx.lineTo(edgeX + arrowDir * 2, edgeY + 4);
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = arrowDir > 0 ? 'left' : 'right';
      ctx.fillText(`${isMax ? '▲' : '▼'} ${formatValue(sample.value)}`, edgeX + arrowDir * 9, edgeY + 3);
      ctx.globalAlpha = 1;
    }
  };

  drawMarker(globalMM.maxSample, true);
  drawMarker(globalMM.minSample, false);
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
      ? lm - 5 - sideIndex * AXIS_WIDTH
      : w - rm + 5 + sideIndex * AXIS_WIDTH;

    ctx.font = `10px ${MONO_FONT}`;
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
      ctx.font = `8px ${MONO_FONT}`;
      ctx.fillStyle = dc.colors.text;
      ctx.textAlign = isLeft ? 'right' : 'left';
      ctx.fillText(units, axX, strip.top + strip.height - 4);
    }
  } else {
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
}

/** Draw overlay legend bar */
export function drawOverlayLegend(dc: DrawContext): void {
  if (dc.chartMode !== 'overlay' || dc.strips.length === 0) return;
  const { ctx, lm } = dc;
  ctx.font = `bold 9px ${MONO_FONT}`;
  let legendX = lm + 6;
  const legendY = 14;
  for (const strip of dc.strips) {
    const data = dc.channelDataMap.get(strip.channelId);
    if (!data) continue;
    const name = data.def.shortName;
    ctx.strokeStyle = strip.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY - 3);
    ctx.lineTo(legendX + 12, legendY - 3);
    ctx.stroke();
    legendX += 15;
    ctx.fillStyle = strip.color;
    ctx.textAlign = 'left';
    ctx.fillText(name, legendX, legendY);
    legendX += ctx.measureText(name).width + 12;
  }
}

/** Draw the bottom X-axis with ticks and labels */
export function drawXAxis(dc: DrawContext): number {
  const { ctx, w, h, lm, rm, plotW, xRange, xTicks, strips } = dc;

  const axisY = strips.length > 0
    ? strips[strips.length - 1].top + strips[strips.length - 1].height
    : h - BOTTOM_AXIS_HEIGHT;

  ctx.strokeStyle = dc.colors.separator;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lm, Math.round(axisY) + 0.5);
  ctx.lineTo(w - rm, Math.round(axisY) + 0.5);
  ctx.stroke();

  ctx.font = `10px ${MONO_FONT}`;
  ctx.fillStyle = dc.colors.text;
  ctx.textAlign = 'center';
  for (const xt of xTicks) {
    const x = dc.timeToX(xt, xRange, plotW);
    if (x >= lm && x <= w - rm) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, axisY);
      ctx.lineTo(Math.round(x) + 0.5, axisY + 5);
      ctx.stroke();
      ctx.fillText(formatTimeSec(xt), x, axisY + 18);
    }
  }

  ctx.font = `9px ${MONO_FONT}`;
  ctx.fillStyle = dc.colors.text;
  ctx.textAlign = 'right';
  ctx.fillText('Time (s)', w - rm, axisY + 30);

  return axisY;
}
