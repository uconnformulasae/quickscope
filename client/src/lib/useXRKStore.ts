/**
 * QuickScope Global State Store
 * Manages parsed XRK session data and UI state
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import type { XRKSession, ChannelDef, ChannelSample, ParseProgress } from './xrk-parser';
import { evaluateFormula, extractChannelNames } from './formula-engine';
import {
  fetchChannelData, fetchSessionInfo, fetchSessionChannelData, fetchSessionLaps,
  type SessionInfo,
} from './api';
import type { OverlayState, OverlayAlignment } from './overlay-types';
import { defaultAlignment } from './overlay-alignment';

export interface ActiveChannel {
  channelId: number;
  color: string;
  visible: boolean;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export type AnalysisTab = 'stats' | 'histogram' | 'xyplot' | 'lapanalysis' | 'gps';

export type ChartMode = 'separate' | 'overlay';

export type ViewMode = 'chart' | 'table';

export interface DerivedChannel {
  id: number;
  name: string;
  units: string;
  mode: 'formula' | 'python';
  expression: string;
  color: string;
}

export interface AppState {
  // Session data
  session: XRKSession | null;
  isLoading: boolean;
  loadError: string | null;
  parseProgress: ParseProgress | null;
  fileName: string | null;

  // Active channels
  activeChannels: ActiveChannel[];

  // Derived channels
  derivedChannels: DerivedChannel[];

  // Multi-session overlays. Empty array when no overlays loaded.
  overlays: OverlayState[];

  // Time viewport (milliseconds)
  viewRange: TimeRange | null;

  // Analysis panel
  analysisTab: AnalysisTab;
  histogramChannelId: number | null;
  xyXChannelId: number | null;
  xyYChannelId: number | null;

  // Cursor navigation
  cursorTime: number | null; // seconds

  // Chart display mode
  chartMode: ChartMode;

  // View mode (chart vs table)
  viewMode: ViewMode;

  // UI state
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  channelSearch: string;
  showOnlyWithData: boolean;
}

const DERIVED_CHART_COLORS = [
  '#f43f5e', '#8b5cf6', '#06b6d4', '#84cc16', '#fb923c',
  '#a855f7', '#22d3ee', '#facc15', '#ec4899', '#10b981',
];

let derivedIdCounter = 10000;

/** Build channel data map for formula/python evaluation.
 *  Uses a lazy cache to avoid duplicating large sample arrays until accessed. */
function buildChannelDataMap(
  session: XRKSession,
  existingDerived: DerivedChannel[],
  existingDerivedSamples: Map<number, ChannelSample[]>,
  excludeId?: number,
  extraSamples?: Map<number, ChannelSample[]>,
): Record<string, { timestamps: number[]; values: number[] }> {
  const channelData: Record<string, { timestamps: number[]; values: number[] }> = {};

  // Helper: extract timestamps/values from ChannelSample[] only once per channel
  function samplesTo(samps: ChannelSample[]): { timestamps: number[]; values: number[] } {
    const timestamps = new Array<number>(samps.length);
    const values = new Array<number>(samps.length);
    for (let i = 0; i < samps.length; i++) {
      timestamps[i] = samps[i].timestamp;
      values[i] = samps[i].value;
    }
    return { timestamps, values };
  }

  for (const [id, chanDef] of session.channels) {
    // extraSamples wins so just-fetched data is visible before React state catches up
    const samps = extraSamples?.get(id) ?? session.samples.get(id);
    if (!samps || samps.length === 0) continue; // skip empty channels entirely
    channelData[chanDef.shortName] = samplesTo(samps);
  }
  for (const dc of existingDerived) {
    if (dc.id === excludeId) continue;
    const samps = existingDerivedSamples.get(dc.id);
    if (!samps || samps.length === 0) continue;
    channelData[dc.name] = samplesTo(samps);
  }
  return channelData;
}

/** Fetch any of `needed` channel names that exist in the session but haven't
 *  been pulled to the client yet. Returns the fetched samples keyed by channel id. */
