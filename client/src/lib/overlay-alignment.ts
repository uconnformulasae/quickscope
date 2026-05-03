import type { ChannelSample, LapMarker, XRKSession } from './xrk-parser';
import type { OverlayAlignment } from './overlay-types';

/** Compute the time offset (ms) to add to overlay timestamps so they align
 *  with the primary's timeline.
 *
 *  - 'raw'    → 0
 *  - 'manual' → user-provided offset
 *  - 'lap'    → primary.lapMarkers[primaryLap].timestamp - overlay.lapMarkers[overlayLap].timestamp
 *
 *  Returns 0 if the alignment can't be resolved (e.g. lap index out of range). */
export function computeAlignmentOffsetMs(
  primary: XRKSession,
  overlay: XRKSession,
  alignment: OverlayAlignment,
): number {
  switch (alignment.kind) {
    case 'raw':
      return 0;
    case 'manual':
      return alignment.offsetMs;
    case 'lap': {
      const p = primary.lapMarkers[alignment.primaryLap];
      const o = overlay.lapMarkers[alignment.overlayLap];
      if (!p || !o) return 0;
      return p.timestamp - o.timestamp;
    }
  }
}

/** Index of the fastest lap (smallest end-start gap) in a session.
 *  Returns -1 if fewer than 2 lap markers (need start+end pair). */
export function fastestLapIndex(lapMarkers: LapMarker[]): number {
  if (lapMarkers.length < 2) return -1;
  let bestIdx = 0;
  let bestDur = Infinity;
  for (let i = 0; i + 1 < lapMarkers.length; i++) {
    const dur = lapMarkers[i + 1].timestamp - lapMarkers[i].timestamp;
    if (dur > 0 && dur < bestDur) { bestDur = dur; bestIdx = i; }
  }
  return bestIdx;
}

/** Default alignment: best-lap-aligned if both have ≥ 2 lap markers,
 *  else raw. */
export function defaultAlignment(
  primary: XRKSession,
  overlay: XRKSession,
): OverlayAlignment {
  const p = fastestLapIndex(primary.lapMarkers);
  const o = fastestLapIndex(overlay.lapMarkers);
  if (p === -1 || o === -1) return { kind: 'raw' };
  return { kind: 'lap', primaryLap: p, overlayLap: o };
}

/** Apply offset (ms) to every sample's timestamp. Allocates a new array;
 *  non-destructive. Returns the same reference if offset is zero
 *  (cheap fast-path for the common 'raw' case). */
export function applyOffset(samples: ChannelSample[], offsetMs: number): ChannelSample[] {
  if (offsetMs === 0 || samples.length === 0) return samples;
  const out = new Array<ChannelSample>(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = { timestamp: samples[i].timestamp + offsetMs, value: samples[i].value };
  }
  return out;
}
