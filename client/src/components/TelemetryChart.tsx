import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { formatTime } from '../lib/xrk-parser';
import type { ChannelSample } from '../lib/xrk-parser';
import { RotateCcw } from 'lucide-react';
import {
  type TelemetryChartProps, type StripLayout, type DrawContext,
  LEFT_MARGIN, RIGHT_MARGIN, BOTTOM_AXIS_HEIGHT, MIN_STRIP_HEIGHT, AXIS_WIDTH,
  DEBOUNCE_MS,
  clamp, niceAxisTicks, getChartColors,
} from '../lib/chart-utils';
import { computeOverlayYRanges, drawStrips, drawOverlayLegend, drawXAxis } from '../lib/chart-draw';
import { drawCursors } from '../lib/chart-cursors';

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
  chartMode = 'separate',
}: TelemetryChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [deltaMode, setDeltaMode] = useState(false);
  const [cursorStyle, setCursorStyle] = useState<string>('crosshair');

  // ─── Refs for transient state (no React re-renders) ─────────────────────
  const cursorEmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Cache for global min/max per channel (recomputed when channelDataMap changes)
  const globalMinMaxCache = useRef<Map<number, { minSample: ChannelSample; maxSample: ChannelSample }>>(new Map());
  // Smoothed Y-ranges: lerp toward target to avoid jumps. Key is channelId or "overlay:units".
  const smoothedYRanges = useRef<Map<string, [number, number]>>(new Map());

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
      return { leftMargin: LEFT_MARGIN, rightMargin: RIGHT_MARGIN };
    }
    const n = overlayAxisLayout.axisCount;
    const leftCount = Math.ceil(n / 2);
    const rightCount = Math.floor(n / 2);
    return {
      leftMargin: Math.max(LEFT_MARGIN, leftCount * AXIS_WIDTH),
      rightMargin: Math.max(RIGHT_MARGIN, rightCount * AXIS_WIDTH),
    };
  }, [chartMode, overlayAxisLayout]);

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
    // Reset smoothed Y-ranges so new channels start without stale lerp state
    smoothedYRanges.current.clear();
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

  // ─── Visible-range filter ─────────────────────────────────────────────
  const getVisibleSamples = useCallback((
    _channelId: number,
    allSamples: ChannelSample[],
    xRange: [number, number],
    _canvasWidth: number,
  ): ChannelSample[] => {
    // Filter to visible range with small padding for context
    const rangePad = (xRange[1] - xRange[0]) * 0.02;
    const lo = (xRange[0] - rangePad) * 1000;
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

    return allSamples.slice(startIdx, endIdx + 1);
  }, []);

  // ─── Compute strip layout ─────────────────────────────────────────────
  const computeStripLayouts = useCallback((canvasH: number): StripLayout[] => {
    const plotH = canvasH - BOTTOM_AXIS_HEIGHT;
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
  }, [visibleChannels, channelDataMap, chartMode]);

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
      timeToX, getVisibleSamples, overlayAxisLayout, session,
      smoothedYRanges: smoothedYRanges.current,
      needsDrawRef,
      colors,
    };

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    computeOverlayYRanges(dc);
    drawStrips(dc, globalMinMaxCache.current);
    drawOverlayLegend(dc);
    const axisY = drawXAxis(dc);
    drawCursors(dc, {
      cursorA: cursorXRef.current,
      cursorB: cursor2XRef.current,
      hoverT: hoverXRef.current,
      deltaMode: deltaModeRef.current,
    }, axisY);

    ctx.restore();
  }, [session, sessionDuration, channelDataMap, visibleChannels, computeStripLayouts, timeToX, getVisibleSamples, leftMargin, rightMargin, chartMode, overlayAxisLayout]);


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

  // ─── Compute required canvas height for separate mode ─────────────────
  const numVisible = visibleChannels.length;
  const requiredCanvasHeight = useMemo(() => {
    if (chartMode === 'overlay' || numVisible === 0) return 0; // 0 = use container height
    return numVisible * MIN_STRIP_HEIGHT + BOTTOM_AXIS_HEIGHT;
  }, [chartMode, numVisible]);

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
      needsDrawRef.current = true;
    };

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    return () => ro.disconnect();
  }, [requiredCanvasHeight, numVisible]); // re-run when canvas appears or size changes

  // Trigger redraws when data or display mode changes
  useEffect(() => {
    needsDrawRef.current = true;
  }, [channelDataMap, visibleChannels, viewRange, chartMode]);

  // Clear smoothed Y-ranges when chart mode changes to avoid stale lerp state
  useEffect(() => {
    smoothedYRanges.current.clear();
  }, [chartMode]);

  // ─── Mouse events ─────────────────────────────────────────────────────
  const getEffectiveXRange = useCallback((): [number, number] => {
    return xRangeRef.current || [0, sessionDuration];
  }, [sessionDuration]);

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
      needsDrawRef.current = true;
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [numVisible]); // re-run when canvas appears (0→N channels)

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
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
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
        // Throttle state emit so GPS map updates without causing excessive re-renders
        if (onCursorTimeChange && !cursorEmitTimer.current) {
          cursorEmitTimer.current = setTimeout(() => {
            cursorEmitTimer.current = null;
            if (cursorXRef.current !== null) onCursorTimeChange(cursorXRef.current);
          }, 60);
        }
      }
      needsDrawRef.current = true;
    }
  }, [sessionDuration, getEffectiveXRange, xToTime, emitViewRange, leftMargin, rightMargin, onCursorTimeChange]);

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
        const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
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
  }, [getEffectiveXRange, xToTime, leftMargin, rightMargin]);

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
    const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
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
      needsDrawRef.current = true;
    }
  }, [sessionDuration, xToTime, emitViewRange, leftMargin, rightMargin]);

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
          const plotW = canvasSizeRef.current.w - leftMargin - rightMargin;
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
  }, [getEffectiveXRange, xToTime, onCursorTimeChange, leftMargin, rightMargin]);

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

      {/* Canvas container — scrollable in separate mode when many channels */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative overflow-y-auto overflow-x-hidden"
        style={{ cursor: cursorStyle }}
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
    </div>
  );
}
