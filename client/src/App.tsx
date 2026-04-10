import { useCallback, useState } from 'react';
import { uploadFile, fetchChannelData, loadSession, type SessionInfo } from './lib/api';
import { useAppState } from './lib/useXRKStore';
import type { DerivedChannel } from './lib/useXRKStore';
import type { XRKSession, ChannelDef, ChannelSample } from './lib/xrk-parser';
import { ChannelSidebar } from './components/ChannelSidebar';
import { TelemetryChart } from './components/TelemetryChart';
import { AnalysisPanel } from './components/AnalysisPanel';
import { SessionHeader } from './components/SessionHeader';
import { DerivedChannelDialog } from './components/DerivedChannelDialog';
import { ExportDialog } from './components/ExportDialog';
import { SessionBrowser } from './components/SessionBrowser';
import { SettingsDialog } from './components/SettingsDialog';
import { Upload } from 'lucide-react';

type View = 'browser' | 'analysis';

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
    addDerivedChannel,
    removeDerivedChannel,
    updateDerivedChannel,
    previewDerivedChannel,
    setChartMode,
  } = useAppState();

  // View state
  const [view, setView] = useState<View>('browser');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Dialog state
  const [derivedDialogOpen, setDerivedDialogOpen] = useState(false);
  const [editingDerived, setEditingDerived] = useState<DerivedChannel | undefined>(undefined);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

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
        dataType: 0,
        dataSize: 0,
        decoderType: 0,
        scale: 0,
        offset: 0,
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
      lapMarkers: [],
      durationMs: info.durationMs,
      totalSamples: info.totalSamples,
    };

    setSession(session, fileName);
    setView('analysis');
  }, [setSession, setProgress]);

  /** Called when session browser loads a session */
  const handleSessionLoaded = useCallback(async (info: SessionInfo, _sessionId: string, fileName: string) => {
    setLoading(true);
    setProgress({ stage: 'Building session...', percent: 50 });
    try {
      await buildAndSetSession(info, fileName);
    } catch (err) {
      setError(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [buildAndSetSession, setLoading, setProgress, setError]);

  /** Called when user uploads a file from the analysis view header */
  const handleFileSelected = useCallback(async (file: File) => {
    setLoading(true);
    setProgress({ stage: 'Uploading to backend...', percent: 10 });
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
      const info = await uploadFile(file);
      setProgress({ stage: 'Fetching channel data...', percent: 50 });
      await buildAndSetSession(info, file.name);
    } catch (err) {
      setError(`Failed to parse XRK file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [setLoading, setProgress, buildAndSetSession, setError]);

  const handleBackToBrowser = useCallback(() => {
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
      if (data && state.session) {
        const channelSamples: ChannelSample[] = data.timestamps.map((t: number, i: number) => ({
          timestamp: t,
          value: data.values[i],
        }));
        state.session.samples.set(channelId, channelSamples);
      }
    } catch (err) {
      console.error('Failed to fetch channel data:', err);
    }

    toggleChannel(channelId, color);
  }, [state.activeChannels, state.session, toggleChannel]);

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

  const { session, activeChannels, leftSidebarOpen, rightSidebarOpen } = state;

  // ─── Session Browser View ──────────────────────────────────────────────────
  if (view === 'browser') {
    return (
      <div className="flex flex-col h-full bg-background dark overflow-hidden relative">
        <SessionBrowser
          onSessionLoaded={handleSessionLoaded}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </div>
    );
  }

  // ─── Analysis View (existing) ──────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-background dark overflow-hidden">
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
            />
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
                  <p className="text-sm font-medium text-red-400 mb-1">Failed to load file</p>
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
    </div>
  );
}
