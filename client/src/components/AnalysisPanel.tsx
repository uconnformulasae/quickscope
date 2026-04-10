import { useMemo, useEffect, useRef, useState } from 'react';
import type { XRKSession } from '../lib/xrk-parser';
import { computeStats, formatLapTime, formatTime, lttbDownsample } from '../lib/xrk-parser';
import type { ActiveChannel, AnalysisTab, TimeRange, DerivedChannel } from '../lib/useXRKStore';
import type { ChannelSample } from '../lib/xrk-parser';
import { BarChart3, Activity, ScatterChart, Timer, TrendingUp, Crosshair, MapPin } from 'lucide-react';
import { GPSMapView } from './GPSMapView';

// Load Plotly.js from CDN (shared by Histogram and XY Plot tabs)
let plotlyLoading = false;
function ensurePlotly(onReady: () => void) {
  if ((window as any).Plotly) {
    onReady();
    return;
  }
  if (!plotlyLoading) {
    plotlyLoading = true;
    const script = document.createElement('script');
    script.src = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
    script.onload = () => onReady();
    document.head.appendChild(script);
  } else {
    // Already loading, poll
    const check = () => {
      if ((window as any).Plotly) onReady();
      else setTimeout(check, 100);
    };
    check();
  }
}

interface AnalysisPanelProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  viewRange: TimeRange | null;
  analysisTab: AnalysisTab;
  onTabChange: (t: AnalysisTab) => void;
  histogramChannelId: number | null;
  onHistogramChannelChange: (id: number | null) => void;
  xyXChannelId: number | null;
  xyYChannelId: number | null;
  onXYChannelChange: (xId: number | null, yId: number | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
  onNavigateToTime?: (timestampMs: number) => void;
}

// Helper to resolve channel info from session or derived
function resolveChannel(id: number, session: XRKSession, derivedChannels?: DerivedChannel[]) {
  const sessionChan = session.channels.get(id);
  if (sessionChan) return sessionChan;
  const dc = derivedChannels?.find(d => d.id === id);
  if (dc) return { index: dc.id, shortName: dc.name, longName: dc.name, units: dc.units, color: dc.color, sampleRateHz: 0, sampleRateRaw: 0, dataType: 0, dataSize: 0, scale: 0, offset: 0 } as any;
  return null;
}

function resolveSamples(id: number, session: XRKSession, derivedSamplesMap?: Map<number, ChannelSample[]>) {
  return session.samples.get(id) || derivedSamplesMap?.get(id) || [];
}

const TABS: { id: AnalysisTab; label: string; icon: any }[] = [
  { id: 'stats', label: 'Stats', icon: Activity },
  { id: 'lapanalysis', label: 'Laps', icon: Timer },
  { id: 'histogram', label: 'Histogram', icon: BarChart3 },
  { id: 'xyplot', label: 'XY Plot', icon: ScatterChart },
  { id: 'gps', label: 'GPS', icon: MapPin },
];

