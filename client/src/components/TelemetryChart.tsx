import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { XRKSession } from '../lib/xrk-parser';
import { lttbDownsample, formatTime } from '../lib/xrk-parser';
import type { ActiveChannel, TimeRange, DerivedChannel } from '../lib/useXRKStore';
import type { ChannelSample } from '../lib/xrk-parser';
import { RotateCcw } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TelemetryChartProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  viewRange: TimeRange | null;
  onViewRangeChange: (range: TimeRange | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
  cursorTime?: number | null; // seconds — externally driven cursor position
  onCursorTimeChange?: (t: number | null) => void;
}

interface StripLayout {
  top: number;
  height: number;
  channelId: number;
  color: string;
  label: string;
  units: string;
}

interface DownsampleCache {
  xRangeKey: string;
  channelId: number;
  samples: ChannelSample[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const LEFT_MARGIN = 60;
const RIGHT_MARGIN = 12;
const BOTTOM_AXIS_HEIGHT = 36;
const MIN_STRIP_HEIGHT = 140;
const MONO_FONT = 'JetBrains Mono, monospace';

const GRID_COLOR = 'rgba(255,255,255,0.05)';
const SEPARATOR_COLOR = 'rgba(255,255,255,0.08)';
const TEXT_COLOR = '#8b93a8';
const CURSOR_COLOR = 'rgba(255,255,255,0.5)';
const CURSOR_PILL_BG = 'rgba(13,14,20,0.9)';
const DELTA_FILL = 'rgba(34,211,238,0.08)';
const DELTA_LINE = 'rgba(34,211,238,0.4)';
const DELTA_PANEL_BG = 'rgba(13,14,20,0.95)';

const DEBOUNCE_MS = 100;

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Given a sorted-by-timestamp sample array, find the index of the nearest sample to `t`. */
function nearestSampleIndex(samples: ChannelSample[], t: number): number {
  if (samples.length === 0) return -1;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  // Check lo-1 in case it's closer
  if (lo > 0 && Math.abs(samples[lo - 1].timestamp - t) < Math.abs(samples[lo].timestamp - t)) {
    return lo - 1;
  }
  return lo;
}

/** Interpolate value at time `t` given sorted samples. */
function interpolateValue(samples: ChannelSample[], tMs: number): number | null {
  if (samples.length === 0) return null;
  if (tMs <= samples[0].timestamp) return samples[0].value;
  if (tMs >= samples[samples.length - 1].timestamp) return samples[samples.length - 1].value;
  const idx = nearestSampleIndex(samples, tMs);
  if (idx <= 0) return samples[0].value;
  // Linear interpolation between idx-1 and idx
  const a = samples[idx - 1];
  const b = samples[idx];
  if (b.timestamp === a.timestamp) return a.value;
  const frac = (tMs - a.timestamp) / (b.timestamp - a.timestamp);
  return a.value + frac * (b.value - a.value);
}

function brightenColor(hex: string, amount: number): string {
  // Parse hex color and brighten
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const nr = clamp(Math.round(r + (255 - r) * amount), 0, 255);
  const ng = clamp(Math.round(g + (255 - g) * amount), 0, 255);
  const nb = clamp(Math.round(b + (255 - b) * amount), 0, 255);
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

/** Generate nice tick values for a range. */
function niceAxisTicks(min: number, max: number, maxTicks: number): number[] {
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
function formatValue(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 10000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Format time in seconds for the x-axis. */
function formatTimeSec(sec: number): string {
  const mins = Math.floor(sec / 60);
  const secs = sec % 60;
  if (mins > 0) {
    return `${mins}:${secs.toFixed(1).padStart(4, '0')}`;
  }
  return secs.toFixed(1) + 's';
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TelemetryChart({
  session,
  activeChannels,
  viewRange,
  onViewRangeChange,
  derivedChannels,
  derivedSamplesMap,
  cursorTime,
  onCursorTimeChange,
}: TelemetryChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [deltaMode, setDeltaMode] = useState(false);
  const [cursorStyle, setCursorStyle] = useState<string>('crosshair');

  // ─── Refs for transient state (no React re-renders) ─────────────────────
  const xRangeRef = useRef<[number, number] | null>(null); // seconds
  const cursorXRef = useRef<number | null>(null); // seconds (placed cursor A)
  const cursor2XRef = useRef<number | null>(null); // seconds (placed cursor B, delta mode)
  const hoverXRef = useRef<number | null>(null); // seconds (live mouse position, always tracks)
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ mouseX: number; xRange: [number, number] } | null>(null);
  const canvasSizeRef = useRef({ w: 0, h: 0 });
  const rafIdRef = useRef<number>(0);
  const needsDrawRef = useRef(true);
  const deltaModeRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cache for downsampled data
  const dsCache = useRef<Map<number, DownsampleCache>>(new Map());

  // Cache for global min/max per channel (recomputed when channelDataMap changes)
  const globalMinMaxCache = useRef<Map<number, { minSample: ChannelSample; maxSample: ChannelSample }>>(new Map());

  // Touch gesture refs
  const touchStartRef = useRef<{ x: number; y: number; t: number; xRange: [number, number] } | null>(null);
  const pinchStartRef = useRef<{ distance: number; xRange: [number, number]; centerX: number } | null>(null);

  // ─── Derived data ───────────────────────────────────────────────────────
  const visibleChannels = useMemo(
    () => activeChannels.filter(ac => ac.visible),
    [activeChannels],
  );

  const sessionDuration = session.durationMs / 1000; // seconds

  // Resolve channels: get definition + all samples for each visible channel
  const channelDataMap = useMemo(() => {
    const map = new Map<number, { def: { shortName: string; units: string; color: string }; allSamples: ChannelSample[] }>();
    for (const ac of visibleChannels) {
      const sessionChan = session.channels.get(ac.channelId);
      if (sessionChan) {
        map.set(ac.channelId, {
          def: { shortName: sessionChan.shortName, units: sessionChan.units, color: ac.color },
          allSamples: session.samples.get(ac.channelId) || [],
        });
        continue;
      }
      // Check derived
      const dc = derivedChannels?.find(d => d.id === ac.channelId);
      if (dc) {
        map.set(ac.channelId, {
          def: { shortName: dc.name, units: dc.units, color: ac.color },
          allSamples: derivedSamplesMap?.get(ac.channelId) || [],
        });
      }
    }
    return map;
  }, [visibleChannels, session, derivedChannels, derivedSamplesMap]);

  // ─── Rebuild global min/max cache when channel data changes ─────────────
  useEffect(() => {
    const newCache = new Map<number, { minSample: ChannelSample; maxSample: ChannelSample }>();
    for (const [channelId, { allSamples }] of channelDataMap) {
      if (allSamples.length === 0) continue;
      let minSample = allSamples[0];
      let maxSample = allSamples[0];
      for (const s of allSamples) {
        if (s.value < minSample.value) minSample = s;
        if (s.value > maxSample.value) maxSample = s;
      }
      newCache.set(channelId, { minSample, maxSample });
    }
    globalMinMaxCache.current = newCache;
    needsDrawRef.current = true;
  }, [channelDataMap]);

  // ─── Sync external cursorTime prop → internal cursorXRef ──────────────
  useEffect(() => {
    if (cursorTime !== undefined && cursorTime !== null) {
      cursorXRef.current = cursorTime;
      needsDrawRef.current = true;
    }
  }, [cursorTime]);

  // ─── Sync external viewRange → internal xRange ─────────────────────────
  useEffect(() => {
    if (!viewRange) {
      xRangeRef.current = null;
    } else {
      xRangeRef.current = [viewRange.startMs / 1000, viewRange.endMs / 1000];
    }
    needsDrawRef.current = true;
  }, [viewRange]);

  // ─── Keep deltaMode ref in sync ────────────────────────────────────────
  useEffect(() => {
    deltaModeRef.current = deltaMode;
    // When turning delta mode off, clear cursor2
    if (!deltaMode) {
      cursor2XRef.current = null;
      needsDrawRef.current = true;
    }
  }, [deltaMode]);

  // ─── Debounced onViewRangeChange ───────────────────────────────────────
  const emitViewRange = useCallback((range: [number, number] | null) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      if (!range) {
        onViewRangeChange(null);
      } else {
        onViewRangeChange({ startMs: range[0] * 1000, endMs: range[1] * 1000 });
      }
    }, DEBOUNCE_MS);
  }, [onViewRangeChange]);

  // ─── Downsampling helper ───────────────────────────────────────────────
  const getDownsampled = useCallback((
    channelId: number,
    allSamples: ChannelSample[],
    xRange: [number, number],
    canvasWidth: number,
  ): ChannelSample[] => {
    const targetPoints = Math.min(canvasWidth * 2, 4000);
    // Filter to visible range (with small padding for context)
    const rangePad = (xRange[1] - xRange[0]) * 0.02;
    const lo = (xRange[0] - rangePad) * 1000; // to ms
    const hi = (xRange[1] + rangePad) * 1000;

    // Binary search for start
    let startIdx = 0;
    {
      let a = 0, b = allSamples.length - 1;
      while (a < b) {
        const m = (a + b) >> 1;
        if (allSamples[m].timestamp < lo) a = m + 1;
        else b = m;
      }
      startIdx = Math.max(0, a - 1);
    }
    // Binary search for end
    let endIdx = allSamples.length - 1;
    {
      let a = startIdx, b = allSamples.length - 1;
      while (a < b) {
        const m = (a + b + 1) >> 1;
        if (allSamples[m].timestamp > hi) b = m - 1;
        else a = m;
      }
      endIdx = Math.min(allSamples.length - 1, a + 1);
    }

    const slice = allSamples.slice(startIdx, endIdx + 1);
    const cacheKey = `${xRange[0].toFixed(4)}_${xRange[1].toFixed(4)}_${slice.length}`;
    const cached = dsCache.current.get(channelId);
    if (cached && cached.xRangeKey === cacheKey) {
      return cached.samples;
    }

    const ds = lttbDownsample(slice, targetPoints);
    dsCache.current.set(channelId, { xRangeKey: cacheKey, channelId, samples: ds });
    return ds;
  }, []);

  // ─── Compute strip layout ─────────────────────────────────────────────
  const computeStripLayouts = useCallback((canvasH: number): StripLayout[] => {
    const plotH = canvasH - BOTTOM_AXIS_HEIGHT;
    const numCh = visibleChannels.length;
    if (numCh === 0) return [];
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
  }, [visibleChannels, channelDataMap]);

  // ─── Time ↔ Pixel conversions ─────────────────────────────────────────
  const timeToX = useCallback((t: number, xRange: [number, number], plotW: number): number => {
    return LEFT_MARGIN + ((t - xRange[0]) / (xRange[1] - xRange[0])) * plotW;
  }, []);

  const xToTime = useCallback((px: number, xRange: [number, number], plotW: number): number => {
    return xRange[0] + ((px - LEFT_MARGIN) / plotW) * (xRange[1] - xRange[0]);
  }, []);

  // ─── DRAW ─────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvasSizeRef.current.w;
    const h = canvasSizeRef.current.h;
    if (w === 0 || h === 0) return;

    const xRange: [number, number] = xRangeRef.current || [0, sessionDuration];
    const plotW = w - LEFT_MARGIN - RIGHT_MARGIN;
    const strips = computeStripLayouts(h);

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // ── X axis ticks (shared) ──
    const xTicks = niceAxisTicks(xRange[0], xRange[1], Math.max(5, Math.floor(plotW / 80)));

    // ── Draw each strip ──
    for (const strip of strips) {
      const data = channelDataMap.get(strip.channelId);
      if (!data) continue;

      const { allSamples, def } = data;
      const ds = allSamples.length > 0
        ? getDownsampled(strip.channelId, allSamples, xRange, plotW)
        : [];

      // Compute Y range for this strip from visible samples
      let yMin = Infinity, yMax = -Infinity;
      for (const s of ds) {
        if (s.value < yMin) yMin = s.value;
        if (s.value > yMax) yMax = s.value;
      }
      if (!isFinite(yMin)) { yMin = 0; yMax = 1; }
      // Add 8% padding
      const yPad = (yMax - yMin) * 0.08 || 0.5;
      yMin -= yPad;
      yMax += yPad;

      const valToY = (v: number) =>
        strip.top + strip.height - 4 - ((v - yMin) / (yMax - yMin)) * (strip.height - 8);

      // ── Background grid (horizontal) ──
      const yTicks = niceAxisTicks(yMin, yMax, Math.max(2, Math.floor(strip.height / 30)));
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const yt of yTicks) {
        const y = Math.round(valToY(yt)) + 0.5;
        ctx.moveTo(LEFT_MARGIN, y);
        ctx.lineTo(w - RIGHT_MARGIN, y);
      }
      ctx.stroke();

      // ── Vertical grid (x axis) ──
      ctx.beginPath();
      for (const xt of xTicks) {
        const x = Math.round(timeToX(xt, xRange, plotW)) + 0.5;
        if (x >= LEFT_MARGIN && x <= w - RIGHT_MARGIN) {
          ctx.moveTo(x, strip.top);
          ctx.lineTo(x, strip.top + strip.height);
        }
      }
      ctx.stroke();

      // ── Lap markers ──
      ctx.strokeStyle = 'rgba(247,127,0,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (const lap of session.lapMarkers) {
        const lt = lap.timestamp / 1000; // ms to seconds
        if (lt >= xRange[0] && lt <= xRange[1]) {
          const x = Math.round(timeToX(lt, xRange, plotW)) + 0.5;
          ctx.moveTo(x, strip.top);
          ctx.lineTo(x, strip.top + strip.height);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Lap labels (only for first strip)
      if (strip === strips[0]) {
        ctx.font = `9px ${MONO_FONT}`;
        ctx.fillStyle = '#f77f00';
        ctx.textAlign = 'center';
        session.lapMarkers.forEach((lap, i) => {
          const lt = lap.timestamp / 1000;
          if (lt >= xRange[0] && lt <= xRange[1]) {
            const x = timeToX(lt, xRange, plotW);
            ctx.fillText(`L${i + 1}`, x, strip.top + 10);
          }
        });
      }

      // ── Draw line trace ──
      if (ds.length > 1) {
        ctx.strokeStyle = strip.color;
        ctx.lineWidth = 2.0;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        for (const s of ds) {
          const x = timeToX(s.timestamp / 1000, xRange, plotW);
          const y = valToY(s.value);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // ── Min/Max markers (global — from full dataset) ──
      {
        const globalMM = globalMinMaxCache.current.get(strip.channelId);
        if (globalMM) {
          const { minSample, maxSample } = globalMM;
          const bright = brightenColor(strip.color, 0.3);
          const chartLeft = LEFT_MARGIN;
          const chartRight = w - RIGHT_MARGIN;

          const drawMinMaxMarker = (
            sample: ChannelSample,
            isMax: boolean,
          ) => {
            const tSec = sample.timestamp / 1000;
            const rawX = timeToX(tSec, xRange, plotW);
            const inView = rawX >= chartLeft && rawX <= chartRight;
            const markerY = valToY(sample.value);

            ctx.fillStyle = bright;
            ctx.font = `8px ${MONO_FONT}`;

            if (inView) {
              // Draw triangle at actual position
              ctx.beginPath();
              if (isMax) {
                ctx.moveTo(rawX, markerY - 5);
                ctx.lineTo(rawX - 3, markerY);
                ctx.lineTo(rawX + 3, markerY);
              } else {
                ctx.moveTo(rawX, markerY + 5);
                ctx.lineTo(rawX - 3, markerY);
                ctx.lineTo(rawX + 3, markerY);
              }
              ctx.closePath();
              ctx.fill();
              ctx.textAlign = 'left';
              ctx.fillText(`${isMax ? '▲' : '▼'} ${formatValue(sample.value)}`, rawX + 5, markerY + 3);
            } else {
              // Off-screen: draw edge indicator with arrow
              const edgeX = rawX < chartLeft ? chartLeft + 4 : chartRight - 4;
              const edgeY = clamp(markerY, strip.top + 8, strip.top + strip.height - 8);
              const arrowDir = rawX < chartLeft ? 1 : -1; // +1 points right, -1 left
              ctx.globalAlpha = 0.7;
              // Arrow head
              ctx.beginPath();
              ctx.moveTo(edgeX + arrowDir * 6, edgeY);
              ctx.lineTo(edgeX + arrowDir * 2, edgeY - 4);
              ctx.lineTo(edgeX + arrowDir * 2, edgeY + 4);
              ctx.closePath();
              ctx.fill();
              // Value label
              ctx.textAlign = arrowDir > 0 ? 'left' : 'right';
              ctx.fillText(`${isMax ? '▲' : '▼'} ${formatValue(sample.value)}`,
                edgeX + arrowDir * 9, edgeY + 3);
              ctx.globalAlpha = 1;
            }
          };

          drawMinMaxMarker(maxSample, true);
          drawMinMaxMarker(minSample, false);
        }
      }

      // ── Y-axis ticks and labels ──
      ctx.font = `10px ${MONO_FONT}`;
      ctx.fillStyle = strip.color;
      ctx.textAlign = 'right';
      for (const yt of yTicks) {
        const y = valToY(yt);
        if (y >= strip.top + 5 && y <= strip.top + strip.height - 5) {
          ctx.fillText(formatValue(yt), LEFT_MARGIN - 5, y + 3);
        }
      }

      // ── Channel name (rotated on left margin) ──
      ctx.save();
      ctx.font = `bold 10px ${MONO_FONT}`;
      ctx.fillStyle = strip.color;
      ctx.textAlign = 'center';
      ctx.translate(12, strip.top + strip.height / 2);
      ctx.rotate(-Math.PI / 2);
      // Clip text
      const maxChars = Math.floor(strip.height / 6);
      let nameText = strip.label;
      if (nameText.length > maxChars) nameText = nameText.slice(0, maxChars - 1) + '…';
      ctx.fillText(nameText, 0, 0);
      ctx.restore();

      // ── Strip separator ──
      ctx.strokeStyle = SEPARATOR_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const sepY = Math.round(strip.top + strip.height) + 0.5;
      ctx.moveTo(0, sepY);
      ctx.lineTo(w, sepY);
      ctx.stroke();
    }

    // ── Bottom X axis ──
    const axisY = strips.length > 0
      ? strips[strips.length - 1].top + strips[strips.length - 1].height
      : h - BOTTOM_AXIS_HEIGHT;

    ctx.strokeStyle = SEPARATOR_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LEFT_MARGIN, Math.round(axisY) + 0.5);
    ctx.lineTo(w - RIGHT_MARGIN, Math.round(axisY) + 0.5);
    ctx.stroke();

    ctx.font = `10px ${MONO_FONT}`;
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'center';
    for (const xt of xTicks) {
      const x = timeToX(xt, xRange, plotW);
      if (x >= LEFT_MARGIN && x <= w - RIGHT_MARGIN) {
        // Tick mark
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, axisY);
        ctx.lineTo(Math.round(x) + 0.5, axisY + 5);
        ctx.stroke();
        // Label
        ctx.fillText(formatTimeSec(xt), x, axisY + 18);
      }
    }

    // "Time (s)" label
    ctx.font = `9px ${MONO_FONT}`;
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'right';
    ctx.fillText('Time (s)', w - RIGHT_MARGIN, axisY + 30);

    // ── Cursor overlays ──
    const cursorA = cursorXRef.current;
    const cursorB = cursor2XRef.current;

    // Delta region fill
    if (cursorA !== null && cursorB !== null) {
      const xA = timeToX(cursorA, xRange, plotW);
      const xB = timeToX(cursorB, xRange, plotW);
      const left = Math.max(LEFT_MARGIN, Math.min(xA, xB));
      const right = Math.min(w - RIGHT_MARGIN, Math.max(xA, xB));
      ctx.fillStyle = DELTA_FILL;
      ctx.fillRect(left, 0, right - left, axisY);
    }

    // Draw cursor lines
    const drawCursorLine = (t: number, color: string) => {
      const x = Math.round(timeToX(t, xRange, plotW)) + 0.5;
      if (x < LEFT_MARGIN || x > w - RIGHT_MARGIN) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, axisY);
      ctx.stroke();
    };

    if (cursorA !== null) {
      const lineColor = cursorB !== null ? DELTA_LINE : CURSOR_COLOR;
      drawCursorLine(cursorA, lineColor);

      // Value readouts for cursor A
      for (const strip of strips) {
        const data = channelDataMap.get(strip.channelId);
        if (!data || data.allSamples.length === 0) continue;

        const tMs = cursorA * 1000;
        const val = interpolateValue(data.allSamples, tMs);
        if (val === null) continue;

        const yMin_s = (() => {
          const ds = getDownsampled(strip.channelId, data.allSamples, xRange, plotW);
          let mn = Infinity, mx = -Infinity;
          for (const s of ds) { if (s.value < mn) mn = s.value; if (s.value > mx) mx = s.value; }
          if (!isFinite(mn)) { mn = 0; mx = 1; }
          const pad = (mx - mn) * 0.08 || 0.5;
          return [mn - pad, mx + pad] as [number, number];
        })();

        const valToY_c = (v: number) =>
          strip.top + strip.height - 4 - ((v - yMin_s[0]) / (yMin_s[1] - yMin_s[0])) * (strip.height - 8);

        const dotX = timeToX(cursorA, xRange, plotW);
        const dotY = valToY_c(val);

        // Dot on trace
        ctx.fillStyle = strip.color;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
        ctx.fill();

        // Value pill on right edge
        const pillText = formatValue(val);
        ctx.font = `9px ${MONO_FONT}`;
        const tw = ctx.measureText(pillText).width;
        const pillW = tw + 8;
        const pillH = 16;
        const pillX = w - RIGHT_MARGIN - pillW - 4;
        const pillY = Math.round(clamp(dotY - pillH / 2, strip.top + 2, strip.top + strip.height - pillH - 2));

        ctx.fillStyle = CURSOR_PILL_BG;
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 3);
        ctx.fill();

        ctx.fillStyle = strip.color;
        ctx.textAlign = 'center';
        ctx.fillText(pillText, pillX + pillW / 2, pillY + 11);
      }
    }

