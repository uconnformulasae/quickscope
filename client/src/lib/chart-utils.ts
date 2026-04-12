/**
 * Shared types, constants, and pure helper functions for the telemetry chart.
 */
import type { ChannelSample } from './xrk-parser';
import type { ActiveChannel, TimeRange, DerivedChannel, ChartMode } from './useXRKStore';
import type { XRKSession } from './xrk-parser';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TelemetryChartProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  viewRange: TimeRange | null;
  onViewRangeChange: (range: TimeRange | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
  cursorTime?: number | null;
  onCursorTimeChange?: (t: number | null) => void;
  chartMode?: ChartMode;
}

export interface StripLayout {
  top: number;
  height: number;
  channelId: number;
  color: string;
  label: string;
  units: string;
}

/** Shared context passed to all chart drawing functions */
export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  lm: number; // left margin
  rm: number; // right margin
  plotW: number;
  xRange: [number, number];
  xTicks: number[];
  strips: StripLayout[];
  channelDataMap: Map<number, { def: { shortName: string; units: string; color: string }; allSamples: ChannelSample[] }>;
  chartMode: ChartMode;
  sharedYRanges: Map<string, [number, number]>;
  timeToX: (t: number, xRange: [number, number], plotW: number) => number;
  getVisibleSamples: (channelId: number, allSamples: ChannelSample[], xRange: [number, number], canvasWidth: number) => ChannelSample[];
  overlayAxisLayout: { unitAxes: Map<string, { side: 'left' | 'right'; sideIndex: number }>; axisCount: number };
  session: XRKSession;
  smoothedYRanges: Map<string, [number, number]>;
  needsDrawRef: { current: boolean };
  colors: ChartColors;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const LEFT_MARGIN = 60;
export const RIGHT_MARGIN = 12;
export const BOTTOM_AXIS_HEIGHT = 36;
export const MIN_STRIP_HEIGHT = 140;
export const AXIS_WIDTH = 50;
export const MONO_FONT = 'JetBrains Mono, monospace';

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

export const DEBOUNCE_MS = 100;

// ─── Pure Helpers ───────────────────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Given a sorted-by-timestamp sample array, find the index of the nearest sample to `t`. */
/** Interpolate value at time `t` given sorted samples.
 *  Finds the bracketing pair that `t` falls between and lerps. */
export function interpolateValue(samples: ChannelSample[], tMs: number): number | null {
  if (samples.length === 0) return null;
  if (tMs <= samples[0].timestamp) return samples[0].value;
  if (tMs >= samples[samples.length - 1].timestamp) return samples[samples.length - 1].value;
  // Binary search for the first index where timestamp >= tMs
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].timestamp < tMs) lo = mid + 1;
    else hi = mid;
  }
  // lo is now the first index >= tMs; interpolate between lo-1 and lo
  if (lo <= 0) return samples[0].value;
  const a = samples[lo - 1];
  const b = samples[lo];
  if (b.timestamp === a.timestamp) return a.value;
  const frac = (tMs - a.timestamp) / (b.timestamp - a.timestamp);
  return a.value + frac * (b.value - a.value);
}

/** Snap to nearest real sample and return its value + timestamp. */
export function nearestSample(samples: ChannelSample[], tMs: number): ChannelSample | null {
  if (samples.length === 0) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].timestamp < tMs) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first index >= tMs; check lo-1 in case it's closer
  if (lo > 0 && Math.abs(samples[lo - 1].timestamp - tMs) < Math.abs(samples[lo].timestamp - tMs)) {
    return samples[lo - 1];
  }
  return samples[lo];
}

export function brightenColor(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const nr = clamp(Math.round(r + (255 - r) * amount), 0, 255);
  const ng = clamp(Math.round(g + (255 - g) * amount), 0, 255);
  const nb = clamp(Math.round(b + (255 - b) * amount), 0, 255);
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

/** Generate nice tick values for a range. */
export function niceAxisTicks(min: number, max: number, maxTicks: number): number[] {
  const range = max - min;
  if (range <= 0 || !isFinite(range)) return [min];

  const roughStep = range / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / mag;
  let niceStep: number;
  if (residual <= 1.5) niceStep = 1 * mag;
  else if (residual <= 3) niceStep = 2 * mag;
  else if (residual <= 7) niceStep = 5 * mag;
  else niceStep = 10 * mag;

  const ticks: number[] = [];
  const start = Math.ceil(min / niceStep) * niceStep;
  for (let v = start; v <= max + niceStep * 0.001; v += niceStep) {
    ticks.push(v);
  }
  return ticks;
}

/** Format a value compactly. */
export function formatValue(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 10000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Format time in seconds for the x-axis.
 *  Precision adapts to tick spacing so zoomed-in views show milliseconds. */
export function formatTimeSec(sec: number, tickStep?: number): string {
  // Determine decimal places from tick spacing
  let decimals = 1;
  if (tickStep !== undefined) {
    if (tickStep < 0.095) decimals = 3;
    else if (tickStep < 0.95) decimals = 2;
  }

  const mins = Math.floor(sec / 60);
  const secs = sec % 60;
  if (mins > 0) {
    return `${mins}:${secs.toFixed(decimals).padStart(decimals + 3, '0')}`;
  }
  return secs.toFixed(decimals) + 's';
}
