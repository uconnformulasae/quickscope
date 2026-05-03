import { useMemo } from 'react';
import type { XRKSession, LapSource } from '../../lib/xrk-parser';
import { computeStats, formatLapTime } from '../../lib/xrk-parser';
import type { ActiveChannel } from '../../lib/useXRKStore';
import type { OverlayState } from '../../lib/overlay-types';
import { Timer } from 'lucide-react';
import { formatNum } from './analysis-helpers';

const LAP_SOURCE_LABEL: Record<LapSource, string> = {
  device: 'Device markers',
  gps_auto: 'Auto-detected (GPS)',
  beacon_auto: 'Auto-detected (beacon)',
  gps_manual: 'Manual setpoint',
  none: 'No laps',
};

const LAP_SOURCE_TONE: Record<LapSource, string> = {
  device: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  gps_auto: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  beacon_auto: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  gps_manual: 'bg-primary/15 text-primary border-primary/30',
  none: 'bg-muted text-muted-foreground border-border',
};

const MIN_LAP_S = 10; // mirror lap_detection.py threshold

interface LapEntry {
  lapNum: number;
  startMs: number;
  endMs: number;
  lapTimeS: number;
}

function extractLaps(session: XRKSession): LapEntry[] {
  const markers = session.lapMarkers;
  if (markers.length < 2) return [];
  const out: LapEntry[] = [];
  for (let i = 0; i < markers.length - 1; i++) {
    const startMs = markers[i].timestamp;
    const endMs = markers[i + 1].timestamp;
    const lapTimeS = (endMs - startMs) / 1000;
    out.push({ lapNum: i + 1, startMs, endMs, lapTimeS });
  }
  return out;
}

function shortLabel(label: string | undefined | null, fallback: string): string {
  if (!label) return fallback;
  const stem = label.replace(/\.(xrk|xrz)$/i, '');
  return stem.length > 14 ? stem.slice(0, 13) + '…' : stem;
}