export function AnalysisPanel({
  session,
  activeChannels,
  viewRange,
  analysisTab,
  onTabChange,
  histogramChannelId,
  onHistogramChannelChange,
  xyXChannelId,
  xyYChannelId,
  onXYChannelChange,
  derivedChannels,
  derivedSamplesMap,
  onNavigateToTime,
}: AnalysisPanelProps) {
  return (
    <div className="flex flex-col h-full bg-card border-l border-border overflow-hidden">
      {/* Tab bar */}
      <div className="flex-shrink-0 flex border-b border-border">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2 px-1 text-xs transition-colors
                ${analysisTab === tab.id
                  ? 'text-primary border-b-2 border-primary bg-primary/5'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                }`}
              data-testid={`tab-${tab.id}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {analysisTab === 'stats' && (
          <StatsTab session={session} activeChannels={activeChannels} viewRange={viewRange} derivedChannels={derivedChannels} derivedSamplesMap={derivedSamplesMap} onNavigateToTime={onNavigateToTime} />
        )}
        {analysisTab === 'lapanalysis' && (
          <LapAnalysisTab session={session} activeChannels={activeChannels} />
        )}
        {analysisTab === 'histogram' && (
          <HistogramTab
            session={session}
            activeChannels={activeChannels}
            channelId={histogramChannelId}
            onChannelChange={onHistogramChannelChange}
            derivedChannels={derivedChannels}
            derivedSamplesMap={derivedSamplesMap}
          />
        )}
        {analysisTab === 'xyplot' && (
          <XYPlotTab
            session={session}
            activeChannels={activeChannels}
            xChannelId={xyXChannelId}
            yChannelId={xyYChannelId}
            onChannelChange={onXYChannelChange}
            derivedChannels={derivedChannels}
            derivedSamplesMap={derivedSamplesMap}
          />
        )}
        {analysisTab === 'gps' && (
          <GPSMapView />
        )}
      </div>
    </div>
  );
}

// ─── Stats Tab ────────────────────────────────────────────────────────────────

