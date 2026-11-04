/** Lap windows and lap-relative time for lap selection / compare. */
import type { LapMarker } from './xrk-parser';

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

/** Lap-relative x-range in seconds: [0, longest selected lap]. */
export function lapRelativeRange(windows: LapWindow[], selected: number[]): [number, number] {
  let longest = 0;
  for (const w of selectedWindows(windows, selected)) longest = Math.max(longest, w.durationMs);
  return [0, longest / 1000];
}

export const LAP_COMPARE_PALETTE = ['#4361ee', '#f77f00', '#10b981', '#e11d48', '#a855f7', '#eab308'];

export function lapColor(order: number): string {
  return LAP_COMPARE_PALETTE[order % LAP_COMPARE_PALETTE.length];
}
