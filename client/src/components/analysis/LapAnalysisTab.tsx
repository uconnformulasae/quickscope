import { useMemo } from 'react';
import type { XRKSession, LapSource } from '../../lib/xrk-parser';
import { computeStats, formatLapTime } from '../../lib/xrk-parser';
import type { ActiveChannel, DerivedChannel } from '../../lib/useXRKStore';
import { Timer } from 'lucide-react';
import { lapColor } from '../../lib/lap-compare';
import { formatNum, resolveChannel, resolveSamples } from './analysis-helpers';
import { useDisplaySamples } from '../../lib/useDisplaySamples';
import { samplesInRange } from '../../lib/binary-search';

/** Laps shorter than this fraction of the median lap can't be the best lap. */
const MIN_BEST_LAP_FRACTION = 0.5;
/** Laps longer than this multiple of the median are flagged "slow" (out/in laps, stops). */
const SLOW_LAP_FACTOR = 1.3;

const LAP_SOURCE_LABEL: Record<LapSource, string> = {
  device: 'Device markers',
  gps_auto: 'Auto-detected (GPS)',
  beacon_auto: 'Auto-detected (beacon)',
  none: 'No laps',
};

const LAP_SOURCE_TONE: Record<LapSource, string> = {
  device: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  gps_auto: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  beacon_auto: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  none: 'bg-muted text-muted-foreground border-border',
};