function StatsTab({ session, activeChannels, viewRange, derivedChannels, derivedSamplesMap, onNavigateToTime }: {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  viewRange: TimeRange | null;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
  onNavigateToTime?: (timestampMs: number) => void;
}) {
  const stats = useMemo(() => {
    return activeChannels.map(ac => {
      const chan = resolveChannel(ac.channelId, session, derivedChannels);
      if (!chan) return null;
      // Always compute stats from full dataset for min/max/timestamps
      const allSamps = resolveSamples(ac.channelId, session, derivedSamplesMap);
      const globalStats = computeStats(allSamps);
      // View-filtered stats for mean/stddev/count display
      let viewSamps = allSamps;
      if (viewRange) {
        viewSamps = allSamps.filter(s => s.timestamp >= viewRange.startMs && s.timestamp <= viewRange.endMs);
      }
      const viewStats = computeStats(viewSamps);
      const totalSamples = allSamps.length;
      return { chan, color: ac.color, globalStats, viewStats, totalSamples };
    }).filter(Boolean) as { chan: any; color: string; globalStats: any; viewStats: any; totalSamples: number }[];
  }, [session, activeChannels, viewRange, derivedChannels, derivedSamplesMap]);

  if (stats.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-xs gap-2 p-4">
        <TrendingUp className="w-6 h-6 opacity-40" />
        <p>Activate channels to see statistics</p>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-2">
      {viewRange && (
        <p className="text-xs text-muted-foreground px-1 pb-1 border-b border-border">
          Mean/StdDev for selected range • Min/Max always full session
        </p>
      )}
      {stats.map(({ chan, color, globalStats: gs, viewStats: vs, totalSamples }) => {
        const hasData = totalSamples > 0;
        const canNavigate = !!onNavigateToTime;
        return (
          <div key={chan.index} className="rounded-lg border border-border overflow-hidden">
            {/* Channel header */}
            <div
              className="flex items-center justify-between px-2.5 py-1.5"
              style={{ borderLeft: `3px solid ${color}`, background: `${color}0d` }}
            >
              <div>
                <span className="text-xs font-semibold text-foreground">{chan.shortName}</span>
                {chan.units && <span className="text-xs text-muted-foreground ml-1">({chan.units})</span>}
              </div>
              {hasData ? (
                <span className="text-xs text-muted-foreground tabular">{vs.count.toLocaleString()} pts</span>
              ) : (
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground/60">No data</span>
              )}
            </div>
            {/* Stats grid or no-data state */}
            {hasData ? (
              <div className="grid grid-cols-2 gap-px bg-border">
                {/* Min — clickable, global */}
                <button
                  key="Min"
                  className={`bg-card px-2.5 py-1.5 text-left group ${
                    canNavigate ? 'cursor-pointer hover:bg-muted/30 transition-colors' : 'cursor-default'
                  }`}
                  onClick={canNavigate ? () => onNavigateToTime!(gs.minTimestamp) : undefined}
                  disabled={!canNavigate}
                  title={canNavigate ? `Jump to min @ ${formatTime(gs.minTimestamp)}` : undefined}
                  data-testid={`stat-min-${chan.index}`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground leading-none mb-0.5">Min</p>
                    {canNavigate && (
                      <Crosshair className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary/60 transition-colors" />
                    )}
                  </div>
                  <p className="text-sm font-medium text-foreground tabular">{formatNum(gs.min)}</p>
                  <p className="text-xs text-muted-foreground/50 leading-none mt-0.5">@ {formatTime(gs.minTimestamp)}</p>
                </button>
                {/* Max — clickable, global */}
                <button
                  key="Max"
                  className={`bg-card px-2.5 py-1.5 text-left group ${
                    canNavigate ? 'cursor-pointer hover:bg-muted/30 transition-colors' : 'cursor-default'
                  }`}
                  onClick={canNavigate ? () => onNavigateToTime!(gs.maxTimestamp) : undefined}
                  disabled={!canNavigate}
                  title={canNavigate ? `Jump to max @ ${formatTime(gs.maxTimestamp)}` : undefined}
                  data-testid={`stat-max-${chan.index}`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground leading-none mb-0.5">Max</p>
                    {canNavigate && (
                      <Crosshair className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary/60 transition-colors" />
                    )}
                  </div>
                  <p className="text-sm font-medium text-foreground tabular">{formatNum(gs.max)}</p>
                  <p className="text-xs text-muted-foreground/50 leading-none mt-0.5">@ {formatTime(gs.maxTimestamp)}</p>
                </button>
                {/* Mean — view-filtered */}
                <div key="Mean" className="bg-card px-2.5 py-1.5">
                  <p className="text-xs text-muted-foreground leading-none mb-0.5">Mean</p>
                  <p className="text-sm font-medium text-foreground tabular">{formatNum(vs.mean)}</p>
                </div>
                {/* Std Dev — view-filtered */}
                <div key="StdDev" className="bg-card px-2.5 py-1.5">
                  <p className="text-xs text-muted-foreground leading-none mb-0.5">Std Dev</p>
                  <p className="text-sm font-medium text-foreground tabular">{formatNum(vs.stdDev)}</p>
                </div>
              </div>
            ) : (
              <div className="px-2.5 py-3 text-xs text-muted-foreground/50 italic">
                No data recorded for this channel in this session
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 10000) return n.toFixed(0);
  if (Math.abs(n) >= 100) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

// ─── Lap Analysis Tab ─────────────────────────────────────────────────────────

function LapAnalysisTab({ session, activeChannels }: {
  session: XRKSession;
  activeChannels: ActiveChannel[];
}) {
  const lapData = useMemo(() => {
    const markers = session.lapMarkers;
    if (markers.length < 2) return [];

    const laps = [];
    let bestLap = -1;
    let bestTime = Infinity;

    for (let i = 0; i < markers.length - 1; i++) {
      const startMs = markers[i].timestamp;
      const endMs = markers[i + 1].timestamp;
      const lapTimeS = (endMs - startMs) / 1e6;

      if (lapTimeS < bestTime && lapTimeS > 10) { // ignore very short laps
        bestTime = lapTimeS;
        bestLap = i;
      }

      // Compute stats for active channels on this lap
      const channelStats: Record<string, any> = {};
      for (const ac of activeChannels.slice(0, 3)) { // show first 3 active channels
        const chan = session.channels.get(ac.channelId);
        if (!chan) continue;
        const samps = (session.samples.get(ac.channelId) || [])
          .filter(s => s.timestamp >= startMs && s.timestamp <= endMs);
        channelStats[chan.shortName] = { ...computeStats(samps), color: ac.color };
      }

      laps.push({ lapNum: i + 1, startMs, endMs, lapTimeS, channelStats, isBest: false });
    }

    if (bestLap >= 0) laps[bestLap].isBest = true;
    return laps;
  }, [session, activeChannels]);

  if (session.lapMarkers.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-xs gap-2 p-4">
        <Timer className="w-6 h-6 opacity-40" />
        <p>No lap markers found in session</p>
      </div>
    );
  }

  const bestTime = lapData.find(l => l.isBest)?.lapTimeS;

  return (
    <div className="p-2">
      {bestTime && (
        <div className="mb-3 p-2.5 rounded-lg bg-primary/10 border border-primary/20">
          <p className="text-xs text-muted-foreground">Best Lap</p>
          <p className="text-lg font-bold text-primary tabular mt-0.5">{formatLapTime(bestTime)}</p>
        </div>
      )}

      <div className="space-y-1.5">
        {lapData.map(lap => (
          <div
            key={lap.lapNum}
            className={`rounded-lg border p-2.5 transition-colors ${
              lap.isBest ? 'border-primary/40 bg-primary/5' : 'border-border'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold tabular ${lap.isBest ? 'text-primary' : 'text-foreground'}`}>
                  Lap {lap.lapNum}
                </span>
                {lap.isBest && (
                  <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">Best</span>
                )}
              </div>
              <span className={`text-sm font-bold tabular ${lap.isBest ? 'text-primary' : 'text-foreground'}`}>
                {formatLapTime(lap.lapTimeS)}
              </span>
            </div>
            {/* Channel stats */}
            <div className="grid grid-cols-3 gap-1">
              {Object.entries(lap.channelStats).map(([name, s]: [string, any]) => (
                <div key={name} className="text-center">
                  <p className="text-xs tabular font-medium" style={{ color: s.color }}>
                    {formatNum(s.mean)}
                  </p>
                  <p className="text-xs text-muted-foreground/50">{name}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Histogram Tab ────────────────────────────────────────────────────────────

function HistogramTab({ session, activeChannels, channelId, onChannelChange, derivedChannels, derivedSamplesMap }: {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  channelId: number | null;
  onChannelChange: (id: number | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);

  const activeChannelIdsWithData = activeChannels
    .filter(ac => resolveSamples(ac.channelId, session, derivedSamplesMap).length > 0)
    .map(ac => ac.channelId);
  const hasValidSelectedChannel = channelId != null && activeChannelIdsWithData.includes(channelId);
  const effectiveChannelId = hasValidSelectedChannel
    ? channelId
    : activeChannelIdsWithData[0] ?? null;
  const chan = effectiveChannelId != null ? resolveChannel(effectiveChannelId, session, derivedChannels) : null;
  const activeChan = activeChannels.find(ac => ac.channelId === effectiveChannelId);

  const sampleCount = chan ? resolveSamples(chan.index, session, derivedSamplesMap).length : 0;
  const hasData = sampleCount > 0;

  // Load Plotly and render histogram
  useEffect(() => {
    if (!chartRef.current || !chan || !activeChan || !hasData) return;

    const render = () => {
      const Plotly = (window as any).Plotly;
      if (!Plotly || !chartRef.current) return;

      const samples = resolveSamples(chan.index, session, derivedSamplesMap);
      const values = samples.map(s => s.value);

      const trace = {
        type: 'histogram',
        x: values,
        nbinsx: 50,
        marker: { color: activeChan.color, opacity: 0.8, line: { width: 0 } },
        name: chan.shortName,
      };

      const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        xaxis: {
          title: `${chan.shortName}${chan.units ? ` (${chan.units})` : ''}`,
          tickfont: { size: 10, color: '#8b93a8', family: 'JetBrains Mono' },
          gridcolor: 'rgba(255,255,255,0.05)',
        },
        yaxis: {
          title: 'Count',
          tickfont: { size: 10, color: '#8b93a8', family: 'JetBrains Mono' },
          gridcolor: 'rgba(255,255,255,0.05)',
        },
        margin: { l: 45, r: 15, t: 15, b: 45 },
        bargap: 0.05,
        font: { family: 'DM Sans', color: '#8b93a8', size: 11 },
      };

      Plotly.react(chartRef.current, [trace], layout, {
        responsive: true, displayModeBar: false, displaylogo: false
      });
      setIsReady(true);
    };

    ensurePlotly(render);
  }, [session, chan, activeChan]);

  return (
    <div className="p-2 flex flex-col gap-2 h-full">
      {/* Channel selector */}
      <select
        value={effectiveChannelId ?? ''}
        onChange={e => onChannelChange(e.target.value ? Number(e.target.value) : null)}
        className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        data-testid="select-histogram-channel"
      >
        <option value="">Select channel...</option>
        {activeChannels.map(ac => {
          const c = resolveChannel(ac.channelId, session, derivedChannels);
          const count = resolveSamples(ac.channelId, session, derivedSamplesMap).length;
          if (!c) return null;
          return (
            <option key={ac.channelId} value={ac.channelId} disabled={count === 0}>
              {c.shortName}{c.units ? ` (${c.units})` : ''}{count === 0 ? ' — no data' : ''}
            </option>
          );
        })}
      </select>

      {/* Chart or empty state */}
      {chan && !hasData ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground/50 text-xs italic">
          No data recorded for {chan.shortName} in this session
        </div>
      ) : (
        <div ref={chartRef} className="flex-1 min-h-0" style={{ minHeight: '280px' }} data-testid="histogram-chart" />
      )}

      {!chan && (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
          Select an active channel to view distribution
        </div>
      )}
    </div>
  );
}

// ─── XY Plot Tab ──────────────────────────────────────────────────────────────

function XYPlotTab({ session, activeChannels, xChannelId, yChannelId, onChannelChange, derivedChannels, derivedSamplesMap }: {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  xChannelId: number | null;
  yChannelId: number | null;
  onChannelChange: (xId: number | null, yId: number | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
}) {
  const chartRef = useRef<HTMLDivElement>(null);

  const activeChannelIdsWithData = activeChannels
    .filter(ac => resolveSamples(ac.channelId, session, derivedSamplesMap).length > 0)
    .map(ac => ac.channelId);
  const hasValidX = xChannelId != null && activeChannelIdsWithData.includes(xChannelId);
  const effectiveXId = hasValidX ? xChannelId : activeChannelIdsWithData[0] ?? null;
  const hasValidY = yChannelId != null && activeChannelIdsWithData.includes(yChannelId);
  const fallbackY = activeChannelIdsWithData.find(id => id !== effectiveXId) ?? null;
  const effectiveYId = hasValidY ? yChannelId : fallbackY;
  const xChan = effectiveXId != null ? resolveChannel(effectiveXId, session, derivedChannels) : null;
  const yChan = effectiveYId != null ? resolveChannel(effectiveYId, session, derivedChannels) : null;
  const yAc = activeChannels.find(ac => ac.channelId === effectiveYId);

  useEffect(() => {
    if (!chartRef.current || !xChan || !yChan) return;

    const render = () => {
      const Plotly = (window as any).Plotly;
      if (!Plotly || !chartRef.current) return;

      const xSamplesRaw = resolveSamples(xChan.index, session, derivedSamplesMap);
      const ySamplesRaw = resolveSamples(yChan.index, session, derivedSamplesMap);
      if (xSamplesRaw.length === 0 || ySamplesRaw.length === 0) return;

      const xSamples = lttbDownsample(xSamplesRaw, 3000);
      const ySamples = ySamplesRaw;

      const xs: number[] = [];
      const ys: number[] = [];

      for (const xs_sample of xSamples) {
        const ts = xs_sample.timestamp;
        let lo = 0, hi = ySamples.length - 1;
        while (lo < hi - 1) {
          const mid = (lo + hi) >> 1;
          if (ySamples[mid].timestamp <= ts) lo = mid;
          else hi = mid;
        }
        if (lo < ySamples.length) {
          xs.push(xs_sample.value);
          ys.push(ySamples[lo].value);
        }
      }

      const trace = {
        type: 'scattergl',
        mode: 'markers',
        x: xs,
        y: ys,
        marker: {
          color: yAc?.color || '#4361ee',
          size: 3,
          opacity: 0.6,
        },
        hovertemplate: `${xChan.shortName}: %{x:.2f}<br>${yChan.shortName}: %{y:.2f}<extra></extra>`,
      };

      const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        xaxis: {
          title: `${xChan.shortName}${xChan.units ? ` (${xChan.units})` : ''}`,
          tickfont: { size: 10, color: '#8b93a8', family: 'JetBrains Mono' },
          gridcolor: 'rgba(255,255,255,0.05)',
          zeroline: false,
        },
        yaxis: {
          title: `${yChan.shortName}${yChan.units ? ` (${yChan.units})` : ''}`,
          tickfont: { size: 10, color: '#8b93a8', family: 'JetBrains Mono' },
          gridcolor: 'rgba(255,255,255,0.05)',
          zeroline: false,
        },
        margin: { l: 50, r: 15, t: 15, b: 50 },
        font: { family: 'DM Sans', color: '#8b93a8', size: 11 },
      };

      Plotly.react(chartRef.current, [trace], layout, {
        responsive: true, displayModeBar: false, displaylogo: false
      });
    };

    ensurePlotly(render);
  }, [session, xChan, yChan, yAc]);

  const chanOptions = activeChannels.map(ac => {
    const c = resolveChannel(ac.channelId, session, derivedChannels);
    const count = resolveSamples(ac.channelId, session, derivedSamplesMap).length;
    if (!c) return null;
    return {
      id: ac.channelId,
      label: `${c.shortName}${c.units ? ` (${c.units})` : ''}${count === 0 ? ' \u2014 no data' : ''}`,
      disabled: count === 0,
    };
  }).filter(Boolean) as { id: number; label: string; disabled: boolean }[];

  const xHasData = effectiveXId != null ? resolveSamples(effectiveXId, session, derivedSamplesMap).length > 0 : false;
  const yHasData = effectiveYId != null ? resolveSamples(effectiveYId, session, derivedSamplesMap).length > 0 : false;

  return (
    <div className="p-2 flex flex-col gap-2 h-full">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">X Axis</label>
          <select
            value={effectiveXId ?? ''}
            onChange={e => onChannelChange(e.target.value ? Number(e.target.value) : null, effectiveYId)}
            className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="select-xy-x"
          >
            <option value="">Select...</option>
            {chanOptions.map(c => <option key={c.id} value={c.id} disabled={c.disabled}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Y Axis</label>
          <select
            value={effectiveYId ?? ''}
            onChange={e => onChannelChange(effectiveXId, e.target.value ? Number(e.target.value) : null)}
            className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="select-xy-y"
          >
            <option value="">Select...</option>
            {chanOptions.map(c => <option key={c.id} value={c.id} disabled={c.disabled}>{c.label}</option>)}
          </select>
        </div>
      </div>

      {xChan && yChan && (!xHasData || !yHasData) ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground/50 text-xs italic">
          {!xHasData && !yHasData
            ? `No data for ${xChan.shortName} or ${yChan.shortName}`
            : !xHasData
            ? `No data for X channel: ${xChan.shortName}`
            : `No data for Y channel: ${yChan.shortName}`}
        </div>
      ) : (
        <div ref={chartRef} className="flex-1 min-h-0" style={{ minHeight: '280px' }} data-testid="xyplot-chart" />
      )}

      {(!xChan || !yChan) && (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
          Select two channels to compare
        </div>
      )}
    </div>
  );
}