    if (cursorB !== null) {
      drawCursorLine(cursorB, DELTA_LINE);
    }

    // ── Hover crosshair (always visible when mouse is over canvas) ──
    const hoverT = hoverXRef.current;
    if (hoverT !== null) {
      // Draw a subtle crosshair line (dimmer than placed cursors)
      const isHoverSameAsCursorA = cursorA !== null && Math.abs(hoverT - cursorA) < (xRange[1] - xRange[0]) * 0.002;
      const isHoverSameAsCursorB = cursorB !== null && Math.abs(hoverT - cursorB) < (xRange[1] - xRange[0]) * 0.002;
      if (!isHoverSameAsCursorA && !isHoverSameAsCursorB) {
        drawCursorLine(hoverT, 'rgba(255,255,255,0.25)');
      }

      // Value readouts for hover in delta mode (when placed cursors exist)
      if (deltaModeRef.current && (cursorA !== null || cursorB !== null)) {
        for (const strip of strips) {
          const data = channelDataMap.get(strip.channelId);
          if (!data || data.allSamples.length === 0) continue;

          const tMs = hoverT * 1000;
          const val = interpolateValue(data.allSamples, tMs);
          if (val === null) continue;

          const yMin_s = (() => {
            const ds = getDownsampled(strip.channelId, data.allSamples, xRange, plotW);
            let mn = Infinity, mx = -Infinity;
            for (const s of ds) { if (s.value < mn) mn = s.value; if (s.value > mx) mx = s.value; }
            if (!isFinite(mn)) { mn = 0; mx = 1; }
            const pad = (mx - mn) * 0.08 || 0.5;
            return [mn - pad, mx + pad] as [number, number];
          })();

          const valToY_h = (v: number) =>
            strip.top + strip.height - 4 - ((v - yMin_s[0]) / (yMin_s[1] - yMin_s[0])) * (strip.height - 8);

          const dotX = timeToX(hoverT, xRange, plotW);
          const dotY = valToY_h(val);

          // Small hollow dot
          ctx.strokeStyle = strip.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
          ctx.stroke();

          // Value pill (smaller, semi-transparent)
          const pillText = formatValue(val);
          ctx.font = `8px ${MONO_FONT}`;
          const tw = ctx.measureText(pillText).width;
          const pillW = tw + 6;
          const pillH = 14;
          const pillX = dotX + 8;
          const pillY = Math.round(clamp(dotY - pillH / 2, strip.top + 2, strip.top + strip.height - pillH - 2));

          ctx.fillStyle = 'rgba(13,14,20,0.75)';
          ctx.beginPath();
          ctx.roundRect(pillX, pillY, pillW, pillH, 2);
          ctx.fill();

          ctx.fillStyle = strip.color + 'aa';
          ctx.textAlign = 'left';
          ctx.fillText(pillText, pillX + 3, pillY + 10);
        }
      }
    }

