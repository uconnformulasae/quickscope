/**
 * Chart image export.
 *
 * Re-renders the chart's current view (channels, visible time window,
 * separate/overlay layout, min/max markers) into an offscreen canvas at a
 * fixed, document-friendly size and 2x pixel ratio, with a header band that
 * says what the image shows (session, car/driver/venue/date, time window,
 * per-channel min/max inside the window) and a small footer.
 *
 * Kept separate from chart-draw.ts on purpose: the on-screen chart is sized
 * for a dense interactive view (8-10 px text, lerped y-ranges, cursors); the
 * export needs different geometry, fonts and an always-dark palette.
 */
import type { ChannelSample, LapMarker, SessionMetadata } from './xrk-parser';
import { formatTime, formatLapTime } from './xrk-parser';
import type { ChartMode } from './useXRKStore';
import {
  niceAxisTicks, formatValue, formatTimeSec, brightenColor, minMaxTrace, clamp, interpolateValue,
} from './chart-utils';

// ─── Public types ───────────────────────────────────────────────────────────

export interface ExportChannel {
  channelId: number;
  name: string;
  units: string;
  /** Dark-theme channel colour */
  color: string;
  /** All samples for the channel (ms timestamps, sorted) */
  samples: ChannelSample[];
  /** Whole-session extremes, same as the on-screen min/max markers */
  globalMin: ChannelSample | null;
  globalMax: ChannelSample | null;
}

export interface ChartExportSpec {
  fileName: string | null;
  metadata: SessionMetadata;
  channels: ExportChannel[];
  /** Visible window in seconds */
  xRange: [number, number];
  sessionDurationSec: number;
  chartMode: ChartMode;
  lapMarkers: LapMarker[];
  exportedAt: Date;
}

export interface ChartExportResult {
  blob: Blob;
  fileName: string;
  /** CSS-pixel size (the PNG itself is DPR times larger) */
  width: number;
  height: number;
  pixelRatio: number;
}

// ─── Look ───────────────────────────────────────────────────────────────────

const DPR = 2;
const W = 1600;
const BASE_H = 900;
const PAD = 56;

const MONO = '"JetBrains Mono", ui-monospace, monospace';
const SANS = '"DM Sans", system-ui, sans-serif';

const FONT = {
  title: `600 24px ${SANS}`,
  window: `500 20px ${MONO}`,
  windowSub: `400 15px ${MONO}`,
  metaLabel: `400 15px ${SANS}`,
  metaValue: `500 16px ${SANS}`,
  legendName: `600 17px ${SANS}`,
  legendUnit: `400 16px ${SANS}`,
  legendLabel: `400 15px ${SANS}`,
  legendValue: `500 15px ${MONO}`,
  tick: `400 15px ${MONO}`,
  axisTitle: `600 16px ${SANS}`,
  marker: `500 14px ${MONO}`,
  lap: `500 14px ${MONO}`,
  footer: `600 14px ${SANS}`,
  footerDate: `400 13px ${MONO}`,
};

const COLOR = {
  bg: '#0d0e14',
  band: '#131520',
  border: 'rgba(255,255,255,0.07)',
  title: '#dde1ec',
  text: '#c3c9d8',
  muted: '#8b93a8',
  faint: '#596075',
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.16)',
  lap: 'rgba(247,127,0,0.45)',
  lapText: '#f77f00',
  accent: '#4361ee',
};

const LINE_WIDTH = 2.5;

// Header layout
const HEADER_TOP = 44;
const TITLE_BASELINE = HEADER_TOP + 28;
const LINE_STEP = 34;
const LEG_COLS = 4;
const LEG_H = 50;
const LEG_ROW_GAP = 18;
const HEADER_BOTTOM_PAD = 30;

// Plot layout
const PLOT_TOP_GAP = 40;
const STRIP_GAP = 32;
const MIN_STRIP_H = 200;
const MIN_OVERLAY_H = 440;
const X_AXIS_H = 76;
const FOOTER_H = 60;
const Y_TITLE_BAND = 30;
const TICK_GAP = 14;
const TRACE_INSET = 8;

// ─── Small helpers ──────────────────────────────────────────────────────────

const isKnown = (v: string | undefined | null): v is string =>
  !!v && v.trim() !== '' && v.trim().toLowerCase() !== 'unknown';

