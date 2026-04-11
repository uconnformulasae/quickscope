import { useMemo } from 'react';
import type { XRKSession } from '../../lib/xrk-parser';
import { computeStats, formatLapTime } from '../../lib/xrk-parser';
import type { ActiveChannel } from '../../lib/useXRKStore';
import { Timer } from 'lucide-react';
import { formatNum } from './analysis-helpers';

export function LapAnalysisTab({ session, activeChannels }: {
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

      if (lapTimeS < bestTime && lapTimeS > 10) {
        bestTime = lapTimeS;
        bestLap = i;
      }

      const channelStats: Record<string, any> = {};
      for (const ac of activeChannels.slice(0, 3)) {
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
            className={`rounded-lg border p-2.5 transition-colors ${lap.isBest ? 'border-primary/40 bg-primary/5' : 'border-border'}`}
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
            <div className="grid grid-cols-3 gap-1">
              {Object.entries(lap.channelStats).map(([name, s]: [string, any]) => (
                <div key={name} className="text-center">
                  <p className="text-xs tabular font-medium" style={{ color: s.color }}>{formatNum(s.mean)}</p>
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
