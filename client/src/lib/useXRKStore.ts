/**
 * QuickScope Global State Store
 * Manages parsed XRK session data and UI state
 */
import { useState, useCallback } from 'react';
import type { XRKSession, ChannelDef, ChannelSample, ParseProgress } from './xrk-parser';
import { evaluateFormula, evaluateJavaScript } from './formula-engine';

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

export interface DerivedChannel {
  id: number;
  name: string;
  units: string;
  mode: 'formula' | 'javascript';
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

/** Convert DerivedChannel definition to samples using session channel data */
function computeDerivedSamples(
  def: DerivedChannel,
  session: XRKSession,
  existingDerived: DerivedChannel[],
  existingDerivedSamples: Map<number, ChannelSample[]>,
): ChannelSample[] | string {
  // Build channels map for formula engine
  const channelData: Record<string, { timestamps: number[]; values: number[] }> = {};

  // Add session channels
  for (const [id, chanDef] of session.channels) {
    const samps = session.samples.get(id) || [];
    channelData[chanDef.shortName] = {
      timestamps: samps.map(s => s.timestamp),
      values: samps.map(s => s.value),
    };
  }

  // Add previously-defined derived channels
  for (const dc of existingDerived) {
    if (dc.id === def.id) continue;
    const samps = existingDerivedSamples.get(dc.id) || [];
    channelData[dc.name] = {
      timestamps: samps.map(s => s.timestamp),
      values: samps.map(s => s.value),
    };
  }

  let result: { timestamps: number[]; values: number[] } | string;
  if (def.mode === 'formula') {
    result = evaluateFormula(def.expression, channelData);
  } else {
    result = evaluateJavaScript(def.expression, channelData);
  }

  if (typeof result === 'string') return result; // error message

  return result.timestamps.map((t, i) => ({ timestamp: t, value: result.values[i] }));
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
  }, []);

  // ─── Derived channel actions ──────────────────────────────────────────────

  const addDerivedChannel = useCallback((
    def: Omit<DerivedChannel, 'id' | 'color'>
  ): { error: string } | { id: number } => {
    const id = derivedIdCounter++;
    const color = DERIVED_CHART_COLORS[id % DERIVED_CHART_COLORS.length];
    const newDef: DerivedChannel = { ...def, id, color };

    let samplesResult: ChannelSample[] | string = [];
    let evalError: string | null = null;

    setState(prev => {
      if (!prev.session) return prev;
      const result = computeDerivedSamples(newDef, prev.session, prev.derivedChannels, derivedSamplesMap);
      if (typeof result === 'string') {
        evalError = result;
        return prev;
      }
      samplesResult = result;
      return {
        ...prev,
        derivedChannels: [...prev.derivedChannels, newDef],
        activeChannels: [...prev.activeChannels, { channelId: id, color, visible: true }],
      };
    });

    if (evalError) return { error: evalError };

    setDerivedSamplesMap(prev => {
      const next = new Map(prev);
      next.set(id, samplesResult as ChannelSample[]);
      return next;
    });

    return { id };
  }, [derivedSamplesMap]);

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

  const updateDerivedChannel = useCallback((
    id: number,
    def: Omit<DerivedChannel, 'id' | 'color'>
  ): { error: string } | { id: number } => {
    let evalError: string | null = null;
    let samplesResult: ChannelSample[] = [];

    setState(prev => {
      if (!prev.session) return prev;
      const existing = prev.derivedChannels.find(d => d.id === id);
      if (!existing) return prev;
      const updated: DerivedChannel = { ...existing, ...def };
      const result = computeDerivedSamples(updated, prev.session, prev.derivedChannels, derivedSamplesMap);
      if (typeof result === 'string') {
        evalError = result;
        return prev;
      }
      samplesResult = result;
      return {
        ...prev,
        derivedChannels: prev.derivedChannels.map(d => d.id === id ? updated : d),
      };
    });

    if (evalError) return { error: evalError };

    setDerivedSamplesMap(prev => {
      const next = new Map(prev);
      next.set(id, samplesResult);
      return next;
    });

    return { id };
  }, [derivedSamplesMap]);

  /**
   * Preview derived channel (evaluate but don't commit to state)
   */
  const previewDerivedChannel = useCallback((
    def: Omit<DerivedChannel, 'id' | 'color'>,
    existingId?: number,
  ): { timestamps: number[]; values: number[] } | string => {
    const session = state.session;
    if (!session) return 'No session loaded';

    const tempDef: DerivedChannel = { ...def, id: existingId ?? -1, color: '#ffffff' };
    const result = computeDerivedSamples(tempDef, session, state.derivedChannels, derivedSamplesMap);
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
    toggleLeftSidebar,
    toggleRightSidebar,
    setHistogramChannel,
    setXYChannels,
    clearSession,
    addDerivedChannel,
    removeDerivedChannel,
    updateDerivedChannel,
    previewDerivedChannel,
  };
}
