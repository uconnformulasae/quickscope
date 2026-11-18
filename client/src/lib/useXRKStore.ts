/**
 * QuickScope Global State Store
 * Manages parsed XRK session data and UI state
 */
import { useState, useCallback, useMemo, useRef } from 'react';
import type { XRKSession, ChannelSample, ParseProgress } from './xrk-parser';
import { evaluateFormula, extractChannelNames } from './formula-engine';
import { API_BASE, fetchChannelData } from './api';
import { createCursorStore } from './cursorStore';

export interface ActiveChannel {
  channelId: number;
  color: string;
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

  // Chart display mode
  chartMode: ChartMode;

  // Laps selected in the Laps tab (indices into lap windows), in selection order
  selectedLaps: number[];

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

const SESSION_CHANGED = 'Session changed during evaluation';

/** State that refers to the loaded session's channels or timeline, and so
 *  must not survive a switch to another session. */
const SESSION_SCOPED_RESET = {
  activeChannels: [],
  derivedChannels: [],
  viewRange: null,
  histogramChannelId: null,
  xyXChannelId: null,
  xyYChannelId: null,
  selectedLaps: [],
} satisfies Partial<AppState>;

/** Build channel data map for formula/python evaluation.
 *  Uses a lazy Proxy cache to avoid duplicating large sample arrays until accessed. */
function buildChannelDataMap(
  session: XRKSession,
  existingDerived: DerivedChannel[],
  existingDerivedSamples: Map<number, ChannelSample[]>,
  excludeId?: number,
  extraSamples?: Map<number, ChannelSample[]>,
): Record<string, { timestamps: number[]; values: number[] }> {
  const cache = new Map<string, { timestamps: number[]; values: number[] }>();
  const resolvers = new Map<string, () => ChannelSample[] | undefined>();

  for (const [id, chanDef] of session.channels) {
    resolvers.set(chanDef.shortName, () => extraSamples?.get(id) ?? session.samples.get(id));
  }
  for (const dc of existingDerived) {
    if (dc.id === excludeId) continue;
    resolvers.set(dc.name, () => existingDerivedSamples.get(dc.id));
  }

  function samplesTo(samps: ChannelSample[]): { timestamps: number[]; values: number[] } {
    const timestamps = new Array<number>(samps.length);
    const values = new Array<number>(samps.length);
    for (let i = 0; i < samps.length; i++) {
      timestamps[i] = samps[i].timestamp;
      values[i] = samps[i].value;
    }
    return { timestamps, values };
  }

  return new Proxy({} as Record<string, { timestamps: number[]; values: number[] }>, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      if (cache.has(prop)) return cache.get(prop);
      const resolver = resolvers.get(prop);
      if (!resolver) return undefined;
      const samps = resolver();
      if (!samps || samps.length === 0) return undefined;
      const converted = samplesTo(samps);
      cache.set(prop, converted);
      return converted;
    },
    has(_target, prop: string | symbol) {
      return typeof prop === 'string' && resolvers.has(prop);
    },
    ownKeys() {
      return Array.from(resolvers.keys());
    },
    getOwnPropertyDescriptor(_target, prop: string | symbol) {
      if (typeof prop === 'string' && resolvers.has(prop)) {
        return { enumerable: true, configurable: true };
      }
      return undefined;
    },
  });
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

/** Channel names a Python script refers to. Scripts read channels as
 *  `channels['Name']` (see DerivedChannelDialog), so a name counts as used
 *  when it appears as a quoted string literal. */
function pythonReferencedNames(expression: string, names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (expression.includes(`'${name}'`) || expression.includes(`"${name}"`)) out.push(name);
  }
  return out;
}

