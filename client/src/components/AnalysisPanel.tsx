import type { XRKSession } from '../lib/xrk-parser';
import type { ActiveChannel, AnalysisTab, TimeRange, DerivedChannel } from '../lib/useXRKStore';
import type { ChannelSample } from '../lib/xrk-parser';
import type { OverlayState } from '../lib/overlay-types';
import { BarChart3, Activity, ScatterChart, Timer, MapPin } from 'lucide-react';
import { GPSMapView } from './GPSMapView';
import { StatsTab } from './analysis/StatsTab';
import { LapAnalysisTab } from './analysis/LapAnalysisTab';
import { HistogramTab } from './analysis/HistogramTab';
import { XYPlotTab } from './analysis/XYPlotTab';

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
  cursorTime?: number | null;
  theme?: 'dark' | 'light';
  overlays?: OverlayState[];
  fileName?: string | null;
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
  cursorTime,
  theme,
  overlays,
  fileName,
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
          <LapAnalysisTab
            session={session}
            activeChannels={activeChannels}
            overlays={overlays}
            primaryLabel={fileName}
          />
        )}
        {analysisTab === 'histogram' && (
          <HistogramTab
            session={session}
            activeChannels={activeChannels}
            channelId={histogramChannelId}
            onChannelChange={onHistogramChannelChange}
            derivedChannels={derivedChannels}
            derivedSamplesMap={derivedSamplesMap}
            theme={theme}
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
            theme={theme}
          />
        )}
        {analysisTab === 'gps' && (
          <GPSMapView cursorTime={cursorTime} />
        )}
      </div>
    </div>
  );
}