    // ── Delta panel ──
    if (cursorA !== null && cursorB !== null) {
      const deltaT = Math.abs(cursorB - cursorA);
      const panelLines: { label: string; valA: string; valB: string; delta: string; color: string }[] = [];

      for (const strip of strips) {
        const data = channelDataMap.get(strip.channelId);
        if (!data || data.allSamples.length === 0) continue;
        const vA = interpolateValue(data.allSamples, cursorA * 1000);
        const vB = interpolateValue(data.allSamples, cursorB * 1000);
        if (vA === null || vB === null) continue;
        panelLines.push({
          label: data.def.shortName,
          valA: formatValue(vA),
          valB: formatValue(vB),
          delta: formatValue(vB - vA),
          color: strip.color,
        });
      }

      // Draw panel at top-right
      const panelPad = 8;
      const lineH = 16;
      const panelH = (panelLines.length + 1) * lineH + panelPad * 2;
      const panelW = 240;
      const panelX = w - RIGHT_MARGIN - panelW - 8;
      const panelY = 8;

      ctx.fillStyle = DELTA_PANEL_BG;
      ctx.beginPath();
      ctx.roundRect(panelX, panelY, panelW, panelH, 6);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(panelX, panelY, panelW, panelH, 6);
      ctx.stroke();

      // Header
      ctx.font = `bold 9px ${MONO_FONT}`;
      ctx.fillStyle = DELTA_LINE;
      ctx.textAlign = 'left';
      ctx.fillText(`Δt = ${deltaT.toFixed(3)}s`, panelX + panelPad, panelY + panelPad + 10);

      // Column headers
      const col1 = panelX + panelPad;
      const col2 = panelX + 80;
      const col3 = panelX + 130;
      const col4 = panelX + 185;

      ctx.font = `8px ${MONO_FONT}`;
      ctx.fillStyle = TEXT_COLOR;
      // No column headers — just show data

      // Data rows
      for (let i = 0; i < panelLines.length; i++) {
        const row = panelLines[i];
        const ry = panelY + panelPad + (i + 1) * lineH + 10;

        ctx.font = `bold 8px ${MONO_FONT}`;
        ctx.fillStyle = row.color;
        ctx.textAlign = 'left';
        ctx.fillText(row.label, col1, ry);

        ctx.font = `8px ${MONO_FONT}`;
        ctx.fillStyle = '#8b93a8';
        ctx.textAlign = 'right';
        ctx.fillText(row.valA, col2 + 30, ry);
        ctx.fillText(row.valB, col3 + 35, ry);

        ctx.fillStyle = DELTA_LINE;
        ctx.fillText('Δ' + row.delta, col4 + 40, ry);
      }
    }

