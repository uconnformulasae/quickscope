import { useMemo } from 'react';
import type { XRKSession, ChannelSample } from '../../lib/xrk-parser';
import { computeStats, formatTime } from '../../lib/xrk-parser';
import type { ActiveChannel, TimeRange, DerivedChannel } from '../../lib/useXRKStore';
import { TrendingUp, Crosshair } from 'lucide-react';
import { resolveChannel, resolveSamples, formatNum } from './analysis-helpers';

export function StatsTab({ session, activeChannels, viewRange, derivedChannels, derivedSamplesMap, onNavigateToTime }: {
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
      const allSamps = resolveSamples(ac.channelId, session, derivedSamplesMap);
      const globalStats = computeStats(allSamps);
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
        <p className="text-xs text-muted-foreground px-1 pb-1 border-b border-separator">
          Showing statistics for selected zoom range
        </p>
      )}
      {stats.map(({ chan, color, globalStats: gs, viewStats: vs, totalSamples }) => {
        const hasData = totalSamples > 0;
        const canNavigate = !!onNavigateToTime;
        const displayMin = viewRange ? vs.min : gs.min;
        const displayMinTs = viewRange ? vs.minTimestamp : gs.minTimestamp;
        const displayMax = viewRange ? vs.max : gs.max;
        const displayMaxTs = viewRange ? vs.maxTimestamp : gs.maxTimestamp;
        return (
          <div key={chan.index} className="rounded-[11px] bg-popover overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className="text-[13px] font-semibold text-foreground truncate">{chan.shortName}</span>
                {chan.units && <span className="text-label-3 text-xs">({chan.units})</span>}
              </div>
              {hasData ? (
                <span className="text-[11px] text-label-3 tabular">{vs.count.toLocaleString()} pts</span>
              ) : (
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted/60 text-label-3">No data</span>
              )}
            </div>
            {hasData ? (
              <div className="grid grid-cols-2 gap-px px-1.5 pb-1.5">
                <button
                  className={`rounded-lg px-1.5 py-1.5 text-left group ${canNavigate ? 'cursor-pointer hover:bg-muted/30 transition-colors' : 'cursor-default'}`}
                  onClick={canNavigate ? () => onNavigateToTime!(displayMinTs) : undefined}
                  disabled={!canNavigate}
                  title={canNavigate ? `Jump to min @ ${formatTime(displayMinTs)}` : undefined}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-medium text-label-3 leading-none mb-0.5">Min</p>
                    {canNavigate && <Crosshair className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary/60 transition-colors" />}
                  </div>
                  <p className="text-[17px] font-medium text-foreground font-display tabular">{formatNum(displayMin)}</p>
                  <p className="text-[11px] text-label-3 font-mono leading-none mt-0.5">@ {formatTime(displayMinTs)}</p>
                </button>
                <button
                  className={`rounded-lg px-1.5 py-1.5 text-left group ${canNavigate ? 'cursor-pointer hover:bg-muted/30 transition-colors' : 'cursor-default'}`}
                  onClick={canNavigate ? () => onNavigateToTime!(displayMaxTs) : undefined}
                  disabled={!canNavigate}
                  title={canNavigate ? `Jump to max @ ${formatTime(displayMaxTs)}` : undefined}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-medium text-label-3 leading-none mb-0.5">Max</p>
                    {canNavigate && <Crosshair className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary/60 transition-colors" />}
                  </div>
                  <p className="text-[17px] font-medium text-foreground font-display tabular">{formatNum(displayMax)}</p>
                  <p className="text-[11px] text-label-3 font-mono leading-none mt-0.5">@ {formatTime(displayMaxTs)}</p>
                </button>
                <div className="px-1.5 py-1.5">
                  <p className="text-[11px] font-medium text-label-3 leading-none mb-0.5">Mean</p>
                  <p className="text-[17px] font-medium text-foreground font-display tabular">{formatNum(vs.mean)}</p>
                </div>
                <div className="px-1.5 py-1.5">
                  <p className="text-[11px] font-medium text-label-3 leading-none mb-0.5">Std Dev</p>
                  <p className="text-[17px] font-medium text-foreground font-display tabular">{formatNum(vs.stdDev)}</p>
                </div>
              </div>
            ) : (
              <div className="px-3 py-3 text-xs text-label-3 italic">
                No data recorded for this channel in this session
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