export function LapAnalysisTab({
  session, activeChannels, overlays = [], primaryLabel,
}: {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  overlays?: OverlayState[];
  primaryLabel?: string | null;
}) {
  // Single-session view (no overlays) — sector-aware per lap-mapper's design.
  const { lapData, theoreticalBestSectorTimes, sectorBestLapIdx } = useMemo(() => {
    const markers = session.lapMarkers;
    if (markers.length < 2) {
      return { lapData: [], theoreticalBestSectorTimes: [] as (number | null)[], sectorBestLapIdx: [] as number[] };
    }

    const laps: Array<{
      lapNum: number;
      startMs: number;
      endMs: number;
      lapTimeS: number;
      channelStats: Record<string, any>;
      sectorSplits: (number | null)[];
      isBest: boolean;
    }> = [];
    let bestLap = -1;
    let bestTime = Infinity;

    for (let i = 0; i < markers.length - 1; i++) {
      const startMs = markers[i].timestamp;
      const endMs = markers[i + 1].timestamp;
      const lapTimeS = (endMs - startMs) / 1000;

      if (lapTimeS < bestTime && lapTimeS > MIN_LAP_S) {
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

      // Per-sector split times in seconds. Each marker carries sector boundary
      // timestamps in absolute ms; a split is (boundary - previous_boundary).
      // Missed sectors (null) don't advance the cursor so the next known split
      // measures from the last KNOWN boundary.
      const sectorTimesAbs = markers[i].sectorTimes ?? [];
      const sectorSplits: (number | null)[] = [];
      let prevBoundaryMs: number = startMs;
      for (let s = 0; s < sectorTimesAbs.length; s++) {
        const tAbs = sectorTimesAbs[s];
        if (tAbs == null) {
          sectorSplits.push(null);
        } else {
          sectorSplits.push((tAbs - prevBoundaryMs) / 1000);
          prevBoundaryMs = tAbs;
        }
      }
      if (sectorTimesAbs.length > 0) {
        sectorSplits.push((endMs - prevBoundaryMs) / 1000);
      }

      laps.push({ lapNum: i + 1, startMs, endMs, lapTimeS, channelStats, sectorSplits, isBest: false });
    }

    if (bestLap >= 0) laps[bestLap].isBest = true;

    const sectorCount = laps[0]?.sectorSplits.length ?? 0;
    const theoreticalBest: (number | null)[] = new Array(sectorCount).fill(null);
    const bestIdx: number[] = new Array(sectorCount).fill(-1);
    for (let s = 0; s < sectorCount; s++) {
      let bestT: number | null = null;
      let bestI = -1;
      for (let i = 0; i < laps.length; i++) {
        const v = laps[i].sectorSplits[s];
        if (v == null || !isFinite(v) || v <= 0) continue;
        if (bestT == null || v < bestT) {
          bestT = v;
          bestI = i;
        }
      }
      theoreticalBest[s] = bestT;
      bestIdx[s] = bestI;
    }

    return { lapData: laps, theoreticalBestSectorTimes: theoreticalBest, sectorBestLapIdx: bestIdx };
  }, [session, activeChannels]);

  // Cross-session comparison view (overlays present)
  const comparison = useMemo(() => {
    if (overlays.length === 0) return null;
    const allSessions: { id: string; label: string; laps: LapEntry[] }[] = [
      { id: '__primary__', label: shortLabel(primaryLabel, 'Primary'), laps: extractLaps(session) },
      ...overlays.map((ov, i) => ({
        id: ov.id,
        label: shortLabel(ov.label, `Overlay #${i + 1}`),
        laps: extractLaps(ov.session),
      })),
    ];

    // Build per-session best lap times (track-realistic) and overall best
    let overallBest = Infinity;
    let overallBestSessionId = '';
    let overallBestLapIdx = -1;
    const sessionBestTimes: Record<string, number> = {};
    for (const s of allSessions) {
      let best = Infinity;
      for (let i = 0; i < s.laps.length; i++) {
        const t = s.laps[i].lapTimeS;
        if (t > MIN_LAP_S && t < best) best = t;
        if (t > MIN_LAP_S && t < overallBest) {
          overallBest = t;
          overallBestSessionId = s.id;
          overallBestLapIdx = i;
        }
      }
      sessionBestTimes[s.id] = best;
    }

    const maxLaps = Math.max(...allSessions.map(s => s.laps.length), 0);
    return {
      sessions: allSessions,
      maxLaps,
      sessionBestTimes,
      overallBest: overallBest === Infinity ? null : overallBest,
      overallBestSessionId,
      overallBestLapIdx,
    };
  }, [session, overlays, primaryLabel]);

  if (session.lapMarkers.length < 2 && overlays.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-xs gap-2 p-4">
        <Timer className="w-6 h-6 opacity-40" />
        <p>No lap markers found in session</p>
      </div>
    );
  }

  // ─── Comparison view ─────────────────────────────────────────────────────
  if (comparison && overlays.length > 0) {
    const { sessions, maxLaps, sessionBestTimes, overallBest, overallBestSessionId, overallBestLapIdx } = comparison;
    return (
      <div className="p-2">
        <div className="mb-2 text-xs text-muted-foreground">
          Comparing {sessions.length} sessions ({sessions.length - 1} overlay{sessions.length - 1 === 1 ? '' : 's'})
        </div>
        {overallBest != null && (
          <div className="mb-3 p-2.5 rounded-lg bg-primary/10 border border-primary/20">
            <p className="text-xs text-muted-foreground">Best across all sessions</p>
            <p className="text-lg font-bold text-primary tabular mt-0.5">{formatLapTime(overallBest)}</p>
            <p className="text-[10px] text-muted-foreground/80 mt-0.5">
              {sessions.find(s => s.id === overallBestSessionId)?.label} — Lap {overallBestLapIdx + 1}
            </p>
          </div>
        )}
        {/* Per-session best lap times */}
        <div className="mb-3 grid grid-cols-2 gap-1.5">
          {sessions.map(s => {
            const best = sessionBestTimes[s.id];
            const isOverall = s.id === overallBestSessionId;
            return (
              <div
                key={s.id}
                className={`rounded-md border p-1.5 ${isOverall ? 'border-primary/40 bg-primary/5' : 'border-border'}`}
              >
                <p className={`text-[10px] truncate ${isOverall ? 'text-primary' : 'text-muted-foreground'}`} title={s.label}>
                  {s.label}
                </p>
                <p className={`text-xs font-bold tabular ${isOverall ? 'text-primary' : 'text-foreground'}`}>
                  {best === Infinity ? '—' : formatLapTime(best)}
                </p>
              </div>
            );
          })}
        </div>
        {/* Lap-by-lap comparison table */}
        {maxLaps > 0 && (
          <div className="rounded-lg border border-border overflow-hidden">
            <div
              className="grid border-b border-border bg-muted/30"
              style={{ gridTemplateColumns: `40px repeat(${sessions.length}, minmax(0, 1fr))` }}
            >
              <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Lap</div>
              {sessions.map(s => (
                <div
                  key={s.id}
                  className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider truncate"
                  title={s.label}
                >
                  {s.label}
                </div>
              ))}
            </div>
            {Array.from({ length: maxLaps }, (_, i) => i).map(lapIdx => (
              <div
                key={lapIdx}
                className="grid border-b border-border/50 last:border-b-0"
                style={{ gridTemplateColumns: `40px repeat(${sessions.length}, minmax(0, 1fr))` }}
              >
                <div className="px-2 py-1.5 text-xs tabular text-muted-foreground">L{lapIdx + 1}</div>
                {sessions.map(s => {
                  const lap = s.laps[lapIdx];
                  if (!lap) {
                    return <div key={s.id} className="px-2 py-1.5 text-xs tabular text-muted-foreground/40">—</div>;
                  }
                  const isBestForSession = lap.lapTimeS > MIN_LAP_S && lap.lapTimeS === sessionBestTimes[s.id];
                  const isOverallBest = s.id === overallBestSessionId && lapIdx === overallBestLapIdx;
                  const cls = isOverallBest
                    ? 'text-primary font-bold'
                    : isBestForSession
                      ? 'text-foreground font-semibold'
                      : 'text-foreground';
                  return (
                    <div key={s.id} className={`px-2 py-1.5 text-xs tabular ${cls}`}>
                      {formatLapTime(lap.lapTimeS)}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── Single-session view (no overlays) ───────────────────────────────────
  const bestTime = lapData.find(l => l.isBest)?.lapTimeS;
  const sourceTag = LAP_SOURCE_LABEL[session.lapSource] ?? 'Unknown source';
  const sourceTone = LAP_SOURCE_TONE[session.lapSource] ?? LAP_SOURCE_TONE.none;
  const hasSectors = theoreticalBestSectorTimes.length > 0;
  const sumOfBests = hasSectors && theoreticalBestSectorTimes.every(t => t != null)
    ? (theoreticalBestSectorTimes as number[]).reduce((a, b) => a + b, 0)
    : null;

  const fmtSplit = (s: number | null): string => {
    if (s == null || !isFinite(s)) return '—';
    return s.toFixed(3);
  };

  return (
    <div className="p-2">
      <div className={`mb-2 inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${sourceTone}`}>
        {sourceTag}
      </div>
      {bestTime && (
        <div className="mb-3 p-2.5 rounded-lg bg-primary/10 border border-primary/20">
          <p className="text-xs text-muted-foreground">Best Lap</p>
          <p className="text-lg font-bold text-primary tabular mt-0.5">{formatLapTime(bestTime)}</p>
          {sumOfBests != null && (
            <>
              <p className="text-xs text-muted-foreground mt-1.5">Theoretical Best (sum of best sectors)</p>
              <p className="text-sm font-semibold text-primary tabular mt-0.5">{formatLapTime(sumOfBests)}</p>
            </>
          )}
        </div>
      )}
      <div className="space-y-1.5">
        {lapData.map((lap, lapIdx) => (
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
            {lap.sectorSplits.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {lap.sectorSplits.map((split, sIdx) => {
                  const isBestSector = sectorBestLapIdx[sIdx] === lapIdx && split != null;
                  return (
                    <span
                      key={sIdx}
                      className={`text-xs tabular px-1.5 py-0.5 rounded border ${
                        isBestSector
                          ? 'bg-primary/20 text-primary border-primary/40'
                          : 'bg-muted/30 text-muted-foreground border-border/60'
                      }`}
                    >
                      <span className="text-[10px] mr-1 opacity-70">S{sIdx + 1}</span>
                      {fmtSplit(split)}
                    </span>
                  );
                })}
              </div>
            )}
            <div className="grid grid-cols-3 gap-1">
              {Object.entries(lap.channelStats).map(([name, s]) => (
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