async function fetchMissingChannels(
  session: XRKSession,
  needed: string[],
): Promise<Map<number, ChannelSample[]>> {
  const out = new Map<number, ChannelSample[]>();
  if (needed.length === 0) return out;

  const missing: { id: number; name: string }[] = [];
  for (const name of needed) {
    const def = Array.from(session.channels.values()).find(c => c.shortName === name);
    if (!def) continue; // unknown name — let the evaluator throw its own error
    const existing = session.samples.get(def.index);
    if (existing && existing.length > 0) continue;
    if ((def.fileSampleCount ?? 0) === 0) continue; // device recorded no data for this channel
    missing.push({ id: def.index, name });
  }
  if (missing.length === 0) return out;

  const dataMap = await fetchChannelData(missing.map(m => m.name));
  for (const { id, name } of missing) {
    const data = dataMap.get(name);
    if (!data) continue;
    const samps: ChannelSample[] = data.timestamps.map((t, i) => ({ timestamp: t, value: data.values[i] }));
    out.set(id, samps);
  }
  return out;
}

/** Evaluate a formula expression synchronously */
function computeFormulaSamples(
  expression: string,
  channelData: Record<string, { timestamps: number[]; values: number[] }>,
): ChannelSample[] | string {
  const result = evaluateFormula(expression, channelData);
  if (typeof result === 'string') return result;
  return result.timestamps.map((t, i) => ({ timestamp: t, value: result.values[i] }));
}

const BACKEND_URL =
  (typeof window !== 'undefined' && window.__QUICKSCOPE_BACKEND__) ||
  `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:8000`;

/** Evaluate a Python expression via the backend */
async function computePythonSamples(
  expression: string,
  channelData: Record<string, { timestamps: number[]; values: number[] }>,
): Promise<ChannelSample[] | string> {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/derived/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression, channels: channelData }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ message: resp.statusText }));
      return body.detail || body.message || `Server error: ${resp.status}`;
    }
    const result = await resp.json();
    return result.timestamps.map((t: number, i: number) => ({ timestamp: t, value: result.values[i] }));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Convert DerivedChannel definition to samples — async to support Python mode */
async function computeDerivedSamples(
  def: DerivedChannel,
  session: XRKSession,
  existingDerived: DerivedChannel[],
  existingDerivedSamples: Map<number, ChannelSample[]>,
  extraSamples?: Map<number, ChannelSample[]>,
): Promise<ChannelSample[] | string> {
  const channelData = buildChannelDataMap(session, existingDerived, existingDerivedSamples, def.id, extraSamples);
  if (def.mode === 'formula') {
    return computeFormulaSamples(def.expression, channelData);
  }
  return computePythonSamples(def.expression, channelData);
}

