import { useCallback, useEffect, useMemo, useState } from 'react';
import { uploadFile, fetchChannelData, fetchLaps, type SessionInfo } from './lib/api';
import { useAppState } from './lib/useXRKStore';
import { useTheme } from './lib/useTheme';
import type { DerivedChannel, ViewMode } from './lib/useXRKStore';
import type { XRKSession, ChannelDef, ChannelSample } from './lib/xrk-parser';
import { resolveChartColor } from './lib/chart-utils';
import { ChannelSidebar } from './components/ChannelSidebar';
import { TelemetryChart } from './components/TelemetryChart';
import { TableView } from './components/TableView';
import { AnalysisPanel } from './components/AnalysisPanel';
import { SessionHeader } from './components/SessionHeader';
import { DerivedChannelDialog } from './components/DerivedChannelDialog';
import { ExportDialog } from './components/ExportDialog';
import { SessionInfoModal } from './components/SessionInfoModal';
import { SessionBrowser } from './components/SessionBrowser';
import { SettingsDialog } from './components/SettingsDialog';
import { LiveView } from './components/LiveView';
import { Upload } from 'lucide-react';

type View = 'browser' | 'analysis' | 'live';

export default function App() {
  const {
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
    setChannelSamples,
    addDerivedChannel,
    removeDerivedChannel,
    updateDerivedChannel,
    previewDerivedChannel,
    setChartMode,
    setViewMode,
    addOverlay,
    removeOverlay,
    toggleOverlayVisibility,
    updateOverlayAlignment,
    ensureOverlayChannelLoaded,
    recomputeOverlayDerived,
  } = useAppState();

  const { theme, toggleTheme } = useTheme();

  // View state
  const [view, setView] = useState<View>('browser');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Dialog state
  const [derivedDialogOpen, setDerivedDialogOpen] = useState(false);
  const [editingDerived, setEditingDerived] = useState<DerivedChannel | undefined>(undefined);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);

  // Session ID from backend
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);

  // Drag over state for chart area
  const [isDragOver, setIsDragOver] = useState(false);

  /** Build XRKSession from backend SessionInfo and switch to analysis view */
  const buildAndSetSession = useCallback(async (info: SessionInfo, fileName: string) => {
    const nameMap = new Map<string, number>();
    for (const ch of info.channels) {
      nameMap.set(ch.name, ch.index);
    }

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

    const channelsWithData = info.channels.filter(ch => ch.sampleCount > 0);
    const firstFive = channelsWithData.slice(0, 5).map(ch => ch.name);

    const samples = new Map<number, ChannelSample[]>();
    for (const ch of info.channels) {
      samples.set(ch.index, []);
    }

    if (firstFive.length > 0) {
      setProgress({ stage: 'Loading channel data...', percent: 70 });
      const dataMap = await fetchChannelData(firstFive);
      dataMap.forEach((data, name) => {
        const idx = nameMap.get(name);
        if (idx !== undefined) {
          const channelSamples: ChannelSample[] = data.timestamps.map((t: number, i: number) => ({
            timestamp: t,
            value: data.values[i],
          }));
          samples.set(idx, channelSamples);
        }
      });
    }

    setProgress({ stage: 'Detecting laps...', percent: 85 });
    let lapMarkers: { timestamp: number; lapNumber: number; sectorTimes?: (number | null)[] }[] = [];
    let lapSource: 'device' | 'gps_auto' | 'beacon_auto' | 'gps_manual' | 'none' = 'none';
    try {
      const lapsResp = await fetchLaps();
      lapSource = lapsResp.source;
      // The device returns startTime/endTime per lap in milliseconds; the
      // chart's lapMarkers convention is one marker per lap boundary.
      // Use startTime of each lap; the last lap's endTime closes the set.
      if (lapsResp.laps.length > 0) {
        lapMarkers = lapsResp.laps.map(l => ({
          timestamp: l.startTime,
          lapNumber: l.lapNumber,
          sectorTimes: l.sectorTimes,
        }));
        const last = lapsResp.laps[lapsResp.laps.length - 1];
        lapMarkers.push({ timestamp: last.endTime, lapNumber: last.lapNumber + 1 });
      }
    } catch {
      // Non-fatal: leave laps empty. The Lap tab will show "no markers".
    }

    const session: XRKSession = {
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
      lapMarkers,
      lapSource,
      durationMs: info.durationMs,
      totalSamples: info.totalSamples,
    };

    setSession(session, fileName);
    setView('analysis');
  }, [setSession, setProgress]);

  /** Called when session browser loads a session (with optional overlays) */
  const handleSessionLoaded = useCallback(async (
    info: SessionInfo,
    sessionId: string,
    fileName: string,
    overlaySessionIds: string[] = [],
  ) => {
    setLoadedSessionId(sessionId);
    setLoading(true);
    setProgress({ stage: 'Building session...', percent: 50 });
    try {
      await buildAndSetSession(info, fileName);
      // After primary loads, fetch each overlay (best-effort; primary already up).
      for (const ovId of overlaySessionIds) {
        const result = await addOverlay(ovId, ovId);
        if ('error' in result) {
          console.warn(`Failed to add overlay ${ovId}: ${result.error}`);
          continue;
        }
        void recomputeOverlayDerived(ovId);
      }
    } catch (err) {
      setError(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [buildAndSetSession, setLoading, setProgress, setError, addOverlay, recomputeOverlayDerived]);

  /** Called when user uploads a file from the analysis view header */
  const handleFileSelected = useCallback(async (file: File) => {
    setLoading(true);
    setProgress({ stage: 'Uploading to backend...', percent: 1 });

    const formatRate = (bytesPerSec: number): string => {
      if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
      if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
      return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
    };

    try {
      const info = await uploadFile(file, (p) => {
        // Map upload bytes to 1..40% of overall progress; the rest is parsing.
        const uploadPct = p.total > 0 ? (p.loaded / p.total) * 40 : 0;
        const eta = p.etaSec >= 0 && p.etaSec < 600 ? `, ${p.etaSec.toFixed(0)}s left` : '';
        setProgress({
          stage: `Uploading ${(p.loaded / 1e6).toFixed(1)}/${(p.total / 1e6).toFixed(1)} MB at ${formatRate(p.ratePerSec)}${eta}`,
          percent: Math.max(1, Math.min(40, uploadPct)),
        });
      });
      setProgress({ stage: 'Fetching channel data...', percent: 50 });
      await buildAndSetSession(info, file.name);
    } catch (err) {
      setError(`Failed to upload XRK file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [setLoading, setProgress, buildAndSetSession, setError]);

  const handleBackToBrowser = useCallback(() => {
    setLoadedSessionId(null);
    clearSession();
    setView('browser');
  }, [clearSession]);

  // Lazy fetch channel data when a channel is activated
  const handleToggleChannel = useCallback(async (channelId: number, color: string) => {
    const isActive = state.activeChannels.some(c => c.channelId === channelId);
    if (isActive) {
      toggleChannel(channelId, color);
      return;
    }

    const existingSamples = state.session?.samples.get(channelId);
    if (existingSamples && existingSamples.length > 0) {
      toggleChannel(channelId, color);
      return;
    }

    const channelDef = state.session?.channels.get(channelId);
    if (!channelDef) {
      toggleChannel(channelId, color);
      return;
    }

    try {
      const dataMap = await fetchChannelData([channelDef.shortName]);
      const data = dataMap.get(channelDef.shortName);
      if (data) {
        const channelSamples: ChannelSample[] = data.timestamps.map((t: number, i: number) => ({
          timestamp: t,
          value: data.values[i],
        }));
        setChannelSamples(channelId, channelSamples);
      }
    } catch (err) {
      console.error('Failed to fetch channel data:', err);
    }

    toggleChannel(channelId, color);
  }, [state.activeChannels, state.session, toggleChannel, setChannelSamples]);

  const handleOpenCreateDerived = useCallback(() => {
    setEditingDerived(undefined);
    setDerivedDialogOpen(true);
  }, []);

  const handleEditDerived = useCallback((dc: DerivedChannel) => {
    setEditingDerived(dc);
    setDerivedDialogOpen(true);
  }, []);

  const handleCloseDerivedDialog = useCallback(() => {
    setDerivedDialogOpen(false);
    setEditingDerived(undefined);
  }, []);

  const handleNavigateToTime = useCallback((timestampMs: number) => {
    if (!state.session) return;
    const durationMs = state.session.durationMs;
    const tSec = timestampMs / 1000;
    const durationSec = durationMs / 1000;
    setCursorTime(tSec);
    const currentRange = state.viewRange;
    const isVisible = currentRange
      ? (timestampMs >= currentRange.startMs && timestampMs <= currentRange.endMs)
      : true;
    if (!isVisible) {
      const windowHalf = durationSec * 0.1;
      let newStart = Math.max(0, tSec - windowHalf);
      let newEnd = Math.min(durationSec, tSec + windowHalf);
      setViewRange({ startMs: newStart * 1000, endMs: newEnd * 1000 });
    }
  }, [state.session, state.viewRange, setCursorTime, setViewRange]);

  const handlePreviewDerived = useCallback((def: Omit<DerivedChannel, 'id' | 'color'>) => {
    return previewDerivedChannel(def, editingDerived?.id);
  }, [previewDerivedChannel, editingDerived]);

  const handleSubmitDerived = useCallback((def: Omit<DerivedChannel, 'id' | 'color'>) => {
    if (editingDerived) {
      return updateDerivedChannel(editingDerived.id, def);
    }
    return addDerivedChannel(def);
  }, [editingDerived, addDerivedChannel, updateDerivedChannel]);

  const handleFileRenamed = useCallback((newFileName: string) => {
    if (!state.session) return;
    setSession(state.session, newFileName);
  }, [state.session, setSession]);

  /** Re-fetch laps and update session.lapMarkers + lapSource after the user
   *  commits new setpoints. Keeps the rest of the session state intact. */
  const refetchLaps = useCallback(async () => {
    if (!state.session) return;
    try {
      const lapsResp = await fetchLaps();
      let lapMarkers: { timestamp: number; lapNumber: number; sectorTimes?: (number | null)[] }[] = [];
      if (lapsResp.laps.length > 0) {
        lapMarkers = lapsResp.laps.map(l => ({
          timestamp: l.startTime,
          lapNumber: l.lapNumber,
          sectorTimes: l.sectorTimes,
        }));
        const last = lapsResp.laps[lapsResp.laps.length - 1];
        lapMarkers.push({ timestamp: last.endTime, lapNumber: last.lapNumber + 1 });
      }
      setSession(
        { ...state.session, lapMarkers, lapSource: lapsResp.source },
        state.fileName ?? '',
      );
    } catch (err) {
      console.error('Failed to refetch laps after setpoint update:', err);
    }
  }, [state.session, state.fileName, setSession]);

  // Drag-and-drop handlers for the chart area
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.name.toLowerCase().endsWith('.xrk') || file.name.toLowerCase().endsWith('.xrz'))) {
      handleFileSelected(file);
    }
  }, [handleFileSelected]);

  const { session, activeChannels: rawActiveChannels, leftSidebarOpen, rightSidebarOpen } = state;

  // Resolve channel colors for current theme (dark colors need darker variants on light bg)
  const activeChannels = useMemo(
    () => rawActiveChannels.map(ac => ({ ...ac, color: resolveChartColor(ac.color, theme) })),
    [rawActiveChannels, theme],
  );

  // Lazy-fetch overlay channel samples whenever the user activates a primary
  // channel — fire-and-forget; the chart redraws when samples land.
  useEffect(() => {
    if (state.overlays.length === 0) return;
    for (const ac of state.activeChannels) {
      for (const ov of state.overlays) {
        void ensureOverlayChannelLoaded(ov.id, ac.channelId);
      }
    }
  }, [state.activeChannels, state.overlays, ensureOverlayChannelLoaded]);

  // Recompute overlay derived channels when the primary's derived list changes.
  useEffect(() => {
    for (const ov of state.overlays) {
      void recomputeOverlayDerived(ov.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.derivedChannels]);

  // ─── Session Browser View ──────────────────────────────────────────────────
  if (view === 'browser') {
    return (
      <div className="flex flex-col h-full bg-background overflow-hidden relative">
        <SessionBrowser
          onSessionLoaded={handleSessionLoaded}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenLive={() => setView('live')}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </div>
    );
  }

  // ─── Live View ─────────────────────────────────────────────────────────────
  if (view === 'live') {
    return (
      <div className="flex flex-col h-full bg-background overflow-hidden">
        <LiveView onBack={() => setView('browser')} />
      </div>
    );
  }

  // ─── Analysis View (existing) ──────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Top bar */}
      <SessionHeader
        session={session}
        fileName={state.fileName}
        leftOpen={leftSidebarOpen}
        rightOpen={rightSidebarOpen}
        onToggleLeft={toggleLeftSidebar}
        onToggleRight={toggleRightSidebar}
        onFileSelected={handleFileSelected}
        onExportOpen={session ? () => setExportDialogOpen(true) : undefined}
        totalSamples={session?.totalSamples ?? 0}
        onBack={handleBackToBrowser}
        theme={theme}
        onToggleTheme={toggleTheme}
        viewMode={state.viewMode}
        onViewModeChange={setViewMode}
        onSessionInfoOpen={session ? () => setSessionInfoOpen(true) : undefined}
      />

      {/* Main layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar -- channel picker */}
        {leftSidebarOpen && (
          <div className="w-48 flex-shrink-0 overflow-hidden">
            {session ? (
              <ChannelSidebar
                session={session}
                activeChannels={activeChannels}
                derivedChannels={state.derivedChannels}
                derivedSamplesMap={derivedSamplesMap}
                onToggleChannel={handleToggleChannel}
                onRemoveDerived={removeDerivedChannel}
                onEditDerived={handleEditDerived}
                onCreateDerived={handleOpenCreateDerived}
                search={state.channelSearch}
                onSearchChange={setChannelSearch}
                showOnlyWithData={state.showOnlyWithData}
                onShowOnlyWithDataChange={setShowOnlyWithData}
                chartMode={state.chartMode}
                onChartModeChange={setChartMode}
              />
            ) : (
              <div className="flex items-center justify-center h-full bg-card border-r border-border">
                <p className="text-xs text-muted-foreground/60 text-center px-3">Load a file to see channels</p>
              </div>
            )}
          </div>
        )}

        {/* Main chart area */}
        <div
          className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background relative"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {session ? (
            state.viewMode === 'table' ? (
              <TableView
                session={session}
                activeChannels={activeChannels}
                derivedChannels={state.derivedChannels}
                derivedSamplesMap={derivedSamplesMap}
              />
            ) : (
              <TelemetryChart
                session={session}
                activeChannels={activeChannels}
                viewRange={state.viewRange}
                onViewRangeChange={setViewRange}
                derivedChannels={state.derivedChannels}
                derivedSamplesMap={derivedSamplesMap}
                cursorTime={state.cursorTime}
                onCursorTimeChange={setCursorTime}
                chartMode={state.chartMode}
                overlays={state.overlays}
                onOverlayRemove={removeOverlay}
                onOverlayToggleVisible={toggleOverlayVisibility}
                onOverlayUpdateAlignment={updateOverlayAlignment}
              />
            )
          ) : (
            /* Empty state -- no file loaded */
            <div className={`flex-1 flex flex-col items-center justify-center gap-4 transition-colors ${isDragOver ? 'bg-primary/5' : ''}`}>
              {state.isLoading ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  <div className="text-center">
                    <p className="text-sm text-foreground font-medium">
                      {state.parseProgress?.stage ?? 'Loading...'}
                    </p>
                    {state.parseProgress?.percent != null && (
                      <p className="text-xs text-muted-foreground mt-1">{state.parseProgress.percent}%</p>
                    )}
                  </div>
                </div>
              ) : state.loadError ? (
                <div className="max-w-sm text-center">
                  <p className="text-sm font-medium text-red-500 dark:text-red-400 mb-1">Failed to load file</p>
                  <p className="text-xs text-muted-foreground">{state.loadError}</p>
                </div>
              ) : (
                <div className={`flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-dashed transition-colors ${isDragOver ? 'border-primary/60 bg-primary/5' : 'border-border/40'}`}>
                  <div className="w-12 h-12 rounded-full bg-muted/40 border border-border flex items-center justify-center">
                    <Upload className="w-5 h-5 text-muted-foreground/60" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">No file loaded</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Click <span className="font-medium text-foreground">Load File</span> or drop a <span className="font-mono text-xs text-primary/80">.xrk</span> file here
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Drag overlay indicator */}
          {isDragOver && session && (
            <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary/50 flex items-center justify-center pointer-events-none z-10">
              <div className="bg-card/90 rounded-xl px-6 py-4 text-center">
                <Upload className="w-6 h-6 text-primary mx-auto mb-2" />
                <p className="text-sm font-medium text-foreground">Drop .xrk file to load</p>
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar -- analysis */}
        {rightSidebarOpen && session && (
          <div className="w-72 flex-shrink-0 overflow-hidden">
            <AnalysisPanel
              session={session}
              activeChannels={activeChannels}
              viewRange={state.viewRange}
              analysisTab={state.analysisTab}
              onTabChange={setAnalysisTab}
              histogramChannelId={state.histogramChannelId}
              onHistogramChannelChange={setHistogramChannel}
              xyXChannelId={state.xyXChannelId}
              xyYChannelId={state.xyYChannelId}
              onXYChannelChange={setXYChannels}
              derivedChannels={state.derivedChannels}
              derivedSamplesMap={derivedSamplesMap}
              onNavigateToTime={handleNavigateToTime}
              cursorTime={state.cursorTime}
              theme={theme}
              sessionId={loadedSessionId}
              onSetpointsChanged={refetchLaps}
            />
          </div>
        )}
      </div>

      {/* Derived channel dialog */}
      {derivedDialogOpen && session && (
        <DerivedChannelDialog
          session={session}
          editing={editingDerived}
          onClose={handleCloseDerivedDialog}
          onPreview={handlePreviewDerived}
          onSubmit={handleSubmitDerived}
        />
      )}

      {/* Export CSV dialog */}
      {exportDialogOpen && session && (
        <ExportDialog
          session={session}
          fileName={state.fileName}
          derivedChannels={state.derivedChannels}
          derivedSamplesMap={derivedSamplesMap}
          onClose={() => setExportDialogOpen(false)}
        />
      )}

      {/* Session Info modal */}
      {sessionInfoOpen && session && state.fileName && loadedSessionId && (
        <SessionInfoModal
          sessionId={loadedSessionId}
          metadata={session.metadata}
          durationMs={session.durationMs}
          lapCount={Math.max(0, session.lapMarkers.length - 1)}
          fileName={state.fileName}
          onClose={() => setSessionInfoOpen(false)}
          onFileRenamed={handleFileRenamed}
        />
      )}
    </div>
  );
}