/** Evaluate a Python expression via the backend */
async function computePythonSamples(
  expression: string,
  channelData: Record<string, { timestamps: number[]; values: number[] }>,
): Promise<ChannelSample[] | string> {
  // Send only the channels the script uses. Serialising the whole lazy map
  // would materialise every loaded channel into one huge JSON body.
  const payload: Record<string, { timestamps: number[]; values: number[] }> = {};
  for (const name of pythonReferencedNames(expression, Object.keys(channelData))) {
    const data = channelData[name];
    if (data) payload[name] = data;
  }
  try {
    const resp = await fetch(`${API_BASE}/api/derived/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression, channels: payload }),
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
    chartMode: 'separate',
    selectedLaps: [],
    viewMode: 'chart' as ViewMode,
    leftSidebarOpen: true,
    rightSidebarOpen: true,
    channelSearch: '',
    showOnlyWithData: false,
  });

  // Separate map for derived channel samples (not in state to keep it fast)
  const [derivedSamplesMap, setDerivedSamplesMap] = useState<Map<number, ChannelSample[]>>(new Map());

  // One counter for "which session is this work for". It moves on every
  // session change (a load starting, a session being set or cleared), so async
  // work captures it up front and checks it after each await. Channel indices
  // are reused between sessions, so a result that lands late would otherwise
  // be written into whichever session is on screen by then.
  const sessionGenRef = useRef(0);
  const sessionMetadataRef = useRef<XRKSession['metadata'] | null>(null);

  const getSessionGeneration = useCallback(() => sessionGenRef.current, []);
  const isCurrentSession = useCallback((generation: number) => sessionGenRef.current === generation, []);
  /** Call when a session load starts: everything in flight is now stale. */
  const beginSessionChange = useCallback(() => ++sessionGenRef.current, []);

  // The chart cursor (seconds) lives outside `state`: it tracks the mouse, and
  // as a state field every move re-rendered the whole app. See cursorStore.
  const cursorStore = useMemo(createCursorStore, []);

  const setSession = useCallback((session: XRKSession, fileName: string) => {
    cursorStore.set(null);
    // Re-setting the same session (a rename) keeps in-flight work valid.
    if (sessionMetadataRef.current !== session.metadata) {
      sessionMetadataRef.current = session.metadata;
      sessionGenRef.current++;
    }
    setState(prev => ({
      ...prev,
      session,
      fileName,
      isLoading: false,
      loadError: null,
      parseProgress: null,
      ...SESSION_SCOPED_RESET,
    }));
    setDerivedSamplesMap(new Map());
  }, [cursorStore]);

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
          activeChannels: [...prev.activeChannels, { channelId, color }],
        };
      }
    });
  }, []);

  /** Deselect every channel on the chart (derived channel definitions are kept). */
  const clearActiveChannels = useCallback(() => {
    setState(prev => ({ ...prev, activeChannels: [] }));
  }, []);

  const setViewRange = useCallback((range: TimeRange | null) => {
    setState(prev => ({ ...prev, viewRange: range }));
  }, []);

  const setCursorTime = cursorStore.set;

  const setAnalysisTab = useCallback((tab: AnalysisTab) => {
    setState(prev => ({ ...prev, analysisTab: tab }));
  }, []);

  const setChannelSearch = useCallback((search: string) => {
    setState(prev => ({ ...prev, channelSearch: search }));
  }, []);

  const setShowOnlyWithData = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showOnlyWithData: show }));
  }, []);

  // cursorTime is session time normally but lap-relative in compare mode
  // (2+ laps), so it is cleared whenever the selection crosses that line.
  const withLaps = (prev: AppState, selectedLaps: number[]): AppState => {
    const crossed = (prev.selectedLaps.length >= 2) !== (selectedLaps.length >= 2);
    if (crossed) cursorStore.set(null); // idempotent, so safe inside an updater
    return { ...prev, selectedLaps };
  };

  /** Restore a saved per-session view (see sessionViewState). Derived channels
   *  are re-added separately since they must be re-evaluated. */
  const applySessionView = useCallback((v: Pick<AppState,
    'activeChannels' | 'chartMode' | 'viewMode' | 'analysisTab' | 'viewRange' | 'selectedLaps'>) => {
    setState(prev => ({ ...prev, ...v }));
  }, []);

  const toggleLapSelected = useCallback((index: number) => {
    setState(prev => withLaps(prev, prev.selectedLaps.includes(index)
      ? prev.selectedLaps.filter(i => i !== index)
      : [...prev.selectedLaps, index]));
  }, []);

  const setSelectedLaps = useCallback((indices: number[]) => {
    setState(prev => withLaps(prev, indices));
  }, []);

  const setChartMode = useCallback((mode: ChartMode) => {
    setState(prev => ({ ...prev, chartMode: mode }));
  }, []);

  const setViewMode = useCallback((mode: ViewMode) => {
    setState(prev => ({ ...prev, viewMode: mode }));
  }, []);

  /** Store fetched samples. Pass the generation captured before the fetch so
   *  data that arrives after a session switch is dropped; returns false then. */
  const setChannelSamples = useCallback((channelId: number, samples: ChannelSample[], generation?: number) => {
    if (generation !== undefined && generation !== sessionGenRef.current) return false;
    setState(prev => {
      if (!prev.session) return prev;
      const newSamples = new Map(prev.session.samples);
      newSamples.set(channelId, samples);
      return { ...prev, session: { ...prev.session, samples: newSamples } };
    });
    return true;
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
    cursorStore.set(null);
    sessionMetadataRef.current = null;
    sessionGenRef.current++;
    setState(prev => ({
      ...prev,
      session: null,
      fileName: null,
      ...SESSION_SCOPED_RESET,
      loadError: null,
    }));
    setDerivedSamplesMap(new Map());
    derivedIdCounter = 10000; // reset to avoid unbounded growth
  }, [cursorStore]);

  // ─── Derived channel actions ──────────────────────────────────────────────

  /** Lazy-fetch any channels the expression references that aren't yet
   *  loaded into session.samples. Returns the freshly-fetched samples (passed
   *  to compute), and persists them to session state so subsequent operations
   *  don't refetch. Python scripts are matched by quoted channel names. */
  const ensureExpressionChannelsLoaded = useCallback(async (
    session: XRKSession,
    def: Omit<DerivedChannel, 'id' | 'color'>,
  ): Promise<Map<number, ChannelSample[]>> => {
    const referenced = def.mode === 'formula'
      ? extractChannelNames(def.expression)
      : pythonReferencedNames(def.expression, Array.from(session.channels.values(), c => c.shortName));
    if (referenced.length === 0) return new Map();
    const generation = sessionGenRef.current;
    const fetched = await fetchMissingChannels(session, referenced);
    if (fetched.size > 0 && generation === sessionGenRef.current) {
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

    // `state.session` here is this render's value and can never differ from
    // `session`; only the generation ref sees a switch that happened meanwhile.
    const generation = sessionGenRef.current;
    const extraSamples = await ensureExpressionChannelsLoaded(session, def);
    if (generation !== sessionGenRef.current) return { error: SESSION_CHANGED };
    const result = await computeDerivedSamples(newDef, session, state.derivedChannels, derivedSamplesMap, extraSamples);
    if (generation !== sessionGenRef.current) return { error: SESSION_CHANGED };
    if (typeof result === 'string') return { error: result };

    setState(prev => ({
      ...prev,
      derivedChannels: [...prev.derivedChannels, newDef],
      activeChannels: [...prev.activeChannels, { channelId: id, color }],
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
    const generation = sessionGenRef.current;
    const extraSamples = await ensureExpressionChannelsLoaded(session, def);
    if (generation !== sessionGenRef.current) return { error: SESSION_CHANGED };
    const result = await computeDerivedSamples(updated, session, state.derivedChannels, derivedSamplesMap, extraSamples);
    if (generation !== sessionGenRef.current) return { error: SESSION_CHANGED };
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
    const generation = sessionGenRef.current;
    const extraSamples = await ensureExpressionChannelsLoaded(session, def);
    if (generation !== sessionGenRef.current) return SESSION_CHANGED;
    const result = await computeDerivedSamples(tempDef, session, state.derivedChannels, derivedSamplesMap, extraSamples);
    if (generation !== sessionGenRef.current) return SESSION_CHANGED;
    if (typeof result === 'string') return result;

    return {
      timestamps: result.map(s => s.timestamp),
      values: result.map(s => s.value),
    };
  }, [state.session, state.derivedChannels, derivedSamplesMap, ensureExpressionChannelsLoaded]);

  return {
    state,
    derivedSamplesMap,
    cursorStore,
    setSession,
    setLoading,
    setError,
    setProgress,
    toggleChannel,
    clearActiveChannels,
    setViewRange,
    setCursorTime,
    setAnalysisTab,
    setChannelSearch,
    setShowOnlyWithData,
    setChartMode,
    toggleLapSelected,
    setSelectedLaps,
    applySessionView,
    setViewMode,
    toggleLeftSidebar,
    toggleRightSidebar,
    setHistogramChannel,
    setXYChannels,
    clearSession,
    setChannelSamples,
    getSessionGeneration,
    isCurrentSession,
    beginSessionChange,
    addDerivedChannel,
    removeDerivedChannel,
    updateDerivedChannel,
    previewDerivedChannel,
  };
}
