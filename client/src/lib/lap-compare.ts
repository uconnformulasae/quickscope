/** Lap windows and lap-relative time for lap selection / compare. */
import type { ChannelSample, LapMarker } from './xrk-parser';
import { sampleLowerBound } from './binary-search';

export interface LapWindow {
  index: number;
  lapNumber: number;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export function buildLapWindows(markers: LapMarker[]): LapWindow[] {
  const out: LapWindow[] = [];
  for (let i = 0; i < markers.length - 1; i++) {
    const startMs = markers[i].timestamp;
    const endMs = markers[i + 1].timestamp;
    out.push({ index: i, lapNumber: markers[i].lapNumber ?? i + 1, startMs, endMs, durationMs: endMs - startMs });
  }
  return out;
}

/** Selected lap windows, in selection order, skipping indices that aren't laps. */
export function selectedWindows(windows: LapWindow[], selected: number[]): LapWindow[] {
  return selected.map(i => windows[i]).filter((w): w is LapWindow => !!w);
}

export const LAP_COMPARE_PALETTE = ['#4361ee', '#f77f00', '#10b981', '#e11d48', '#a855f7', '#eab308'];

export function lapColor(order: number): string {
  return LAP_COMPARE_PALETTE[order % LAP_COMPARE_PALETTE.length];
}

/** Lap-relative seconds → session ms for a given lap. */
export function toSessionMs(lapRelSec: number, lap: LapWindow): number {
  return lap.startMs + lapRelSec * 1000;
}

/** The lap's samples (startMs..endMs inclusive), re-timed so the lap starts at 0. */
export function shiftToLap(samples: ChannelSample[], lap: LapWindow): ChannelSample[] {
  const lo = sampleLowerBound(samples, lap.startMs);
  const out: ChannelSample[] = [];
  for (let i = lo; i < samples.length && samples[i].timestamp <= lap.endMs; i++) {
    out.push({ timestamp: samples[i].timestamp - lap.startMs, value: samples[i].value });
  }
  return out;
}

/** Whether session time tMs falls in any of the given laps (true when none given). */
export function segmentInLaps(tMs: number, laps: LapWindow[]): boolean {
  if (laps.length === 0) return true;
  return laps.some(l => tMs >= l.startMs && tMs <= l.endMs);
}
