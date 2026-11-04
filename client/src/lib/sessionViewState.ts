/**
 * Per-session view state (active channels, derived channels, chart/table
 * mode, analysis tab, zoom, selected laps), saved in localStorage so a
 * session reopens the way it was left. Channels are stored by name — ids
 * are assigned at load time and derived ids are regenerated.
 */
import type { ActiveChannel, AnalysisTab, ChartMode, DerivedChannel, TimeRange, ViewMode } from './useXRKStore';
import type { XRKSession } from './xrk-parser';

export const MAX_SAVED_SESSIONS = 50;
const PREFIX = 'quickscope-session-view:';
const INDEX_KEY = 'quickscope-session-views-index';

export interface SavedSessionView {
  v: 1;
  channels: { name: string; color: string }[];
  derived: Omit<DerivedChannel, 'id' | 'color'>[];
  chartMode: ChartMode;
  viewMode: ViewMode;
  analysisTab: AnalysisTab;
  viewRange: TimeRange | null;
  selectedLaps: number[];
}

export interface SessionViewFields {
  activeChannels: ActiveChannel[];
  derivedChannels: DerivedChannel[];
  chartMode: ChartMode;
  viewMode: ViewMode;
  analysisTab: AnalysisTab;
  viewRange: TimeRange | null;
  selectedLaps: number[];
}

export function captureSessionView(view: SessionViewFields, session: XRKSession): SavedSessionView {
  const channels: SavedSessionView['channels'] = [];
  for (const ac of view.activeChannels) {
    const ch = session.channels.get(ac.channelId);
    if (ch) channels.push({ name: ch.shortName, color: ac.color });
  }
  return {
    v: 1,
    channels,
    derived: view.derivedChannels.map(({ name, units, mode, expression }) => ({ name, units, mode, expression })),
    chartMode: view.chartMode,
    viewMode: view.viewMode,
    analysisTab: view.analysisTab,
    viewRange: view.viewRange,
    selectedLaps: view.selectedLaps,
  };
}

export function resolveSavedChannels(saved: SavedSessionView, session: XRKSession): ActiveChannel[] {
  const byName = new Map<string, number>();
  for (const [id, ch] of session.channels) byName.set(ch.shortName, id);
  return saved.channels.flatMap(c => {
    const id = byName.get(c.name);
    return id === undefined ? [] : [{ channelId: id, color: c.color }];
  });
}

function readIndex(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function saveSessionView(key: string, view: SavedSessionView): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(view));
    const index = [key, ...readIndex().filter(k => k !== key)];
    for (const old of index.slice(MAX_SAVED_SESSIONS)) localStorage.removeItem(PREFIX + old);
    localStorage.setItem(INDEX_KEY, JSON.stringify(index.slice(0, MAX_SAVED_SESSIONS)));
  } catch {
    // storage full/blocked: the session just won't be restored
  }
}

export function loadSessionView(key: string): SavedSessionView | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || v.v !== 1 || !Array.isArray(v.channels) || !Array.isArray(v.derived)) return null;
    return {
      ...v,
      selectedLaps: Array.isArray(v.selectedLaps) ? v.selectedLaps : [],
      viewRange: v.viewRange ?? null,
    } as SavedSessionView;
  } catch {
    return null;
  }
}
