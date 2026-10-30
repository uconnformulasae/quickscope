import type { XRKSession } from '../lib/xrk-parser';
import type { ActiveChannel, AnalysisTab, TimeRange, DerivedChannel } from '../lib/useXRKStore';
import type { ChannelSample } from '../lib/xrk-parser';
import { SegmentedControl } from './ui/SegmentedControl';
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
}

const TABS: { value: AnalysisTab; label: string }[] = [
  { value: 'stats', label: 'Stats' },
  { value: 'lapanalysis', label: 'Laps' },
  { value: 'histogram', label: 'Histogram' },
  { value: 'xyplot', label: 'XY' },
  { value: 'gps', label: 'GPS' },
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
}: AnalysisPanelProps) {
  return (
    <div className="flex flex-col h-full bg-card border-l border-separator overflow-hidden">
      {/* Tab bar */}
      <div className="flex-shrink-0 flex justify-center p-2.5">
        <SegmentedControl size="sm" ariaLabel="Analysis" value={analysisTab} options={TABS} onChange={onTabChange} />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {analysisTab === 'stats' && (
          <StatsTab session={session} activeChannels={activeChannels} viewRange={viewRange} derivedChannels={derivedChannels} derivedSamplesMap={derivedSamplesMap} onNavigateToTime={onNavigateToTime} />
        )}
        {analysisTab === 'lapanalysis' && (
          <LapAnalysisTab session={session} activeChannels={activeChannels} derivedChannels={derivedChannels} derivedSamplesMap={derivedSamplesMap} />
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
