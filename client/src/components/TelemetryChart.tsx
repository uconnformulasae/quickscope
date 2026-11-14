import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { formatChartElapsed } from '../lib/time-format';
import type { ChannelSample } from '../lib/xrk-parser';
import { RotateCcw, ImageDown, X } from 'lucide-react';
import {
  type TelemetryChartProps, type StripLayout, type DrawContext, type ChartFrameCache,
  LEFT_MARGIN, RIGHT_MARGIN, BOTTOM_AXIS_HEIGHT, MIN_STRIP_HEIGHT, AXIS_WIDTH,
  DEBOUNCE_MS,
  clamp, niceAxisTicks, getChartColors, toDarkChartColor,
} from '../lib/chart-utils';
import { computeOverlayYRanges, drawStrips, drawOverlayLegend, drawCompareLegend, drawXAxis, overlayLegendHeight } from '../lib/chart-draw';
import { computeDelta, drawCursors, hitTestCursor } from '../lib/chart-cursors';
import { DeltaReadout } from './DeltaReadout';
import type { ChartExportSpec } from '../lib/chart-export';
import { ImageExportDialog } from './ImageExportDialog';
import { Presence } from '../lib/motion';
import { usePreferences } from '../lib/usePreferences';
import { convertibleUnits, resolveDisplayUnit } from '../lib/units';
import { ChartUnitMenu } from './ChartUnitMenu';
import { useDisplaySamples } from '../lib/useDisplaySamples';
import { buildLapWindows, selectedWindows, shiftToLap, lapColor } from '../lib/lap-compare';
import { formatLapTime } from '../lib/xrk-parser';
import { createValueStore, useStoreValue, type ValueStore } from '../lib/cursorStore';

/** Grab distance (px) for dragging a delta cursor. */
const CURSOR_HIT_PX = 6;

// ─── Main Component ─────────────────────────────────────────────────────────

interface DeltaCursors { a: number; b: number }

/** The docked Δ readout. It subscribes to the cursor pair itself, so dragging
 *  a cursor re-renders this panel and nothing else. */
function DeltaPanel({ store, channels, channelDataMap, onClose }: {
  store: ValueStore<DeltaCursors | null>;
  channels: Parameters<typeof computeDelta>[0];
  channelDataMap: Parameters<typeof computeDelta>[1];
  onClose: () => void;
}) {
  const cursors = useStoreValue(store);
  if (!cursors) return null;
  const { deltaT, rows } = computeDelta(channels, channelDataMap, cursors.a, cursors.b);
  return <DeltaReadout deltaT={deltaT} rows={rows} onClose={onClose} />;
}