export function useAppState() {
  const [state, setState] = useState<AppState>({
    session: null,
    isLoading: false,
    loadError: null,
    parseProgress: null,
    fileName: null,
    activeChannels: [],
    derivedChannels: [],
    overlays: [],
    viewRange: null,
    analysisTab: 'stats',
    histogramChannelId: null,
    xyXChannelId: null,
    xyYChannelId: null,
    cursorTime: null,
    chartMode: 'separate',
    viewMode: 'chart' as ViewMode,
    leftSidebarOpen: true,
    rightSidebarOpen: true,
    channelSearch: '',
    showOnlyWithData: false,
  });

  // Separate map for derived channel samples (not in state to keep it fast)
  const [derivedSamplesMap, setDerivedSamplesMap] = useState<Map<number, ChannelSample[]>>(new Map());

  // Mirror state into a ref so async callbacks (notably the overlay flow,
  // which fires `addOverlay` immediately after `setSession`) always read the
  // latest values instead of a stale closure capture from the render that
  // started the operation. Without this, addOverlay's early `state.session`
  // read is null right after a fresh load, even though state has been queued.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const setSession = useCallback((session: XRKSession, fileName: string) => {
    setState(prev => ({
      ...prev,
      session,
      fileName,
      isLoading: false,
      loadError: null,
      parseProgress: null,
      activeChannels: [],
      derivedChannels: [],
      overlays: [],
      viewRange: null,
    }));
    setDerivedSamplesMap(new Map());
  }, []);

  const setLoading = useCallback((loading: boolean, progress?: ParseProgress) => {
    setState(prev => ({
      ...prev,
      isLoading: loading,
      parseProgress: progress || prev.parseProgress,
      loadError: loading ? null : prev.loadError,
    }));
  }, []);

  const setError = useCallback((error: string) => {
    setState(prev => ({ ...prev, isLoading: false, loadError: error, parseProgress: null }));
  }, []);

  const setProgress = useCallback((progress: ParseProgress) => {
    setState(prev => ({ ...prev, parseProgress: progress }));
  }, []);

  const toggleChannel = useCallback((channelId: number, color: string) => {
    setState(prev => {
      const existing = prev.activeChannels.find(c => c.channelId === channelId);
      if (existing) {
        return {
          ...prev,
          activeChannels: prev.activeChannels.filter(c => c.channelId !== channelId),
        };
      } else {
        return {
          ...prev,
          activeChannels: [...prev.activeChannels, { channelId, color, visible: true }],
        };
      }
    });
  }, []);

  const setViewRange = useCallback((range: TimeRange | null) => {
    setState(prev => ({ ...prev, viewRange: range }));
  }, []);

  const setCursorTime = useCallback((t: number | null) => {
    setState(prev => ({ ...prev, cursorTime: t }));
  }, []);

  const setAnalysisTab = useCallback((tab: AnalysisTab) => {
    setState(prev => ({ ...prev, analysisTab: tab }));
  }, []);

  const setChannelSearch = useCallback((search: string) => {
    setState(prev => ({ ...prev, channelSearch: search }));
  }, []);

  const setShowOnlyWithData = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showOnlyWithData: show }));
  }, []);

  const setChartMode = useCallback((mode: ChartMode) => {
    setState(prev => ({ ...prev, chartMode: mode }));
  }, []);

  const setViewMode = useCallback((mode: ViewMode) => {
    setState(prev => ({ ...prev, viewMode: mode }));
  }, []);

  const setChannelSamples = useCallback((channelId: number, samples: ChannelSample[]) => {
    setState(prev => {
      if (!prev.session) return prev;
      const newSamples = new Map(prev.session.samples);
      newSamples.set(channelId, samples);
      return { ...prev, session: { ...prev.session, samples: newSamples } };
    });
  }, []);

  const toggleLeftSidebar = useCallback(() => {
    setState(prev => ({ ...prev, leftSidebarOpen: !prev.leftSidebarOpen }));
  }, []);

  const toggleRightSidebar = useCallback(() => {
    setState(prev => ({ ...prev, rightSidebarOpen: !prev.rightSidebarOpen }));
  }, []);

  const setHistogramChannel = useCallback((id: number | null) => {
    setState(prev => ({ ...prev, histogramChannelId: id }));
  }, []);

  const setXYChannels = useCallback((xId: number | null, yId: number | null) => {
    setState(prev => ({ ...prev, xyXChannelId: xId, xyYChannelId: yId }));
  }, []);

  const clearSession = useCallback(() => {
    setState(prev => ({
      ...prev,
      session: null,
      fileName: null,
      activeChannels: [],
      derivedChannels: [],
      overlays: [],
      viewRange: null,
      loadError: null,
    }));
    setDerivedSamplesMap(new Map());
    derivedIdCounter = 10000; // reset to avoid unbounded growth
  }, []);

  // ─── Derived channel actions ──────────────────────────────────────────────

  /** For formula mode, lazy-fetch any channels the expression references that
   *  aren't yet loaded into session.samples. Returns the freshly-fetched
   *  samples (passed to compute), and persists them to session state so
   *  subsequent operations don't refetch. Python mode is a no-op — we can't
   *  statically determine which channels a script will touch. */
  const ensureExpressionChannelsLoaded = useCallback(async (
    session: XRKSession,
    def: Omit<DerivedChannel, 'id' | 'color'>,
  ): Promise<Map<number, ChannelSample[]>> => {
    if (def.mode !== 'formula') return new Map();
    const referenced = extractChannelNames(def.expression);
    if (referenced.length === 0) return new Map();
    const fetched = await fetchMissingChannels(session, referenced);
    if (fetched.size > 0) {
      setState(prev => {
        if (!prev.session) return prev;
        const newSamples = new Map(prev.session.samples);
        for (const [id, samps] of fetched) newSamples.set(id, samps);
        return { ...prev, session: { ...prev.session, samples: newSamples } };
      });
    }
    return fetched;
  }, []);

  const addDerivedChannel = useCallback(async (
    def: Omit<DerivedChannel, 'id' | 'color'>
  ): Promise<{ error: string } | { id: number }> => {
    const session = state.session;
    if (!session) return { error: 'No session loaded' };

    const id = derivedIdCounter++;
    const color = DERIVED_CHART_COLORS[id % DERIVED_CHART_COLORS.length];
    const newDef: DerivedChannel = { ...def, id, color };

    const extraSamples = await ensureExpressionChannelsLoaded(session, def);
    const result = await computeDerivedSamples(newDef, session, state.derivedChannels, derivedSamplesMap, extraSamples);
    if (typeof result === 'string') return { error: result };

    setState(prev => ({
      ...prev,
      derivedChannels: [...prev.derivedChannels, newDef],
      activeChannels: [...prev.activeChannels, { channelId: id, color, visible: true }],
    }));

    setDerivedSamplesMap(prev => {
      const next = new Map(prev);
      next.set(id, result);
      return next;
    });

    return { id };
  }, [state.session, state.derivedChannels, derivedSamplesMap, ensureExpressionChannelsLoaded]);

  const removeDerivedChannel = useCallback((id: number) => {
    setState(prev => ({
      ...prev,
      derivedChannels: prev.derivedChannels.filter(d => d.id !== id),
      activeChannels: prev.activeChannels.filter(c => c.channelId !== id),
    }));
    setDerivedSamplesMap(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const updateDerivedChannel = useCallback(async (
    id: number,
    def: Omit<DerivedChannel, 'id' | 'color'>
  ): Promise<{ error: string } | { id: number }> => {
    const session = state.session;
    if (!session) return { error: 'No session loaded' };

    const existing = state.derivedChannels.find(d => d.id === id);
    if (!existing) return { error: 'Channel not found' };

    const updated: DerivedChannel = { ...existing, ...def };
    const extraSamples = await ensureExpressionChannelsLoaded(session, def);
    const result = await computeDerivedSamples(updated, session, state.derivedChannels, derivedSamplesMap, extraSamples);
    if (typeof result === 'string') return { error: result };

    setState(prev => ({
      ...prev,
      derivedChannels: prev.derivedChannels.map(d => d.id === id ? updated : d),
    }));

    setDerivedSamplesMap(prev => {
      const next = new Map(prev);
      next.set(id, result);
      return next;
    });

    return { id };
  }, [state.session, state.derivedChannels, derivedSamplesMap, ensureExpressionChannelsLoaded]);

  /**
   * Preview derived channel (evaluate but don't commit to state)
   */
  const previewDerivedChannel = useCallback(async (
    def: Omit<DerivedChannel, 'id' | 'color'>,
    existingId?: number,
  ): Promise<{ timestamps: number[]; values: number[] } | string> => {
    const session = state.session;
    if (!session) return 'No session loaded';

    const tempDef: DerivedChannel = { ...def, id: existingId ?? -1, color: '#ffffff' };
    const extraSamples = await ensureExpressionChannelsLoaded(session, def);
    const result = await computeDerivedSamples(tempDef, session, state.derivedChannels, derivedSamplesMap, extraSamples);
    if (typeof result === 'string') return result;

    return {
      timestamps: result.map(s => s.timestamp),
      values: result.map(s => s.value),
    };
  }, [state.session, state.derivedChannels, derivedSamplesMap, ensureExpressionChannelsLoaded]);

  // ─── Overlay actions ────────────────────────────────────────────────────

  const buildOverlaySession = useCallback(async (info: SessionInfo): Promise<XRKSession> => {
    const channels = new Map<number, ChannelDef>();
    for (const ch of info.channels) {
      channels.set(ch.index, {
        index: ch.index,
        shortName: ch.name,
        longName: ch.name,
        sampleRateRaw: ch.sampleRateHz > 0 ? Math.round(1e6 / ch.sampleRateHz) : 0,
        sampleRateHz: ch.sampleRateHz,
        units: ch.units,
        color: ch.color,
        fileSampleCount: ch.sampleCount,
      });
    }
    const samples = new Map<number, ChannelSample[]>();
    for (const ch of info.channels) samples.set(ch.index, []);
    return {
      metadata: {
        vehicle: info.metadata.vehicle || 'Unknown',
        driver: info.metadata.driver || 'Unknown',
        date: info.metadata.date || 'Unknown',
        time: info.metadata.time || 'Unknown',
        venue: info.metadata.venue || 'Unknown',
        championship: info.metadata.championship || 'Unknown',
        sessionType: info.metadata.sessionType || 'Unknown',
      },
      channels,
      samples,
      lapMarkers: [],
      lapSource: 'none',
      durationMs: info.durationMs,
      totalSamples: info.totalSamples,
    };
  }, []);

  const addOverlay = useCallback(async (
    sessionId: string,
    label: string,
    primaryOverride?: XRKSession,
  ): Promise<{ error: string } | { id: string }> => {
    // Read via ref — caller may invoke us right after setSession() schedules
    // a state update but before React commits, so closure-captured `state` is
    // stale. stateRef.current always reflects the latest committed state.
    // primaryOverride lets the caller bypass even the ref read for the
    // race-condition case where setState hasn't committed yet (e.g., immediately
    // after handleSessionLoaded → buildAndSetSession returns).
    const primary = primaryOverride ?? stateRef.current.session;
    if (!primary) return { error: 'Load a primary session first' };
    if (stateRef.current.overlays.some(o => o.id === sessionId)) return { error: 'Already an overlay' };

    try {
      const info = await fetchSessionInfo(sessionId);
      const overlaySession = await buildOverlaySession(info);
      // Pull lap markers (best-effort; alignment fallback handles 'none')
      try {
        const laps = await fetchSessionLaps(sessionId);
        if (laps.laps.length > 0) {
          overlaySession.lapMarkers = laps.laps.map(l => ({
            timestamp: l.startTime, lapNumber: l.lapNumber,
          }));
          const last = laps.laps[laps.laps.length - 1];
          overlaySession.lapMarkers.push({ timestamp: last.endTime, lapNumber: last.lapNumber + 1 });
          overlaySession.lapSource = laps.source;
        }
      } catch { /* leave lapMarkers empty */ }

      const overlay: OverlayState = {
        id: sessionId,
        label,
        session: overlaySession,
        visible: true,
        alignment: defaultAlignment(primary, overlaySession),
        samples: new Map(),
        derivedSamples: new Map(),
      };
      setState(prev => ({ ...prev, overlays: [...prev.overlays, overlay] }));
      return { id: sessionId };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Failed to add overlay' };
    }
  }, [buildOverlaySession]);

  const removeOverlay = useCallback((sessionId: string) => {
    setState(prev => ({ ...prev, overlays: prev.overlays.filter(o => o.id !== sessionId) }));
  }, []);

  const toggleOverlayVisibility = useCallback((sessionId: string) => {
    setState(prev => ({
      ...prev,
      overlays: prev.overlays.map(o => o.id === sessionId ? { ...o, visible: !o.visible } : o),
    }));
  }, []);

  const updateOverlayAlignment = useCallback((sessionId: string, alignment: OverlayAlignment) => {
    setState(prev => ({
      ...prev,
      overlays: prev.overlays.map(o => o.id === sessionId ? { ...o, alignment } : o),
    }));
  }, []);

  /** Lazy-fetch overlay channel samples by primary channel id. Resolves by
   *  shortName equality. No-op if already present or no match. */
  const ensureOverlayChannelLoaded = useCallback(async (
    sessionId: string,
    primaryChannelId: number,
  ): Promise<void> => {
    const primary = stateRef.current.session;
    if (!primary) return;
    const overlay = stateRef.current.overlays.find(o => o.id === sessionId);
    if (!overlay) return;
    const primaryDef = primary.channels.get(primaryChannelId);
    if (!primaryDef) return;

    // Find matching overlay channel by shortName
    let overlayChId = -1;
    for (const [oid, odef] of overlay.session.channels) {
      if (odef.shortName === primaryDef.shortName) { overlayChId = oid; break; }
    }
    if (overlayChId === -1) return; // no match — silent
    const existing = overlay.samples.get(overlayChId);
    if (existing && existing.length > 0) return;

    try {
      const dataMap = await fetchSessionChannelData(sessionId, [primaryDef.shortName]);
      const data = dataMap.get(primaryDef.shortName);
      if (!data) return;
      const samples: ChannelSample[] = data.timestamps.map((t, i) => ({ timestamp: t, value: data.values[i] }));
      setState(prev => ({
        ...prev,
        overlays: prev.overlays.map(o => {
          if (o.id !== sessionId) return o;
          const next = new Map(o.samples);
          next.set(overlayChId, samples);
          return { ...o, samples: next };
        }),
      }));
    } catch (e) {
      console.error('Failed to fetch overlay channel data:', e);
    }
  }, []);

  /** Recompute formula-mode derived channels against an overlay. Lazy-fetches
   *  any base channels the formula references that aren't already loaded for
   *  the overlay. Skips Python-mode derived channels (primary-only by design). */
  const recomputeOverlayDerived = useCallback(async (sessionId: string) => {
    const primary = stateRef.current.session;
    if (!primary) return;
    const overlay = stateRef.current.overlays.find(o => o.id === sessionId);
    if (!overlay) return;
    const formulaDerived = stateRef.current.derivedChannels.filter(d => d.mode === 'formula');
    if (formulaDerived.length === 0) {
      if (overlay.derivedSamples.size > 0) {
        setState(prev => ({
          ...prev,
          overlays: prev.overlays.map(o => o.id === sessionId
            ? { ...o, derivedSamples: new Map() }
            : o),
        }));
      }
      return;
    }

    // Gather all referenced names across all formula derived channels
    const allNames = new Set<string>();
    for (const dc of formulaDerived) {
      for (const n of extractChannelNames(dc.expression)) allNames.add(n);
    }

    const namesToFetch: string[] = [];
    for (const name of allNames) {
      let overlayChId = -1;
      for (const [oid, odef] of overlay.session.channels) {
        if (odef.shortName === name) { overlayChId = oid; break; }
      }
      if (overlayChId === -1) continue;
      const already = overlay.samples.get(overlayChId);
      if (already && already.length > 0) continue;
      namesToFetch.push(name);
    }

    const freshSamples = new Map(overlay.samples);
    if (namesToFetch.length > 0) {
      try {
        const dataMap = await fetchSessionChannelData(sessionId, namesToFetch);
        for (const [name, data] of dataMap) {
          let overlayChId = -1;
          for (const [oid, odef] of overlay.session.channels) {
            if (odef.shortName === name) { overlayChId = oid; break; }
          }
          if (overlayChId === -1) continue;
          const samps: ChannelSample[] = data.timestamps.map((t, i) => ({ timestamp: t, value: data.values[i] }));
          freshSamples.set(overlayChId, samps);
        }
      } catch (e) {
        console.error('Overlay derived: failed to fetch channels:', e);
        return;
      }
    }

    // Build channelData keyed by shortName for the formula evaluator
    const channelData: Record<string, { timestamps: number[]; values: number[] }> = {};
    for (const [chId, samps] of freshSamples) {
      if (samps.length === 0) continue;
      const def = overlay.session.channels.get(chId);
      if (!def) continue;
      channelData[def.shortName] = {
        timestamps: samps.map(s => s.timestamp),
        values: samps.map(s => s.value),
      };
    }

    const newDerived = new Map<number, ChannelSample[]>();
    for (const dc of formulaDerived) {
      const result = evaluateFormula(dc.expression, channelData);
      if (typeof result === 'string') continue; // skip on error
      newDerived.set(dc.id, result.timestamps.map((t, i) => ({ timestamp: t, value: result.values[i] })));
    }

    setState(prev => ({
      ...prev,
      overlays: prev.overlays.map(o => o.id === sessionId
        ? { ...o, samples: freshSamples, derivedSamples: newDerived }
        : o),
    }));
  }, []);

  return {
    state,
    derivedSamplesMap,
    setSession,
    setLoading,
    setError,
    setProgress,
    toggleChannel,
    setViewRange,
    setCursorTime,
    setAnalysisTab,
    setChannelSearch,
    setShowOnlyWithData,
    setChartMode,
    setViewMode,
    toggleLeftSidebar,
    toggleRightSidebar,
    setHistogramChannel,
    setXYChannels,
    clearSession,
    setChannelSamples,
    addDerivedChannel,
    removeDerivedChannel,
    updateDerivedChannel,
    previewDerivedChannel,
    addOverlay,
    removeOverlay,
    toggleOverlayVisibility,
    updateOverlayAlignment,
    ensureOverlayChannelLoaded,
    recomputeOverlayDerived,
  };
}
