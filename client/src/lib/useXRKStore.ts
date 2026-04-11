/**
 * QuickScope Global State Store
 * Manages parsed XRK session data and UI state
 */
import { useState, useCallback } from 'react';
import type { XRKSession, ChannelDef, ChannelSample, ParseProgress } from './xrk-parser';
import { evaluateFormula } from './formula-engine';

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

  // UI state
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  channelSearch: string;
  showOnlyWithData: boolean;
}

// Max channels to auto-activate on load
const AUTO_SELECT_COUNT = 5;

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
    const samps = session.samples.get(id);
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

/** Evaluate a formula expression synchronously */
function computeFormulaSamples(
  expression: string,
  channelData: Record<string, { timestamps: number[]; values: number[] }>,
): ChannelSample[] | string {
  const result = evaluateFormula(expression, channelData);
  if (typeof result === 'string') return result;
  return result.timestamps.map((t, i) => ({ timestamp: t, value: result.values[i] }));
}

const BACKEND_URL = 'http://localhost:8000';

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
): Promise<ChannelSample[] | string> {
  const channelData = buildChannelDataMap(session, existingDerived, existingDerivedSamples, def.id);
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
    leftSidebarOpen: true,
    rightSidebarOpen: true,
    channelSearch: '',
    showOnlyWithData: false,
  });

  // Separate map for derived channel samples (not in state to keep it fast)
  const [derivedSamplesMap, setDerivedSamplesMap] = useState<Map<number, ChannelSample[]>>(new Map());

  const setSession = useCallback((session: XRKSession, fileName: string) => {
    // Auto-activate the first N channels that actually have data
    const defaultChannels: ActiveChannel[] = [];
    for (const [id, chan] of session.channels) {
      if (defaultChannels.length >= AUTO_SELECT_COUNT) break;
      const samps = session.samples.get(id);
      if (samps && samps.length > 0) {
        defaultChannels.push({ channelId: id, color: chan.color, visible: true });
      }
    }

    setState(prev => ({
      ...prev,
      session,
      fileName,
      isLoading: false,
      loadError: null,
      parseProgress: null,
      activeChannels: defaultChannels,
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

  const addDerivedChannel = useCallback(async (
    def: Omit<DerivedChannel, 'id' | 'color'>
  ): Promise<{ error: string } | { id: number }> => {
    const session = state.session;
    if (!session) return { error: 'No session loaded' };

    const id = derivedIdCounter++;
    const color = DERIVED_CHART_COLORS[id % DERIVED_CHART_COLORS.length];
    const newDef: DerivedChannel = { ...def, id, color };

    const result = await computeDerivedSamples(newDef, session, state.derivedChannels, derivedSamplesMap);
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
  }, [state.session, state.derivedChannels, derivedSamplesMap]);

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
    const result = await computeDerivedSamples(updated, session, state.derivedChannels, derivedSamplesMap);
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
  }, [state.session, state.derivedChannels, derivedSamplesMap]);

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
    const result = await computeDerivedSamples(tempDef, session, state.derivedChannels, derivedSamplesMap);
    if (typeof result === 'string') return result;

    return {
      timestamps: result.map(s => s.timestamp),
      values: result.map(s => s.value),
    };
  }, [state.session, state.derivedChannels, derivedSamplesMap]);

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