function lowerBound(arr: ChannelSample[], tMs: number): number {
  let a = 0, b = arr.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (arr[m].timestamp < tMs) a = m + 1; else b = m;
  }
  return a;
}

function upperBound(arr: ChannelSample[], tMs: number): number {
  let a = 0, b = arr.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (arr[m].timestamp <= tMs) a = m + 1; else b = m;
  }
  return a;
}

/** Samples within [loMs, hiMs], plus `extra` neighbours on each side. */
function sliceWindow(samples: ChannelSample[], loMs: number, hiMs: number, extra = 0): ChannelSample[] {
  const i0 = Math.max(0, lowerBound(samples, loMs) - extra);
  const i1 = Math.min(samples.length, upperBound(samples, hiMs) + extra);
  return samples.slice(i0, i1);
}

/**
 * Min/max inside the window. Measured samples only; falls back to the
 * interpolated edge values when the window holds no sample at all.
 * `withEdges` also folds in the edge values (used for y-axis scaling so the
 * trace entering/leaving the window stays in view).
 */
function windowMinMax(
  samples: ChannelSample[], x0Ms: number, x1Ms: number, withEdges: boolean,
): { min: number; max: number; count: number } | null {
  if (samples.length === 0) return null;
  let mn = Infinity, mx = -Infinity, count = 0;
  const i0 = lowerBound(samples, x0Ms);
  const i1 = upperBound(samples, x1Ms);
  for (let i = i0; i < i1; i++) {
    const v = samples[i].value;
    if (!isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    count++;
  }
  if (withEdges || count === 0) {
    for (const t of [x0Ms, x1Ms]) {
      const v = interpolateValue(samples, t);
      if (v === null || !isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  return isFinite(mn) ? { min: mn, max: mx, count } : null;
}

/** Tick labels with a fixed number of decimals derived from the tick step. */
function tickFormatter(ticks: number[]): (v: number) => string {
  if (ticks.length < 2) return formatValue;
  const step = Math.abs(ticks[1] - ticks[0]);
  const decimals = clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 6);
  return (v: number) => {
    const t = v.toFixed(decimals);
    return /^-0(\.0+)?$/.test(t) ? t.slice(1) : t;
  };
}

interface Rect { x: number; y: number; w: number; h: number }

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Pick a baseline near `y` where a label of width `w` (left edge `x`) does not
 * collide with labels already placed in this region. Records the result.
 */
function placeLabel(placed: Rect[], x: number, w: number, y: number, minY: number, maxY: number): number {
  const h = 18;
  for (let k = 0; k < 12; k++) {
    const off = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * h;
    const cy = clamp(y + off, minY, maxY);
    const r = { x: x - 3, y: cy - 14, w: w + 6, h };
    if (!placed.some(p => overlaps(p, r))) { placed.push(r); return cy; }
  }
  const cy = clamp(y, minY, maxY);
  placed.push({ x: x - 3, y: cy - 14, w: w + 6, h });
  return cy;
}

function paddedRange(mm: { min: number; max: number } | null): [number, number] {
  if (!mm) return [0, 1];
  const pad = (mm.max - mm.min) * 0.08 || Math.max(Math.abs(mm.max) * 0.05, 0.5);
  return [mm.min - pad, mm.max + pad];
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** Text with a background-coloured halo so it stays legible over traces. */
function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = COLOR.bg;
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 3 : 2)} s`;
  return `${formatLapTime(sec)} (${sec.toFixed(1)} s)`;
}

function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isFullSession(spec: ChartExportSpec): boolean {
  const [x0, x1] = spec.xRange;
  return x0 <= 0.0005 && x1 >= spec.sessionDurationSec - 0.0005;
}

function sanitizeFilePart(s: string): string {
  return s
    .replace(/[^A-Za-z0-9._+-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** `<session file base>_<start>-<end>_<channels>.png`, filesystem-safe. */
export function buildImageFileName(spec: ChartExportSpec): string {
  const base = sanitizeFilePart((spec.fileName || 'session').replace(/\.(xrk|xrz|drk)$/i, '')) || 'session';
  const [x0, x1] = spec.xRange;
  const span = x1 - x0;
  const decimals = span < 2 ? 3 : span < 60 ? 2 : 1;
  const range = `${x0.toFixed(decimals)}s-${x1.toFixed(decimals)}s`;
  const names = spec.channels.map(c => sanitizeFilePart(c.name)).filter(Boolean);
  let chans = names.slice(0, 4).join('-');
  if (names.length > 4) chans += `+${names.length - 4}`;
  const stem = [base, range, chans].filter(Boolean).join('_').slice(0, 160);
  return `${stem}.png`;
}

async function ensureFonts(): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  try {
    await Promise.all([
      fonts.load(`400 16px "JetBrains Mono"`),
      fonts.load(`500 16px "JetBrains Mono"`),
      fonts.load(`400 16px "DM Sans"`),
      fonts.load(`500 16px "DM Sans"`),
      fonts.load(`600 16px "DM Sans"`),
    ]);
  } catch {
    // Offline or blocked: fall back to system fonts.
  }
}

// ─── Plot model ─────────────────────────────────────────────────────────────

interface Region {
  top: number;
  height: number;
  channels: ExportChannel[];
  yRange: [number, number];
  yTicks: number[];
}

interface OverlayAxis {
  units: string;
  channels: ExportChannel[];
  yRange: [number, number];
  yTicks: number[];
  side: 'left' | 'right';
  sideIndex: number;
}

// ─── Renderer ───────────────────────────────────────────────────────────────

export async function renderChartImage(spec: ChartExportSpec): Promise<ChartExportResult> {
  await ensureFonts();

  const channels = spec.channels;
  const n = Math.max(1, channels.length);
  const [x0, x1] = spec.xRange[1] > spec.xRange[0] ? spec.xRange : [spec.xRange[0], spec.xRange[0] + 1];
  const x0Ms = x0 * 1000;
  const x1Ms = x1 * 1000;

  const meta = spec.metadata;
  const metaItems: Array<[string, string]> = [];
  if (isKnown(meta.vehicle)) metaItems.push(['Car', meta.vehicle]);
  if (isKnown(meta.driver)) metaItems.push(['Driver', meta.driver]);
  if (isKnown(meta.venue)) metaItems.push(['Venue', meta.venue]);
  if (isKnown(meta.date)) metaItems.push(['Date', isKnown(meta.time) ? `${meta.date} ${meta.time}` : meta.date]);

  // Per-channel stats inside the window (header) and for scaling (with edges)
  const stats = new Map<number, ReturnType<typeof windowMinMax>>();
  const scaleStats = new Map<number, ReturnType<typeof windowMinMax>>();
  for (const ch of channels) {
    stats.set(ch.channelId, windowMinMax(ch.samples, x0Ms, x1Ms, false));
    scaleStats.set(ch.channelId, windowMinMax(ch.samples, x0Ms, x1Ms, true));
  }

  // ── Vertical layout (independent of text measurement) ──
  const metaBaseline = TITLE_BASELINE + LINE_STEP;
  const legendTop = metaBaseline + LINE_STEP - 4;
  const cols = Math.min(LEG_COLS, n);
  const rows = Math.ceil(n / cols);
  const headerH = legendTop + rows * LEG_H + (rows - 1) * LEG_ROW_GAP + HEADER_BOTTOM_PAD;
  const plotTop = headerH + PLOT_TOP_GAP;
  const availPlotH = BASE_H - plotTop - X_AXIS_H - FOOTER_H;

  const isOverlay = spec.chartMode === 'overlay';
  let stripH = 0;
  let plotH: number;
  if (isOverlay) {
    plotH = Math.max(MIN_OVERLAY_H, availPlotH);
  } else {
    stripH = Math.max(MIN_STRIP_H, (availPlotH - (n - 1) * STRIP_GAP) / n);
    plotH = n * stripH + (n - 1) * STRIP_GAP;
  }
  const H = Math.ceil(plotTop + plotH + X_AXIS_H + FOOTER_H);

  const canvas = document.createElement('canvas');
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.textBaseline = 'alphabetic';

  // ── Regions, axes and horizontal margins ──
  const regions: Region[] = [];
  const overlayAxes: OverlayAxis[] = [];
  if (isOverlay) {
    const byUnit = new Map<string, ExportChannel[]>();
    for (const ch of channels) {
      const u = ch.units || '';
      if (!byUnit.has(u)) byUnit.set(u, []);
      byUnit.get(u)!.push(ch);
    }
    let i = 0;
    for (const [units, chs] of byUnit) {
      let mn = Infinity, mx = -Infinity;
      for (const ch of chs) {
        const s = scaleStats.get(ch.channelId);
        if (s) { mn = Math.min(mn, s.min); mx = Math.max(mx, s.max); }
      }
      const yRange = paddedRange(isFinite(mn) ? { min: mn, max: mx } : null);
      overlayAxes.push({
        units, channels: chs, yRange,
        yTicks: niceAxisTicks(yRange[0], yRange[1], Math.max(4, Math.floor(plotH / 56))),
        side: i % 2 === 0 ? 'left' : 'right',
        sideIndex: Math.floor(i / 2),
      });
      i++;
    }
    regions.push({ top: plotTop, height: plotH, channels, yRange: overlayAxes[0]?.yRange ?? [0, 1], yTicks: overlayAxes[0]?.yTicks ?? [] });
  } else {
    channels.forEach((ch, i) => {
      const yRange = paddedRange(scaleStats.get(ch.channelId) ?? null);
      regions.push({
        top: plotTop + i * (stripH + STRIP_GAP),
        height: stripH,
        channels: [ch],
        yRange,
        yTicks: niceAxisTicks(yRange[0], yRange[1], Math.max(4, Math.floor(stripH / 40))),
      });
    });
  }

  ctx.font = FONT.tick;
  let maxTickW = 0;
  const tickGroups = isOverlay ? overlayAxes.map(a => a.yTicks) : regions.map(r => r.yTicks);
  for (const ticks of tickGroups) {
    const f = tickFormatter(ticks);
    for (const t of ticks) maxTickW = Math.max(maxTickW, ctx.measureText(f(t)).width);
  }
  maxTickW = Math.ceil(maxTickW);

  let lm: number, rm: number;
  const axisW = maxTickW + TICK_GAP + Y_TITLE_BAND + 12;
  if (isOverlay) {
    const leftCount = Math.ceil(overlayAxes.length / 2);
    const rightCount = Math.floor(overlayAxes.length / 2);
    lm = PAD + Math.max(1, leftCount) * axisW;
    rm = PAD + rightCount * axisW;
  } else {
    lm = PAD + Y_TITLE_BAND + maxTickW + TICK_GAP;
    rm = PAD;
  }
  const plotW = W - lm - rm;
  const plotRight = W - rm;
  const timeToX = (tSec: number) => lm + ((tSec - x0) / (x1 - x0)) * plotW;
  const xTicks = niceAxisTicks(x0, x1, Math.max(5, Math.floor(plotW / 150)));
  const tickStep = xTicks.length >= 2 ? xTicks[1] - xTicks[0] : undefined;

  // ── Background ──
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, W, H);

  // ── Header band ──
  ctx.fillStyle = COLOR.band;
  ctx.fillRect(0, 0, W, headerH);
  ctx.strokeStyle = COLOR.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(W, headerH - 0.5);
  ctx.stroke();

  // Right block: window range + duration
  const rangeText = `${formatTime(x0Ms)} – ${formatTime(x1Ms)}`;
  const durText = `${isFullSession(spec) ? 'full session · ' : 'window · '}${formatDuration(x1 - x0)}`;
  ctx.font = FONT.window;
  const rangeW = ctx.measureText(rangeText).width;
  ctx.fillStyle = COLOR.title;
  ctx.textAlign = 'right';
  ctx.fillText(rangeText, W - PAD, TITLE_BASELINE);
  ctx.font = FONT.windowSub;
  const durW = ctx.measureText(durText).width;
  ctx.fillStyle = COLOR.muted;
  ctx.fillText(durText, W - PAD, metaBaseline);
  const rightBlockW = Math.max(rangeW, durW) + 48;

  // Title
  ctx.textAlign = 'left';
  ctx.font = FONT.title;
  ctx.fillStyle = COLOR.title;
  ctx.fillText(fit(ctx, spec.fileName || 'Untitled session', W - 2 * PAD - rightBlockW), PAD, TITLE_BASELINE);

  // Metadata line
  {
    let x = PAD;
    const maxX = W - PAD - rightBlockW;
    if (metaItems.length === 0) {
      ctx.font = FONT.metaLabel;
      ctx.fillStyle = COLOR.faint;
      ctx.fillText('No car / driver / venue metadata in this session', x, metaBaseline);
    }
    for (const [label, value] of metaItems) {
      ctx.font = FONT.metaLabel;
      ctx.fillStyle = COLOR.faint;
      const lw = ctx.measureText(label).width;
      if (x + lw + 40 > maxX) break;
      ctx.fillText(label, x, metaBaseline);
      x += lw + 8;
      ctx.font = FONT.metaValue;
      ctx.fillStyle = COLOR.text;
      const v = fit(ctx, value, maxX - x);
      ctx.fillText(v, x, metaBaseline);
      x += ctx.measureText(v).width + 32;
    }
  }

  // Legend: one entry per channel
  {
    const colW = (W - 2 * PAD) / LEG_COLS;
    channels.forEach((ch, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = PAD + col * colW;
      const y = legendTop + row * (LEG_H + LEG_ROW_GAP);
      const maxW = colW - 28;

      ctx.fillStyle = ch.color;
      ctx.beginPath();
      ctx.roundRect(x, y + 10, 24, 5, 2.5);
      ctx.fill();

      const nameX = x + 36;
      ctx.font = FONT.legendUnit;
      const unitW = ch.units ? Math.min(ctx.measureText(ch.units).width + 10, maxW / 3) : 0;
      ctx.font = FONT.legendName;
      ctx.fillStyle = COLOR.title;
      const name = fit(ctx, ch.name, maxW - 36 - unitW);
      ctx.fillText(name, nameX, y + 18);
      if (ch.units) {
        const nw = ctx.measureText(name).width;
        ctx.font = FONT.legendUnit;
        ctx.fillStyle = COLOR.muted;
        ctx.fillText(fit(ctx, ch.units, maxW - 36 - nw - 10), nameX + nw + 10, y + 18);
      }

      const st = stats.get(ch.channelId);
      let sx = nameX;
      const sy = y + 44;
      if (!st) {
        ctx.font = FONT.legendLabel;
        ctx.fillStyle = COLOR.faint;
        ctx.fillText('no data in window', sx, sy);
        return;
      }
      for (const [label, v] of [['min', st.min], ['max', st.max]] as Array<[string, number]>) {
        ctx.font = FONT.legendLabel;
        ctx.fillStyle = COLOR.faint;
        ctx.fillText(label, sx, sy);
        sx += ctx.measureText(label).width + 8;
        ctx.font = FONT.legendValue;
        ctx.fillStyle = COLOR.text;
        const vt = formatValue(v);
        ctx.fillText(vt, sx, sy);
        sx += ctx.measureText(vt).width + 24;
      }
    });
  }

  // ── Plot regions ──
  const lapsInView = spec.lapMarkers
    .map((lap, i) => ({ t: lap.timestamp / 1000, label: `L${i + 1}` }))
    .filter(l => l.t >= x0 && l.t <= x1);

  const valToYFor = (region: Region, yRange: [number, number]) => {
    const span = yRange[1] - yRange[0] || 1;
    return (v: number) =>
      region.top + region.height - TRACE_INSET - ((v - yRange[0]) / span) * (region.height - 2 * TRACE_INSET);
  };

  regions.forEach((region, ri) => {
    const { top, height } = region;
    const placed: Rect[] = [];
    const gridValToY = valToYFor(region, region.yRange);

    // Grid
    ctx.strokeStyle = COLOR.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const yt of region.yTicks) {
      const y = Math.round(gridValToY(yt)) + 0.5;
      ctx.moveTo(lm, y);
      ctx.lineTo(plotRight, y);
    }
    for (const xt of xTicks) {
      const x = Math.round(timeToX(xt)) + 0.5;
      if (x >= lm && x <= plotRight) {
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + height);
      }
    }
    ctx.stroke();

    // Lap markers
    if (lapsInView.length > 0) {
      ctx.strokeStyle = COLOR.lap;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      for (const l of lapsInView) {
        const x = Math.round(timeToX(l.t)) + 0.5;
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + height);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Traces (clipped to the plot rectangle)
    for (const ch of region.channels) {
      const yRange = isOverlay
        ? overlayAxes.find(a => a.units === (ch.units || ''))?.yRange ?? region.yRange
        : region.yRange;
      const valToY = valToYFor(region, yRange);
      const pad = (x1 - x0) * 0.02;
      const visible = sliceWindow(ch.samples, (x0 - pad) * 1000, (x1 + pad) * 1000, 1);
      const ds = minMaxTrace(visible, timeToX, plotW);

      ctx.save();
      ctx.beginPath();
      ctx.rect(lm, top, plotW, height);
      ctx.clip();
      if (ds.length > 1) {
        ctx.strokeStyle = ch.color;
        ctx.lineWidth = LINE_WIDTH;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        let started = false;
        for (const s of ds) {
          if (!isFinite(s.value)) { started = false; continue; }
          const x = timeToX(s.timestamp / 1000);
          const y = valToY(s.value);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // Sample dots when zoomed in tight (same rule as the app, scaled)
      const inWindow = stats.get(ch.channelId)?.count ?? 0;
      if (inWindow > 1 && inWindow <= plotW / 6) {
        ctx.fillStyle = ch.color;
        ctx.beginPath();
        for (const s of visible) {
          if (!isFinite(s.value)) continue;
          const x = timeToX(s.timestamp / 1000);
          const y = valToY(s.value);
          ctx.moveTo(x + 3.5, y);
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.restore();
    }

    // Lap labels on the first region
    if (ri === 0 && lapsInView.length > 0) {
      ctx.font = FONT.lap;
      ctx.fillStyle = COLOR.lapText;
      ctx.textAlign = 'left';
      for (const l of lapsInView) {
        const x = timeToX(l.t) + 6;
        if (x < plotRight - 20) {
          haloText(ctx, l.label, x, top + 18);
          placed.push({ x: x - 3, y: top + 4, w: ctx.measureText(l.label).width + 6, h: 18 });
        }
      }
    }

    // Whole-session min/max markers, drawn last so labels sit on top
    for (const ch of region.channels) {
      const yRange = isOverlay
        ? overlayAxes.find(a => a.units === (ch.units || ''))?.yRange ?? region.yRange
        : region.yRange;
      drawMinMaxMarkers(ctx, ch, region, valToYFor(region, yRange), timeToX, lm, plotRight, placed);
    }

    // Y-axis (separate mode: one per strip)
    if (!isOverlay) {
      const ch = region.channels[0];
      const fmtTick = tickFormatter(region.yTicks);
      ctx.font = FONT.tick;
      ctx.fillStyle = ch.color;
      ctx.textAlign = 'right';
      for (const yt of region.yTicks) {
        const y = gridValToY(yt);
        if (y >= top + 8 && y <= top + height - 4) ctx.fillText(fmtTick(yt), lm - TICK_GAP, y + 5);
      }
      ctx.save();
      ctx.font = FONT.axisTitle;
      ctx.fillStyle = ch.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(PAD + 10, top + height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(fit(ctx, ch.name + (ch.units ? ` (${ch.units})` : ''), height - 12), 0, 0);
      ctx.restore();
    }
  });

  // Overlay y-axes: one per unit, alternating left/right
  if (isOverlay) {
    const region = regions[0];
    for (const axis of overlayAxes) {
      const valToY = valToYFor(region, axis.yRange);
      const single = axis.channels.length === 1 ? axis.channels[0] : null;
      const color = single ? single.color : COLOR.muted;
      const isLeft = axis.side === 'left';
      const fmtTick = tickFormatter(axis.yTicks);
      const tickX = isLeft
        ? lm - TICK_GAP - axis.sideIndex * axisW
        : plotRight + TICK_GAP + axis.sideIndex * axisW;
      ctx.font = FONT.tick;
      ctx.fillStyle = color;
      ctx.textAlign = isLeft ? 'right' : 'left';
      for (const yt of axis.yTicks) {
        const y = valToY(yt);
        if (y >= region.top + 8 && y <= region.top + region.height - 4) ctx.fillText(fmtTick(yt), tickX, y + 5);
      }
      const titleX = isLeft ? tickX - maxTickW - 18 : tickX + maxTickW + 18;
      const title = single
        ? single.name + (single.units ? ` (${single.units})` : '')
        : (axis.units || axis.channels.map(c => c.name).join(', '));
      ctx.save();
      ctx.font = FONT.axisTitle;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(titleX, region.top + region.height / 2);
      ctx.rotate(isLeft ? -Math.PI / 2 : Math.PI / 2);
      ctx.fillText(fit(ctx, title, region.height - 12), 0, 0);
      ctx.restore();
    }
  }

  // ── X-axis ──
  const axisY = plotTop + plotH;
  ctx.strokeStyle = COLOR.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lm, Math.round(axisY) + 0.5);
  ctx.lineTo(plotRight, Math.round(axisY) + 0.5);
  for (const xt of xTicks) {
    const x = Math.round(timeToX(xt)) + 0.5;
    if (x >= lm && x <= plotRight) {
      ctx.moveTo(x, axisY);
      ctx.lineTo(x, axisY + 6);
    }
  }
  ctx.stroke();

  ctx.font = FONT.tick;
  ctx.fillStyle = COLOR.muted;
  ctx.textAlign = 'center';
  for (const xt of xTicks) {
    const x = timeToX(xt);
    if (x >= lm && x <= plotRight) ctx.fillText(formatTimeSec(xt, tickStep), x, axisY + 28);
  }
  ctx.font = FONT.axisTitle;
  ctx.fillStyle = COLOR.muted;
  ctx.fillText('Session time', lm + plotW / 2, axisY + 58);

  // ── Footer ──
  const footerY = H - 26;
  ctx.textAlign = 'left';
  ctx.font = FONT.footer;
  ctx.fillStyle = COLOR.faint;
  ctx.fillText('QuickScope', PAD, footerY);
  ctx.textAlign = 'right';
  ctx.font = FONT.footerDate;
  ctx.fillText(`Exported ${formatStamp(spec.exportedAt)}`, W - PAD, footerY);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });

  return { blob, fileName: buildImageFileName(spec), width: W, height: H, pixelRatio: DPR };
}

/**
 * Whole-session min/max markers, as on screen: a triangle at the sample when
 * it is inside the window, an edge arrow (labelled "out of view") when not.
 */
function drawMinMaxMarkers(
  ctx: CanvasRenderingContext2D,
  ch: ExportChannel,
  region: Region,
  valToY: (v: number) => number,
  timeToX: (tSec: number) => number,
  left: number,
  right: number,
  placed: Rect[],
) {
  const bright = brightenColor(ch.color, 0.3);
  const { top, height } = region;

  const draw = (sample: ChannelSample | null, isMax: boolean) => {
    if (!sample || !isFinite(sample.value)) return;
    const x = timeToX(sample.timestamp / 1000);
    const y = valToY(sample.value);
    const word = isMax ? 'max' : 'min';
    ctx.font = FONT.marker;
    ctx.fillStyle = bright;

    if (x >= left && x <= right) {
      ctx.beginPath();
      if (isMax) {
        ctx.moveTo(x, y - 10); ctx.lineTo(x - 6, y - 1); ctx.lineTo(x + 6, y - 1);
      } else {
        ctx.moveTo(x, y + 10); ctx.lineTo(x - 6, y + 1); ctx.lineTo(x + 6, y + 1);
      }
      ctx.closePath();
      ctx.fill();
      const label = `${word} ${formatValue(sample.value)}`;
      const tw = ctx.measureText(label).width;
      let tx = x + 12;
      if (tx + tw > right - 4) tx = x - 12 - tw;
      const ty = placeLabel(placed, tx, tw, isMax ? y - 4 : y + 16, top + 16, top + height - 4);
      ctx.textAlign = 'left';
      haloText(ctx, label, tx, ty);
    } else {
      const toLeft = x < left;
      const dir = toLeft ? 1 : -1;
      const edgeX = toLeft ? left + 4 : right - 4;
      const label = `${word} ${formatValue(sample.value)} (out of view)`;
      const tw = ctx.measureText(label).width;
      const tx = edgeX + dir * 15;
      const ty = placeLabel(placed, toLeft ? tx : tx - tw, tw, clamp(y, top + 14, top + height - 10) + 5, top + 16, top + height - 4);
      const ey = ty - 5;
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(edgeX, ey);
      ctx.lineTo(edgeX + dir * 9, ey - 6);
      ctx.lineTo(edgeX + dir * 9, ey + 6);
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = toLeft ? 'left' : 'right';
      haloText(ctx, label, tx, ty);
      ctx.restore();
    }
  };

  draw(ch.globalMax, true);
  draw(ch.globalMin, false);
}