    ctx.restore();
  }, [session, sessionDuration, channelDataMap, visibleChannels, computeStripLayouts, timeToX, getDownsampled]);

  // ─── Animation loop ────────────────────────────────────────────────────
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      if (needsDrawRef.current) {
        draw();
        needsDrawRef.current = false;
      }
      rafIdRef.current = requestAnimationFrame(loop);
    };
    rafIdRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(rafIdRef.current);
    };
  }, [draw]);

  // ─── Canvas sizing via ResizeObserver ──────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasSizeRef.current = { w, h };
      needsDrawRef.current = true;
      setIsCanvasReady(true);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    return () => ro.disconnect();
  }, []);

  // Trigger redraws when data changes
  useEffect(() => {
    needsDrawRef.current = true;
  }, [channelDataMap, visibleChannels, viewRange]);

  // ─── Mouse events ─────────────────────────────────────────────────────
  const getEffectiveXRange = useCallback((): [number, number] => {
    return xRangeRef.current || [0, sessionDuration];
  }, [sessionDuration]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const plotW = canvasSizeRef.current.w - LEFT_MARGIN - RIGHT_MARGIN;
    if (plotW <= 0) return;

    const xRange = getEffectiveXRange();
    const tAtMouse = xToTime(mouseX, xRange, plotW);

    // Graduated zoom: normalize deltaY across trackpad/mouse wheel
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 40; // line mode → pixels
    if (e.deltaMode === 2) delta *= 800; // page mode → pixels
    const zoomIntensity = 0.0008;
    const factor = Math.exp(delta * zoomIntensity);
    const newSpan = (xRange[1] - xRange[0]) * factor;

    // Keep time-under-cursor stationary
    const ratio = (mouseX - LEFT_MARGIN) / plotW;
    let newStart = tAtMouse - ratio * newSpan;
    let newEnd = newStart + newSpan;

    // Clamp
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > sessionDuration) { newStart -= (newEnd - sessionDuration); newEnd = sessionDuration; }
    newStart = Math.max(0, newStart);
    newEnd = Math.min(sessionDuration, newEnd);

    // If span covers full session, reset
    if (newEnd - newStart >= sessionDuration * 0.998) {
      xRangeRef.current = null;
      emitViewRange(null);
    } else {
      xRangeRef.current = [newStart, newEnd];
      emitViewRange([newStart, newEnd]);
    }
    needsDrawRef.current = true;
  }, [sessionDuration, getEffectiveXRange, xToTime, emitViewRange]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;

    // Check if in delta mode and this is a click (not drag)
    isDraggingRef.current = true;
    setCursorStyle('grabbing');
    const rect = canvasRef.current!.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    dragStartRef.current = { mouseX, xRange: [...getEffectiveXRange()] as [number, number] };
  }, [getEffectiveXRange]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const plotW = canvasSizeRef.current.w - LEFT_MARGIN - RIGHT_MARGIN;
    if (plotW <= 0) return;

    if (isDraggingRef.current && dragStartRef.current) {
      // Pan
      const dx = mouseX - dragStartRef.current.mouseX;
      const origRange = dragStartRef.current.xRange;
      const span = origRange[1] - origRange[0];
      const timeDelta = -(dx / plotW) * span;
      let newStart = origRange[0] + timeDelta;
      let newEnd = origRange[1] + timeDelta;

      // Clamp
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > sessionDuration) { newStart -= (newEnd - sessionDuration); newEnd = sessionDuration; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(sessionDuration, newEnd);

      xRangeRef.current = [newStart, newEnd];
      emitViewRange([newStart, newEnd]);
      needsDrawRef.current = true;
    } else {
      // Update hover cursor (always, regardless of delta mode)
      const xRange = getEffectiveXRange();
      const t = xToTime(mouseX, xRange, plotW);
      hoverXRef.current = clamp(t, xRange[0], xRange[1]);
      // In non-delta mode, the hover IS the cursor
      if (!deltaModeRef.current) {
        cursorXRef.current = hoverXRef.current;
      }
      needsDrawRef.current = true;
    }
  }, [sessionDuration, getEffectiveXRange, xToTime, emitViewRange]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const wasDragging = isDraggingRef.current;
    const dragStart = dragStartRef.current;
    isDraggingRef.current = false;
    setCursorStyle('crosshair');

    // Detect click (no significant drag)
    if (wasDragging && dragStart && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const dx = Math.abs(mouseX - dragStart.mouseX);

      if (dx < 3) {
        // This was a click, not a drag
        const plotW = canvasSizeRef.current.w - LEFT_MARGIN - RIGHT_MARGIN;
        const xRange = getEffectiveXRange();
        const t = clamp(xToTime(mouseX, xRange, plotW), xRange[0], xRange[1]);

        if (deltaModeRef.current) {
          if (e.shiftKey) {
            // Shift+Click → move cursor A
            cursorXRef.current = t;
          } else if (cursorXRef.current === null) {
            // First click in delta → set cursor A
            cursorXRef.current = t;
          } else {
            // Subsequent clicks → set/move cursor B
            cursor2XRef.current = t;
          }
        } else {
          cursorXRef.current = t;
        }
        needsDrawRef.current = true;
      }
    }
    dragStartRef.current = null;
  }, [getEffectiveXRange, xToTime]);

  const handleMouseLeave = useCallback(() => {
    isDraggingRef.current = false;
    setCursorStyle('crosshair');
    dragStartRef.current = null;
    hoverXRef.current = null;
    if (!deltaModeRef.current) {
      cursorXRef.current = null;
    }
    needsDrawRef.current = true;
  }, []);

  const handleDoubleClick = useCallback(() => {
    xRangeRef.current = null;
    emitViewRange(null);
    needsDrawRef.current = true;
  }, [emitViewRange]);

  // ─── Touch event handlers ────────────────────────────────────
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const touches = e.touches;

    if (touches.length === 1) {
      const t = touches[0];
      const x = t.clientX - rect.left;
      const y = t.clientY - rect.top;
      touchStartRef.current = {
        x, y,
        t: Date.now(),
        xRange: [...getEffectiveXRange()] as [number, number],
      };
      pinchStartRef.current = null;
    } else if (touches.length === 2) {
      const t1 = touches[0];
      const t2 = touches[1];
      const distance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const centerX = ((t1.clientX + t2.clientX) / 2) - rect.left;
      pinchStartRef.current = {
        distance,
        xRange: [...getEffectiveXRange()] as [number, number],
        centerX,
      };
      touchStartRef.current = null;
    }
  }, [getEffectiveXRange]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const plotW = canvasSizeRef.current.w - LEFT_MARGIN - RIGHT_MARGIN;
    if (plotW <= 0) return;
    const touches = e.touches;

    if (touches.length === 1 && touchStartRef.current) {
      // Single-finger pan
      const t = touches[0];
      const x = t.clientX - rect.left;
      const dx = x - touchStartRef.current.x;
      const origRange = touchStartRef.current.xRange;
      const span = origRange[1] - origRange[0];
      const timeDelta = -(dx / plotW) * span;
      let newStart = origRange[0] + timeDelta;
      let newEnd = origRange[1] + timeDelta;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > sessionDuration) { newStart -= (newEnd - sessionDuration); newEnd = sessionDuration; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(sessionDuration, newEnd);
      xRangeRef.current = [newStart, newEnd];
      emitViewRange([newStart, newEnd]);
      needsDrawRef.current = true;
    } else if (touches.length === 2 && pinchStartRef.current) {
      // Pinch zoom
      const t1 = touches[0];
      const t2 = touches[1];
      const currentDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const { distance: initDist, xRange: origRange, centerX } = pinchStartRef.current;
      if (currentDistance <= 0 || initDist <= 0) return;

      const factor = initDist / currentDistance; // >1 = zoom in, <1 = zoom out
      const span = origRange[1] - origRange[0];
      const newSpan = span * factor;
      const tAtCenter = xToTime(centerX, origRange, plotW);
      const ratio = (centerX - LEFT_MARGIN) / plotW;
      let newStart = tAtCenter - ratio * newSpan;
      let newEnd = newStart + newSpan;

      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > sessionDuration) { newStart -= (newEnd - sessionDuration); newEnd = sessionDuration; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(sessionDuration, newEnd);

      if (newEnd - newStart >= sessionDuration * 0.998) {
        xRangeRef.current = null;
        emitViewRange(null);
      } else {
        xRangeRef.current = [newStart, newEnd];
        emitViewRange([newStart, newEnd]);
      }
      needsDrawRef.current = true;
    }
  }, [sessionDuration, xToTime, emitViewRange]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const remainingTouches = e.touches.length;

    if (remainingTouches === 0) {
      // Check for tap (no significant movement, short duration)
      if (touchStartRef.current && e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        const rect = canvas.getBoundingClientRect();
        const endX = touch.clientX - rect.left;
        const endY = touch.clientY - rect.top;
        const dx = Math.abs(endX - touchStartRef.current.x);
        const dy = Math.abs(endY - touchStartRef.current.y);
        const duration = Date.now() - touchStartRef.current.t;
        const totalMovement = Math.hypot(dx, dy);

        if (totalMovement < 10 && duration < 300) {
          // Tap → place cursor
          const plotW = canvasSizeRef.current.w - LEFT_MARGIN - RIGHT_MARGIN;
          const xRange = getEffectiveXRange();
          const t = clamp(xToTime(endX, xRange, plotW), xRange[0], xRange[1]);
          cursorXRef.current = t;
          if (onCursorTimeChange) onCursorTimeChange(t);
          needsDrawRef.current = true;
        }
      }
      touchStartRef.current = null;
      pinchStartRef.current = null;
    } else if (remainingTouches === 1 && pinchStartRef.current) {
      // Transitioned from pinch to single finger — restart pan
      pinchStartRef.current = null;
      const rect = canvas.getBoundingClientRect();
      const t = e.touches[0];
      touchStartRef.current = {
        x: t.clientX - rect.left,
        y: t.clientY - rect.top,
        t: Date.now(),
        xRange: [...getEffectiveXRange()] as [number, number],
      };
    }
  }, [getEffectiveXRange, xToTime, onCursorTimeChange]);

  // ─── Reset zoom from toolbar ──────────────────────────────────────────
  const resetZoom = useCallback(() => {
    xRangeRef.current = null;
    cursorXRef.current = null;
    cursor2XRef.current = null;
    emitViewRange(null);
    needsDrawRef.current = true;
  }, [emitViewRange]);

  // ─── Toggle delta mode ────────────────────────────────────────────────
  const toggleDelta = useCallback(() => {
    setDeltaMode(prev => !prev);
  }, []);

  // ─── Empty state ──────────────────────────────────────────────────────
  if (visibleChannels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <path d="M4 24 L12 12 L20 30 L28 18 L36 26 L44 16" stroke="hsl(var(--border))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <p className="text-sm">Select channels from the left panel to plot</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="chart-container">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {viewRange
              ? `${formatTime(viewRange.startMs)} — ${formatTime(viewRange.endMs)}`
              : `Full session: ${formatTime(session.durationMs)}`
            }
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={toggleDelta}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
              deltaMode
                ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
            title="Toggle delta measurement mode"
            data-testid="delta-toggle"
          >
            Δ Delta
          </button>
          {viewRange && (
            <button
              onClick={resetZoom}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              title="Reset zoom"
              data-testid="reset-zoom"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
          )}
          <span className="text-xs text-muted-foreground/40 ml-1">scroll to zoom · drag to pan</span>
        </div>
      </div>

      {/* Canvas container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative"
        style={{ cursor: cursorStyle }}
      >
        <canvas
          ref={canvasRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onDoubleClick={handleDoubleClick}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="absolute inset-0"
          style={{ touchAction: 'none' }}
          data-testid="telemetry-canvas"
        />
      </div>
    </div>
  );
}
