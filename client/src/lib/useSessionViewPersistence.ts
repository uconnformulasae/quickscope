/**
 * Saves each session's view (channels, modes, tab, zoom, laps) as the user
 * works and restores it when the session is opened again.
 *
 * Usage: call beginSession(key) right before setSession(...) and endSession()
 * when the session is closed. The key identifies the session across app runs
 * (backend session id, or file name for unsaved uploads).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchChannelData } from './api';
import type { useAppState, DerivedChannel } from './useXRKStore';
import type { ChannelSample } from './xrk-parser';
import {
  captureSessionView, loadSessionView, resolveSavedChannels, saveSessionView, type SavedSessionView,
} from './sessionViewState';

type AppApi = ReturnType<typeof useAppState>;
type FetchData = (names: string[]) => Promise<Map<string, { timestamps: number[]; values: number[] }>>;

export function useSessionViewPersistence(app: AppApi, fetchData: FetchData = fetchChannelData) {
  const { state, applySessionView, setChannelSamples, addDerivedChannel, getSessionGeneration, isCurrentSession } = app;
  // Key of the session currently shown; set together with setSession so a
  // save never files the old session's view under the new key.
  const [viewKey, setViewKey] = useState<string | null>(null);
  const pendingRestoreRef = useRef<SavedSessionView | null>(null);
  // True from beginSession until the saved view (incl. derived channels) is
  // back in place, so the empty fresh-session state doesn't overwrite it.
  const restoringRef = useRef(false);
  const pendingDerivedRef = useRef<Omit<DerivedChannel, 'id' | 'color'>[]>([]);
  const [derivedTick, setDerivedTick] = useState(0);
  const beginSession = useCallback((key: string) => {
    const saved = loadSessionView(key);
    pendingRestoreRef.current = saved;
    restoringRef.current = saved !== null;
    pendingDerivedRef.current = [];
    setViewKey(key);
  }, []);

  const endSession = useCallback(() => {
    pendingRestoreRef.current = null;
    pendingDerivedRef.current = [];
    restoringRef.current = false;
    setViewKey(null);
  }, []);

  // Restore: load the saved channels' data, then apply the view in one step.
  useEffect(() => {
    const saved = pendingRestoreRef.current;
    const session = state.session;
    if (!saved || !session) return;
    pendingRestoreRef.current = null;
    const active = resolveSavedChannels(saved, session);
    const lapCount = Math.max(0, session.lapMarkers.length - 1);

    const generation = getSessionGeneration();
    void (async () => {
      const missing = active
        .map(a => session.channels.get(a.channelId)!)
        .filter(ch => !(session.samples.get(ch.index)?.length));
      if (missing.length > 0) {
        try {
          const dataMap = await fetchData(missing.map(ch => ch.shortName));
          if (!isCurrentSession(generation)) return; // another session took over
          for (const ch of missing) {
            const d = dataMap.get(ch.shortName);
            if (!d) continue;
            const samples: ChannelSample[] = d.timestamps.map((t, i) => ({ timestamp: t, value: d.values[i] }));
            setChannelSamples(ch.index, samples, generation);
          }
        } catch (err) {
          console.error('Failed to restore channel data:', err);
        }
      }
      if (!isCurrentSession(generation)) return;
      applySessionView({
        activeChannels: active,
        chartMode: saved.chartMode,
        viewMode: saved.viewMode,
        analysisTab: saved.analysisTab,
        viewRange: saved.viewRange && saved.viewRange.endMs <= session.durationMs ? saved.viewRange : null,
        selectedLaps: saved.selectedLaps.filter(i => i >= 0 && i < lapCount),
      });
      pendingDerivedRef.current = [...saved.derived];
      setDerivedTick(t => t + 1);
    })();
  }, [state.session, fetchData, applySessionView, setChannelSamples, getSessionGeneration, isCurrentSession]);

  // Re-add saved derived channels one per render, so each sees the ones
  // before it (formulas may reference earlier derived channels).
  useEffect(() => {
    if (derivedTick === 0 || !state.session) return;
    const next = pendingDerivedRef.current.shift();
    if (!next) {
      if (!pendingRestoreRef.current) restoringRef.current = false;
      return;
    }
    void addDerivedChannel(next).finally(() => setDerivedTick(t => t + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedTick]);

  // Save on every view change (cheap: a few hundred bytes).
  useEffect(() => {
    if (!state.session || !viewKey || restoringRef.current) return;
    saveSessionView(viewKey, captureSessionView(state, state.session));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, state.session, state.activeChannels, state.derivedChannels, state.chartMode, state.viewMode,
    state.analysisTab, state.viewRange, state.selectedLaps, derivedTick]);

  return useMemo(() => ({ beginSession, endSession }), [beginSession, endSession]);
}
