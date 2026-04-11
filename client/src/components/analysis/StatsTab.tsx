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
        <p className="text-xs text-muted-foreground px-1 pb-1 border-b border-border">
          Mean/StdDev for selected range • Min/Max always full session
        </p>
      )}
      {stats.map(({ chan, color, globalStats: gs, viewStats: vs, totalSamples }) => {
        const hasData = totalSamples > 0;
        const canNavigate = !!onNavigateToTime;
        return (
          <div key={chan.index} className="rounded-lg border border-border overflow-hidden">
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
            {hasData ? (
              <div className="grid grid-cols-2 gap-px bg-border">
                <button
                  className={`bg-card px-2.5 py-1.5 text-left group ${canNavigate ? 'cursor-pointer hover:bg-muted/30 transition-colors' : 'cursor-default'}`}
                  onClick={canNavigate ? () => onNavigateToTime!(gs.minTimestamp) : undefined}
                  disabled={!canNavigate}
                  title={canNavigate ? `Jump to min @ ${formatTime(gs.minTimestamp)}` : undefined}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground leading-none mb-0.5">Min</p>
                    {canNavigate && <Crosshair className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary/60 transition-colors" />}
                  </div>
                  <p className="text-sm font-medium text-foreground tabular">{formatNum(gs.min)}</p>
                  <p className="text-xs text-muted-foreground/50 leading-none mt-0.5">@ {formatTime(gs.minTimestamp)}</p>
                </button>
                <button
                  className={`bg-card px-2.5 py-1.5 text-left group ${canNavigate ? 'cursor-pointer hover:bg-muted/30 transition-colors' : 'cursor-default'}`}
                  onClick={canNavigate ? () => onNavigateToTime!(gs.maxTimestamp) : undefined}
                  disabled={!canNavigate}
                  title={canNavigate ? `Jump to max @ ${formatTime(gs.maxTimestamp)}` : undefined}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground leading-none mb-0.5">Max</p>
                    {canNavigate && <Crosshair className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary/60 transition-colors" />}
                  </div>
                  <p className="text-sm font-medium text-foreground tabular">{formatNum(gs.max)}</p>
                  <p className="text-xs text-muted-foreground/50 leading-none mt-0.5">@ {formatTime(gs.maxTimestamp)}</p>
                </button>
                <div className="bg-card px-2.5 py-1.5">
                  <p className="text-xs text-muted-foreground leading-none mb-0.5">Mean</p>
                  <p className="text-sm font-medium text-foreground tabular">{formatNum(vs.mean)}</p>
                </div>
                <div className="bg-card px-2.5 py-1.5">
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