export function TelemetryChart({
  session,
  activeChannels,
  viewRange,
  onViewRangeChange,
  derivedChannels,
  derivedSamplesMap,
  cursorTime,
  cursorStore,
  onCursorTimeChange,
  chartMode = 'separate',
  fileName = null,
  selectedLaps,
  onClearLapSelection,
}: TelemetryChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { prefs, update: updatePrefs } = usePreferences();
  const fontScale = prefs.uiScale;
  const display = useDisplaySamples();
  const containerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [deltaMode, setDeltaMode] = useState(false);
  // Both delta cursors (seconds), mirrored from the refs for the docked readout.
  // Placed delta cursors (seconds), for the Δ readout. Not React state: they
  // change on every mouse move while a cursor is dragged.
  const deltaStore = useMemo(() => createValueStore<DeltaCursors | null>(null), []);
  const [imageExportSpec, setImageExportSpec] = useState<ChartExportSpec | null>(null);
  // Unit menu opened from a strip label / overlay axis: channels + position (canvas px).
  const [unitMenu, setUnitMenu] = useState<{ channelIds: number[]; x: number; y: number } | null>(null);

  // ─── Refs for transient state (no React re-renders) ─────────────────────
  const cursorEmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const xRangeRef = useRef<[number, number] | null>(null); // seconds
  const cursorXRef = useRef<number | null>(null); // seconds (placed cursor A)
  const clickedXRef = useRef<number | null>(null); // seconds (last click-placed cursor, survives mouse leave)
  const cursor2XRef = useRef<number | null>(null); // seconds (placed cursor B, delta mode)
  const hoverXRef = useRef<number | null>(null); // seconds (live mouse position, always tracks)
  const isDraggingRef = useRef(false);
  const dragCursorRef = useRef<'A' | 'B' | null>(null); // delta cursor being dragged
  const dragStartRef = useRef<{ mouseX: number; xRange: [number, number] } | null>(null);
  const canvasSizeRef = useRef({ w: 0, h: 0 });
  const rafIdRef = useRef<number>(0);
  const needsDrawRef = useRef(true);
  const deltaModeRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Frames are only scheduled while there is something to draw, so a static
  // chart costs nothing. A draw that is still easing its Y-range sets
  // needsDrawRef again, which keeps frames coming until it settles.
  const drawRef = useRef<() => void>(() => {});
  const frame = useCallback(() => {
    rafIdRef.current = 0;
    if (!needsDrawRef.current) return;
    needsDrawRef.current = false;
    drawRef.current();
    if (needsDrawRef.current) rafIdRef.current = requestAnimationFrame(frame);
  }, []);
  const requestDraw = useCallback(() => {
    needsDrawRef.current = true;
    if (!rafIdRef.current) rafIdRef.current = requestAnimationFrame(frame);
  }, [frame]);

  // Cache for global min/max per channel (recomputed when channelDataMap changes)
  // Traces, y-ranges and min/max per series, reused while the zoom is unchanged.
  const frameCache = useRef<ChartFrameCache>(new WeakMap());
  // Smoothed Y-ranges: lerp toward target to avoid jumps. Key is channelId or "overlay:units".
  const smoothedYRanges = useRef<Map<string, [number, number]>>(new Map());

  // Touch gesture refs
  const touchStartRef = useRef<{ x: number; y: number; t: number; xRange: [number, number] } | null>(null);
  const pinchStartRef = useRef<{ distance: number; xRange: [number, number]; centerX: number } | null>(null);

  // ─── Derived data ───────────────────────────────────────────────────────
  const visibleChannels = activeChannels;

  // Lap compare mode: 2+ selected laps, x = lap-relative time.
  const lapWindows = useMemo(() => buildLapWindows(session.lapMarkers), [session.lapMarkers]);
  const compareLaps = useMemo(() => {
    const sel = selectedWindows(lapWindows, selectedLaps ?? []);
    return sel.length >= 2 ? sel : null;
  }, [lapWindows, selectedLaps]);
  const compareRef = useRef(false);
  compareRef.current = compareLaps !== null;

  // Timeline length in seconds: the session, or the longest compared lap.
  const sessionDuration = compareLaps
    ? Math.max(...compareLaps.map(l => l.durationMs)) / 1000
    : session.durationMs / 1000;

  // Resolve channels: get definition + all samples for each visible channel
  const baseChannelDataMap = useMemo(() => {
    const map = new Map<number, { def: { shortName: string; units: string; color: string }; allSamples: ChannelSample[] }>();
    for (const ac of visibleChannels) {
      const sessionChan = session.channels.get(ac.channelId);
      if (sessionChan) {
        const d = display(ac.channelId, sessionChan.shortName, sessionChan.units, session.samples.get(ac.channelId) || []);
        map.set(ac.channelId, {
          def: { shortName: sessionChan.shortName, units: d.unit, color: ac.color },
          allSamples: d.samples,
        });
        continue;
      }
      // Check derived
      const dc = derivedChannels?.find(d => d.id === ac.channelId);
      if (dc) {
        const d = display(ac.channelId, dc.name, dc.units, derivedSamplesMap?.get(ac.channelId) || []);
        map.set(ac.channelId, {
          def: { shortName: dc.name, units: d.unit, color: ac.color },
          allSamples: d.samples,
        });
      }
    }
    return map;
  }, [visibleChannels, session, derivedChannels, derivedSamplesMap, display]);

  // In compare mode each channel's samples become lap-relative series; the
  // first lap stands in as allSamples so cursors/min-max/delta work unchanged.
  const compareSeries = useMemo(() => {
    if (!compareLaps) return null;
    const series = new Map<number, ChannelSample[][]>();
    for (const [id, data] of baseChannelDataMap) {
      series.set(id, compareLaps.map(lap => shiftToLap(data.allSamples, lap)));
    }
    return series;
  }, [compareLaps, baseChannelDataMap]);

  const channelDataMap = useMemo(() => {
    if (!compareSeries) return baseChannelDataMap;
    const map = new Map(baseChannelDataMap);
    for (const [id, data] of baseChannelDataMap) {
      map.set(id, { ...data, allSamples: compareSeries.get(id)?.[0] ?? [] });
    }
    return map;
  }, [baseChannelDataMap, compareSeries]);

  // ─── Dynamic margins for overlay Y-axes ────────────────────────────────
  // Build unique unit groups for overlay axis layout
  const overlayAxisLayout = useMemo(() => {
    if (chartMode !== 'overlay') return { unitAxes: new Map<string, { side: 'left' | 'right'; sideIndex: number }>(), axisCount: 0 };
    const seen: string[] = [];
    for (const ac of visibleChannels) {
      const data = channelDataMap.get(ac.channelId);
      const units = data?.def.units || '';
      if (!seen.includes(units)) seen.push(units);
    }
    const unitAxes = new Map<string, { side: 'left' | 'right'; sideIndex: number }>();
    for (let i = 0; i < seen.length; i++) {
      const isLeft = i % 2 === 0;
      unitAxes.set(seen[i], { side: isLeft ? 'left' : 'right', sideIndex: Math.floor(i / 2) });
    }
    return { unitAxes, axisCount: seen.length };
  }, [chartMode, visibleChannels, channelDataMap]);

  const { leftMargin, rightMargin } = useMemo(() => {
    if (chartMode !== 'overlay' || overlayAxisLayout.axisCount <= 1) {
      return { leftMargin: Math.round(LEFT_MARGIN * fontScale), rightMargin: RIGHT_MARGIN };
    }
    const n = overlayAxisLayout.axisCount;
    const leftCount = Math.ceil(n / 2);
    const rightCount = Math.floor(n / 2);
    return {
      leftMargin: Math.round(Math.max(LEFT_MARGIN, leftCount * AXIS_WIDTH) * fontScale),
      rightMargin: Math.round(Math.max(RIGHT_MARGIN, rightCount * AXIS_WIDTH) * fontScale),
    };
  }, [chartMode, overlayAxisLayout, fontScale]);

  // ─── New channel data: restart y-range smoothing and redraw ─────────────
  useEffect(() => {
    // Reset smoothed Y-ranges so new channels start without stale lerp state
    smoothedYRanges.current.clear();
    requestDraw();
  }, [channelDataMap]);

  // ─── Sync external cursor (prop or shared store) → internal cursorXRef ──
  const applyExternalCursor = useCallback((t: number | null | undefined) => {
    if (t === undefined || t === cursorXRef.current) return;
    cursorXRef.current = t;
    if (t === null) clickedXRef.current = null;
    requestDraw();
  }, []);

  useEffect(() => {
    applyExternalCursor(cursorTime);
  }, [cursorTime, applyExternalCursor]);

  // The store is read by subscription, not as a prop, so a cursor move set
  // from elsewhere (jump to a lap, a cleared session) redraws the canvas
  // without re-rendering this component.
  useEffect(() => {
    if (!cursorStore) return;
    applyExternalCursor(cursorStore.get());
    return cursorStore.subscribe(() => applyExternalCursor(cursorStore.get()));
  }, [cursorStore, applyExternalCursor]);

  /** Mouse handlers must not call setState (it re-renders the chart on every
   *  move), so the pointer shape is written straight to the DOM. */
  const setCursorStyle = useCallback((style: string) => {
    const el = containerRef.current;
    if (el && el.style.cursor !== style) el.style.cursor = style;
  }, []);

  // ─── Sync external viewRange → internal xRange ─────────────────────────
  // (Compare mode keeps its own lap-relative zoom; on entering/leaving it the
  // cursors reset and the x-range goes to the full lap / the session viewRange.)
  const inCompare = compareLaps !== null;
  useEffect(() => {
    if (inCompare) {
      xRangeRef.current = null;
    } else if (!viewRange) {
      xRangeRef.current = null;
    } else {
      xRangeRef.current = [viewRange.startMs / 1000, viewRange.endMs / 1000];
    }
    requestDraw();
  }, [viewRange, inCompare]);

  useEffect(() => {
    cursorXRef.current = null;
    cursor2XRef.current = null;
    clickedXRef.current = null;
    hoverXRef.current = null;
    if (canvasRef.current) {
      delete canvasRef.current.dataset.cursorA;
      delete canvasRef.current.dataset.cursorB;
    }
    deltaStore.set(null);
    requestDraw();
  }, [inCompare]);

  // ─── Keep deltaMode ref in sync ────────────────────────────────────────
  useEffect(() => {
    deltaModeRef.current = deltaMode;
    // When turning delta mode off, clear cursor2
    if (!deltaMode) {
      cursor2XRef.current = null;
      dragCursorRef.current = null;
      if (canvasRef.current) delete canvasRef.current.dataset.cursorB;
      deltaStore.set(null);
      requestDraw();
    }
  }, [deltaMode]);

  // ─── Debounced onViewRangeChange ───────────────────────────────────────
  const emitViewRange = useCallback((range: [number, number] | null) => {
    // Compare zoom is lap-relative: it must not leak into the session viewRange.
    if (compareRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      if (!range) {
        onViewRangeChange(null);
      } else {
        onViewRangeChange({ startMs: range[0] * 1000, endMs: range[1] * 1000 });
      }
    }, DEBOUNCE_MS);
  }, [onViewRangeChange]);

  // ─── Compute strip layout ─────────────────────────────────────────────
  const computeStripLayouts = useCallback((canvasH: number): StripLayout[] => {
    const plotH = canvasH - BOTTOM_AXIS_HEIGHT * fontScale;
    const numCh = visibleChannels.length;
    if (numCh === 0) return [];

    if (chartMode === 'overlay') {
      // All channels share the full plot height
      return visibleChannels.map((ac) => {
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
  }, [visibleChannels, channelDataMap, chartMode, fontScale]);

  // ─── Time ↔ Pixel conversions ─────────────────────────────────────────
  const timeToX = useCallback((t: number, xRange: [number, number], plotW: number): number => {
    return leftMargin + ((t - xRange[0]) / (xRange[1] - xRange[0])) * plotW;
  }, [leftMargin]);

  const xToTime = useCallback((px: number, xRange: [number, number], plotW: number): number => {
    return xRange[0] + ((px - leftMargin) / plotW) * (xRange[1] - xRange[0]);
  }, [leftMargin]);

  // ─── DRAW ─────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvasSizeRef.current.w;
    const h = canvasSizeRef.current.h;
    if (w === 0 || h === 0) return;

    const xRange: [number, number] = xRangeRef.current || [0, sessionDuration];
    const lm = leftMargin;
    const rm = rightMargin;
    const plotW = w - lm - rm;
    const strips = computeStripLayouts(h);
    const xTicks = niceAxisTicks(xRange[0], xRange[1], Math.max(5, Math.floor(plotW / 80)));
    const sharedYRanges = new Map<string, [number, number]>();
    const colors = getChartColors(canvas);

    const dc: DrawContext = {
      ctx, w, h, lm, rm, plotW, xRange, xTicks, strips,
      channelDataMap, chartMode, sharedYRanges,
      timeToX, overlayAxisLayout, session,
      smoothedYRanges: smoothedYRanges.current,
      needsDrawRef,
      colors,
      fontScale,
      cache: frameCache.current,
      compare: compareLaps && compareSeries ? { laps: compareLaps, series: compareSeries } : null,
    };
    if (compareLaps) dc.session = { ...session, logStartMs: null, lapMarkers: [] };
    // Overlay: the legend gets its own band above the plot so it never sits
    // on traces, lap labels or the delta panel.
    const legendBand = overlayLegendHeight(dc);
    if (legendBand > 0) {
      dc.topInset = legendBand;
      dc.strips = strips.map(st => ({ ...st, top: st.top + legendBand, height: Math.max(20, st.height - legendBand) }));
    }

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    computeOverlayYRanges(dc);
    drawStrips(dc);
    drawOverlayLegend(dc);
    drawCompareLegend(dc);
    const axisY = drawXAxis(dc);
    drawCursors(dc, {
      cursorA: cursorXRef.current,
      cursorB: cursor2XRef.current,
      hoverT: hoverXRef.current,
      deltaMode: deltaModeRef.current,
    }, axisY);

    ctx.restore();
  }, [session, sessionDuration, channelDataMap, visibleChannels, computeStripLayouts, timeToX, leftMargin, rightMargin, chartMode, overlayAxisLayout, fontScale, compareLaps, compareSeries]);


  // ─── On-demand drawing ─────────────────────────────────────────────────
  useEffect(() => {
    drawRef.current = draw;
    requestDraw();
  }, [draw, requestDraw]);

  useEffect(() => () => {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = 0;
  }, []);

  // ─── Compute required canvas height for separate mode ─────────────────
  const numVisible = visibleChannels.length;
  const requiredCanvasHeight = useMemo(() => {
    if (chartMode === 'overlay' || numVisible === 0) return 0; // 0 = use container height
    return numVisible * MIN_STRIP_HEIGHT + BOTTOM_AXIS_HEIGHT * fontScale;
  }, [chartMode, numVisible, fontScale]);

  // ─── Canvas sizing via ResizeObserver ──────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      const w = Math.round(rect.width);
      // In separate mode, grow canvas beyond viewport if needed
      const containerH = Math.round(rect.height);
      const h = requiredCanvasHeight > 0 ? Math.max(containerH, requiredCanvasHeight) : containerH;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasSizeRef.current = { w, h };
      requestDraw();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    return () => ro.disconnect();
  }, [requiredCanvasHeight, numVisible]); // re-run when canvas appears or size changes

  // Trigger redraws when data or display mode changes
  useEffect(() => {
    requestDraw();
  }, [channelDataMap, visibleChannels, viewRange, chartMode]);

  // Clear smoothed Y-ranges when chart mode changes to avoid stale lerp state
  useEffect(() => {
    smoothedYRanges.current.clear();
  }, [chartMode]);

  // ─── Mouse events ─────────────────────────────────────────────────────
  const getEffectiveXRange = useCallback((): [number, number] => {
    return xRangeRef.current || [0, sessionDuration];
  }, [sessionDuration]);

  /** Mirror placed cursor times onto the canvas (data-cursor-a/b) for tests
   *  and debugging — DOM only, no React state. */
  const syncCursorAttrs = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const set = (k: 'cursorA' | 'cursorB', v: number | null) => {
      if (v === null) delete c.dataset[k]; else c.dataset[k] = v.toFixed(3);
    };
    set('cursorA', cursorXRef.current);
    set('cursorB', cursor2XRef.current);
    // The Δ readout subscribes to this store, so it follows the cursors
    // without the chart itself re-rendering.
    const a = cursorXRef.current;
    const b = cursor2XRef.current;
    const prev = deltaStore.get();
    if (a === null || b === null) deltaStore.set(null);
    else if (!prev || prev.a !== a || prev.b !== b) deltaStore.set({ a, b });
  }, [deltaStore]);

  /** Delta cursor under the given canvas x, if any. */
  const cursorAtX = useCallback((mouseX: number): 'A' | 'B' | null => {
    if (!deltaModeRef.current) return null;
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
    if (plotW <= 0) return null;
    const xRange = getEffectiveXRange();
    const toPx = (t: number | null) => (t === null ? null : timeToX(t, xRange, plotW));
    return hitTestCursor(mouseX, toPx(cursorXRef.current), toPx(cursor2XRef.current), CURSOR_HIT_PX * fontScale);
  }, [getEffectiveXRange, timeToX, leftMargin, rightMargin, fontScale]);

  /** Channel whose label column is under (x, y), if its units can be changed.
   *  Separate mode only: in overlay mode channels share axes, so no menu. */
  const labelChannelsAt = useCallback((mouseX: number, mouseY: number): number[] | null => {
    if (chartMode === 'overlay' || mouseX >= leftMargin) return null;
    const strip = computeStripLayouts(canvasSizeRef.current.h)
      .find(st => mouseY >= st.top && mouseY < st.top + st.height);
    if (!strip || convertibleUnits(channelDataMap.get(strip.channelId)?.def.units ?? '').length === 0) return null;
    return [strip.channelId];
  }, [chartMode, leftMargin, computeStripLayouts, channelDataMap]);

  /** Move a dragged delta cursor to canvas x. */
  const moveDraggedCursor = useCallback((which: 'A' | 'B', mouseX: number) => {
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
    if (plotW <= 0) return;
    const xRange = getEffectiveXRange();
    const t = clamp(xToTime(mouseX, xRange, plotW), xRange[0], xRange[1]);
    if (which === 'A') {
      cursorXRef.current = t;
      clickedXRef.current = t;
      if (onCursorTimeChange && !cursorEmitTimer.current) {
        cursorEmitTimer.current = setTimeout(() => {
          cursorEmitTimer.current = null;
          if (cursorXRef.current !== null) onCursorTimeChange(cursorXRef.current);
        }, 60);
      }
    } else {
      cursor2XRef.current = t;
    }
    syncCursorAttrs();
    requestDraw();
  }, [getEffectiveXRange, xToTime, leftMargin, rightMargin, onCursorTimeChange, syncCursorAttrs]);

  // Store wheel handler deps in a ref so the native listener stays stable
  const wheelDepsRef = useRef({ sessionDuration, getEffectiveXRange, xToTime, emitViewRange, leftMargin, rightMargin });
  useEffect(() => {
    wheelDepsRef.current = { sessionDuration, getEffectiveXRange, xToTime, emitViewRange, leftMargin, rightMargin };
  }, [sessionDuration, getEffectiveXRange, xToTime, emitViewRange, leftMargin, rightMargin]);

  // Attach native wheel listener once with { passive: false }
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { sessionDuration: dur, getEffectiveXRange: getXR, xToTime: x2t, emitViewRange: emit, leftMargin: lm, rightMargin: rm } = wheelDepsRef.current;
      const plotW = canvasSizeRef.current.w - lm - rm;
      if (plotW <= 0) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const xRange = getXR();
      const tAtMouse = x2t(mouseX, xRange, plotW);

      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 40;
      if (e.deltaMode === 2) delta *= 800;
      const factor = Math.exp(delta * 0.0008);
      const newSpan = (xRange[1] - xRange[0]) * factor;

      const ratio = (mouseX - lm) / plotW;
      let newStart = tAtMouse - ratio * newSpan;
      let newEnd = newStart + newSpan;

      const clampedSpan = Math.min(newSpan, dur);
      if (newStart < 0) { newStart = 0; newEnd = clampedSpan; }
      if (newEnd > dur) { newEnd = dur; newStart = dur - clampedSpan; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(dur, newEnd);

      if (newEnd - newStart >= dur * 0.998) {
        xRangeRef.current = null;
        emit(null);
      } else {
        xRangeRef.current = [newStart, newEnd];
        emit([newStart, newEnd]);
      }
      requestDraw();
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [numVisible]); // re-run when canvas appears (0→N channels)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;

    const rect = canvasRef.current!.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const labelHit = labelChannelsAt(mouseX, mouseY);
    if (labelHit) {
      setUnitMenu({ channelIds: labelHit, x: mouseX, y: mouseY });
      return;
    }
    const hit = cursorAtX(mouseX);
    if (hit) {
      dragCursorRef.current = hit;
      setCursorStyle('ew-resize');
      return;
    }
    isDraggingRef.current = true;
    setCursorStyle('grabbing');
    dragStartRef.current = { mouseX, xRange: [...getEffectiveXRange()] as [number, number] };
  }, [getEffectiveXRange, cursorAtX, labelChannelsAt]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
    if (plotW <= 0) return;

    if (dragCursorRef.current) {
      moveDraggedCursor(dragCursorRef.current, mouseX);
    } else if (isDraggingRef.current && dragStartRef.current) {
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
      requestDraw();
    } else {
      const overLabel = labelChannelsAt(mouseX, e.clientY - rect.top) !== null;
      setCursorStyle(overLabel ? 'pointer' : deltaModeRef.current && cursorAtX(mouseX) ? 'ew-resize' : 'crosshair');
      // Update hover cursor (always, regardless of delta mode)
      const xRange = getEffectiveXRange();
      const t = xToTime(mouseX, xRange, plotW);
      hoverXRef.current = clamp(t, xRange[0], xRange[1]);
      // In non-delta mode, the hover IS the cursor
      if (!deltaModeRef.current) {
        cursorXRef.current = hoverXRef.current;
        // Throttle state emit so GPS map updates without causing excessive re-renders
        if (onCursorTimeChange && !cursorEmitTimer.current) {
          cursorEmitTimer.current = setTimeout(() => {
            cursorEmitTimer.current = null;
            if (cursorXRef.current !== null) onCursorTimeChange(cursorXRef.current);
          }, 60);
        }
      }
      requestDraw();
    }
  }, [sessionDuration, getEffectiveXRange, xToTime, emitViewRange, leftMargin, rightMargin, onCursorTimeChange, moveDraggedCursor, cursorAtX, labelChannelsAt]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (dragCursorRef.current) {
      // End of a cursor drag — never a click/re-place.
      dragCursorRef.current = null;
      if (cursorXRef.current !== null) onCursorTimeChange?.(cursorXRef.current);
      return;
    }
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
        const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
        const xRange = getEffectiveXRange();
        const t = clamp(xToTime(mouseX, xRange, plotW), xRange[0], xRange[1]);

        let placedA = true;
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
            placedA = false;
          }
        } else {
          cursorXRef.current = t;
        }
        if (placedA) {
          // Publish the placed cursor right away (GPS marker, etc.) instead
          // of waiting on the hover throttle, and remember it for mouse leave.
          clickedXRef.current = t;
          if (cursorEmitTimer.current) {
            clearTimeout(cursorEmitTimer.current);
            cursorEmitTimer.current = null;
          }
          onCursorTimeChange?.(t);
        }
        syncCursorAttrs();
        requestDraw();
      }
    }
    dragStartRef.current = null;
  }, [getEffectiveXRange, xToTime, leftMargin, rightMargin, onCursorTimeChange, syncCursorAttrs]);

  const handleMouseLeave = useCallback(() => {
    isDraggingRef.current = false;
    dragCursorRef.current = null;
    setCursorStyle('crosshair');
    dragStartRef.current = null;
    hoverXRef.current = null;
    if (!deltaModeRef.current) {
      // The hover cursor goes away with the mouse, but a click-placed cursor
      // stays (and keeps the GPS marker where the user put it).
      cursorXRef.current = clickedXRef.current;
      if (cursorEmitTimer.current) {
        clearTimeout(cursorEmitTimer.current);
        cursorEmitTimer.current = null;
      }
      onCursorTimeChange?.(clickedXRef.current);
    }
    requestDraw();
  }, [onCursorTimeChange]);

  const handleDoubleClick = useCallback(() => {
    xRangeRef.current = null;
    emitViewRange(null);
    requestDraw();
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
      dragCursorRef.current = cursorAtX(x);
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
      dragCursorRef.current = null;
    }
  }, [getEffectiveXRange, cursorAtX]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
    if (plotW <= 0) return;
    const touches = e.touches;

    if (touches.length === 1 && dragCursorRef.current) {
      moveDraggedCursor(dragCursorRef.current, touches[0].clientX - rect.left);
    } else if (touches.length === 1 && touchStartRef.current) {
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
      requestDraw();
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
      const ratio = (centerX - leftMargin) / plotW;
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
      requestDraw();
    }
  }, [sessionDuration, xToTime, emitViewRange, leftMargin, rightMargin, moveDraggedCursor]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const remainingTouches = e.touches.length;

    if (remainingTouches === 0 && dragCursorRef.current) {
      dragCursorRef.current = null;
      touchStartRef.current = null;
      if (cursorXRef.current !== null) onCursorTimeChange?.(cursorXRef.current);
    } else if (remainingTouches === 0) {
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
          const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
          const xRange = getEffectiveXRange();
          const t = clamp(xToTime(endX, xRange, plotW), xRange[0], xRange[1]);
          cursorXRef.current = t;
          if (onCursorTimeChange) onCursorTimeChange(t);
          syncCursorAttrs();
          requestDraw();
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
  }, [getEffectiveXRange, xToTime, onCursorTimeChange, leftMargin, rightMargin, syncCursorAttrs]);

  // ─── Reset zoom from toolbar ──────────────────────────────────────────
  const resetZoom = useCallback(() => {
    xRangeRef.current = null;
    cursorXRef.current = null;
    cursor2XRef.current = null;
    syncCursorAttrs();
    emitViewRange(null);
    requestDraw();
  }, [emitViewRange, syncCursorAttrs]);

  const closeDelta = useCallback(() => setDeltaMode(false), []);

  // ─── Toggle delta mode ────────────────────────────────────────────────
  const toggleDelta = useCallback(() => {
    setDeltaMode(prev => !prev);
  }, []);

  // ─── Save image: snapshot the current view for the export renderer ────
  const openImageExport = useCallback(() => {
    const spec: ChartExportSpec = {
      fileName,
      metadata: session.metadata,
      channels: visibleChannels.flatMap(ac => {
        const data = channelDataMap.get(ac.channelId);
        if (!data) return [];
        return [{
          channelId: ac.channelId,
          name: data.def.shortName,
          units: data.def.units,
          color: toDarkChartColor(ac.color),
          samples: data.allSamples,
        }];
      }),
      xRange: getEffectiveXRange(),
      sessionDurationSec: sessionDuration,
      chartMode,
      lapMarkers: compareLaps ? [] : session.lapMarkers,
      exportedAt: new Date(),
    };
    setImageExportSpec(spec);
  }, [fileName, session, visibleChannels, channelDataMap, getEffectiveXRange, sessionDuration, chartMode, compareLaps]);

  const closeImageExport = useCallback(() => setImageExportSpec(null), []);

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
    <div className="flex flex-col h-full relative" data-testid="chart-container">
      {/* Toolbar */}
      <div ref={toolbarRef} className="flex items-center justify-between px-3 py-1.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          {compareLaps ? (
            <span
              data-testid="lap-compare-chip"
              className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-xs text-foreground"
            >
              <span className="text-muted-foreground">Compare:</span>
              {compareLaps.map((lap, i) => (
                <span key={lap.index} className="inline-flex items-center gap-1 tabular">
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ background: lapColor(i) }} aria-hidden />
                  Lap {lap.lapNumber} <span className="text-muted-foreground">{formatLapTime(lap.durationMs / 1000)}</span>
                </span>
              ))}
              <button
                type="button"
                onClick={onClearLapSelection}
                aria-label="Exit lap compare"
                className="p-0.5 rounded-full hover:bg-muted/50 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ) : (
          <span className="text-xs text-muted-foreground">
            {viewRange
              ? `${formatChartElapsed(viewRange.startMs, session.logStartMs)} — ${formatChartElapsed(viewRange.endMs, session.logStartMs)}`
              : session.logStartMs !== null
                ? `${formatChartElapsed(0, session.logStartMs)} — ${formatChartElapsed(session.durationMs, session.logStartMs)}`
                : `Full session: ${formatChartElapsed(session.durationMs, session.logStartMs)}`
            }
          </span>
          )}
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
          <button
            onClick={openImageExport}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Save image"
            aria-label="Save image"
            data-testid="save-image"
          >
            <ImageDown className="w-4 h-4" />
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
          <span className="text-xs text-muted-foreground ml-1">scroll to zoom · drag to pan</span>
        </div>
      </div>

      {/* Canvas container — scrollable in separate mode when many channels */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative overflow-y-auto overflow-x-hidden"
        style={{ cursor: 'crosshair' }}
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onDoubleClick={handleDoubleClick}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ touchAction: 'none' }}
          data-testid="telemetry-canvas"
        />
      </div>

      {deltaMode && (
        <DeltaPanel store={deltaStore} channels={visibleChannels} channelDataMap={channelDataMap} onClose={closeDelta} />
      )}

      {unitMenu && (() => {
        const chans = unitMenu.channelIds.flatMap(id => {
          const sc = session.channels.get(id);
          const dc = derivedChannels?.find(d => d.id === id);
          const shortName = sc?.shortName ?? dc?.name;
          return shortName === undefined ? [] : [{ shortName, rawUnit: sc?.units ?? dc?.units ?? '' }];
        });
        if (chans.length === 0) return null;
        const first = chans[0];
        const sysOnly = { unitSystem: prefs.unitSystem, unitOverrides: {} };
        return (
          <ChartUnitMenu
            channels={chans}
            options={convertibleUnits(first.rawUnit)}
            current={resolveDisplayUnit(first.shortName, first.rawUnit, prefs)}
            defaultUnit={resolveDisplayUnit(first.shortName, first.rawUnit, sysOnly)}
            overridden={chans.some(c => prefs.unitOverrides[c.shortName] !== undefined)}
            x={Math.min(unitMenu.x + 4, Math.max(0, canvasSizeRef.current.w - 180))}
            y={unitMenu.y + 4 + (toolbarRef.current?.offsetHeight ?? 0) - (containerRef.current?.scrollTop ?? 0)}
            onPick={unit => {
              const next = { ...prefs.unitOverrides };
              for (const c of chans) {
                if (unit === null || !convertibleUnits(c.rawUnit).includes(unit)) delete next[c.shortName];
                else next[c.shortName] = unit;
              }
              updatePrefs({ unitOverrides: next });
              setUnitMenu(null);
            }}
            onClose={() => setUnitMenu(null)}
          />
        );
      })()}

      <Presence show={!!imageExportSpec}>
        {imageExportSpec && (
        <ImageExportDialog spec={imageExportSpec} onClose={closeImageExport} />
        )}
      </Presence>
    </div>
  );
}