export function LapAnalysisTab({
  session,
  activeChannels,
  derivedChannels,
  derivedSamplesMap,
  selectedLaps = [],
  onToggleLap,
  onSetSelectedLaps,
}: {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, any>;
  /** Lap indices (marker-pair order) selected for zoom/compare, in selection order. */
  selectedLaps?: number[];
  onToggleLap?: (index: number) => void;
  onSetSelectedLaps?: (indices: number[]) => void;
}) {
  const display = useDisplaySamples();
  const lapData = useMemo(() => {
    const markers = session.lapMarkers;
    if (markers.length < 2) return [];

    const laps = [];
    let bestLap = -1;
    let bestTime = Infinity;

    // A "lap" far shorter than the typical lap is a spurious marker (double
    // beacon hit, pit-lane split), not a best lap. Relative to the median so
    // short autocross/kart laps still qualify.
    const lapTimes = markers.slice(1).map((m, i) => (m.timestamp - markers[i].timestamp) / 1000);
    const sortedTimes = [...lapTimes].sort((a, b) => a - b);
    const medianLapS = sortedTimes[Math.floor(sortedTimes.length / 2)];
    const minBestLapS = medianLapS * MIN_BEST_LAP_FRACTION;

    // Resolve each shown channel once, not once per lap.
    const shown = activeChannels.slice(0, 3).flatMap(ac => {
      const chan = resolveChannel(ac.channelId, session, derivedChannels, display);
      if (!chan) return [];
      return [{
        name: chan.shortName,
        color: ac.color,
        samples: resolveSamples(ac.channelId, session, derivedSamplesMap, display, derivedChannels),
      }];
    });

    for (let i = 0; i < markers.length - 1; i++) {
      const startMs = markers[i].timestamp;
      const endMs = markers[i + 1].timestamp;
      const lapTimeS = (endMs - startMs) / 1000;

      if (lapTimeS < bestTime && lapTimeS >= minBestLapS) {
        bestTime = lapTimeS;
        bestLap = i;
      }

      const channelStats: Record<string, any> = {};
      for (const { name, color, samples } of shown) {
        // Samples are time-sorted: bisect to the lap, don't test every sample.
        channelStats[name] = { ...computeStats(samplesInRange(samples, startMs, endMs)), color };
      }

      laps.push({
        index: i, lapNum: markers[i].lapNumber ?? (i + 1), startMs, endMs, lapTimeS, channelStats,
        isBest: false, isSlow: lapTimeS > medianLapS * SLOW_LAP_FACTOR, gapS: 0,
      });
    }

    if (bestLap >= 0) {
      laps[bestLap].isBest = true;
      for (const l of laps) l.gapS = l.lapTimeS - bestTime;
    }
    return laps;
  }, [session, activeChannels, derivedChannels, derivedSamplesMap, display]);

  if (session.lapMarkers.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-xs gap-2 p-4">
        <Timer className="w-6 h-6 opacity-40" />
        <p>No lap markers found in session</p>
      </div>
    );
  }

  const bestLap = lapData.find(l => l.isBest);
  const bestTime = bestLap?.lapTimeS;
  const selectable = !!onToggleLap;
  const sourceTag = LAP_SOURCE_LABEL[session.lapSource] ?? 'Unknown source';
  const sourceTone = LAP_SOURCE_TONE[session.lapSource] ?? LAP_SOURCE_TONE.none;

  return (
    <div className="p-2">
      <div className={`mb-2 inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${sourceTone}`}>
        {sourceTag}
      </div>
      {bestTime && (
        <div className="mb-3 p-2.5 rounded-lg bg-primary/10 border border-primary/20">
          <p className="text-xs text-muted-foreground">Best Lap</p>
          <p className="text-lg font-bold text-primary-text tabular mt-0.5">{formatLapTime(bestTime)}</p>
        </div>
      )}
      {selectable && (
        <div className="mb-2 flex items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={() => bestLap && onSetSelectedLaps?.([bestLap.index])}
            disabled={!bestLap}
            className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-40"
          >
            Select best
          </button>
          <button
            type="button"
            onClick={() => onSetSelectedLaps?.([])}
            disabled={selectedLaps.length === 0}
            className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-40"
          >
            Clear
          </button>
          <span className="ml-auto text-muted-foreground">
            {selectedLaps.length >= 2
              ? `${selectedLaps.length} selected — comparing`
              : selectedLaps.length === 1 ? '1 selected' : 'Tick laps to zoom or compare'}
          </span>
        </div>
      )}
      <div className="space-y-1.5">
        {lapData.map(lap => {
          const order = selectedLaps.indexOf(lap.index);
          const isSelected = order >= 0;
          return (
          <div
            key={lap.lapNum}
            onClick={selectable ? () => onToggleLap?.(lap.index) : undefined}
            className={`rounded-lg border p-2.5 transition-colors ${selectable ? 'cursor-pointer hover:bg-muted/30' : ''} ${isSelected ? 'ring-1 ring-primary/50' : ''} ${lap.isBest ? 'border-primary/40 bg-primary/5' : 'border-border'} ${lap.isSlow && !isSelected ? 'opacity-60' : ''}`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                {selectable && (
                  <input
                    type="checkbox"
                    aria-label={`Select lap ${lap.lapNum}`}
                    checked={isSelected}
                    onClick={e => e.stopPropagation()}
                    onChange={() => onToggleLap?.(lap.index)}
                    className="accent-primary"
                  />
                )}
                {isSelected && selectedLaps.length >= 2 && (
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: lapColor(order) }} aria-hidden />
                )}
                <span className={`text-xs font-semibold tabular ${lap.isBest ? 'text-primary-text' : 'text-foreground'}`}>
                  Lap {lap.lapNum}
                </span>
                {lap.isBest && (
                  <span className="text-xs bg-primary/20 text-primary-text px-1.5 py-0.5 rounded-full">Best</span>
                )}
                {lap.isSlow && (
                  <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">slow</span>
                )}
              </div>
              <div className="flex items-baseline gap-2">
                {/* No gap on the first lap: it runs from the start of the log
                    to the first beacon, so a difference to the best lap is meaningless. */}
                {!lap.isBest && bestTime !== undefined && lap.index !== 0 && (
                  <span className={`text-xs tabular ${lap.gapS < 1 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                    +{lap.gapS.toFixed(3)}
                  </span>
                )}
                <span className={`text-sm font-bold tabular ${lap.isBest ? 'text-primary-text' : 'text-foreground'}`}>
                  {formatLapTime(lap.lapTimeS)}
                </span>
              </div>
            </div>
            {/* Columns share the width evenly and never overflow into each
                other: long channel names truncate (full name on hover). */}
            <div
              className="grid gap-x-2 gap-y-1"
              style={{ gridTemplateColumns: `repeat(${Math.max(1, Object.keys(lap.channelStats).length)}, minmax(0, 1fr))` }}
            >
              {Object.entries(lap.channelStats).map(([name, s]: [string, any]) => (
                <div key={name} className="min-w-0 text-center">
                  <p className="text-xs tabular font-medium truncate" style={{ color: s.color }}>{formatNum(s.mean)}</p>
                  <p className="text-xs text-muted-foreground truncate" title={name}>{name}</p>
                </div>
              ))}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
