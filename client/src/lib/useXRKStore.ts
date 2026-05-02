/**
 * QuickScope Global State Store
 * Manages parsed XRK session data and UI state
 */
import { useState, useCallback } from 'react';
import type { XRKSession, ChannelDef, ChannelSample, ParseProgress } from './xrk-parser';
import { evaluateFormula, extractChannelNames } from './formula-engine';
import { fetchChannelData } from './api';

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
  };
}
