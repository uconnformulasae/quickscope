import type { XRKSession, ChannelSample } from './xrk-parser';

/** How an overlay's timeline maps onto the primary's timeline. */
export type OverlayAlignment =
  | { kind: 'raw' }
  | { kind: 'lap'; primaryLap: number; overlayLap: number }
  | { kind: 'manual'; offsetMs: number };

export interface OverlayState {
  /** Backend session_id (UUID). Stable across reloads. */
  id: string;
  /** Display name (filename minus extension). */
  label: string;
  /** Parsed metadata + channel index. samples are lazy-loaded like the primary. */
  session: XRKSession;
  /** True when the user wants the overlay drawn. False = hidden but kept loaded. */
  visible: boolean;
  /** Time-alignment configuration. */
  alignment: OverlayAlignment;
  /** Raw channel samples keyed by overlay channel id (matched to primary by
   *  shortName). Lazy-filled. */
  samples: Map<number, ChannelSample[]>;
  /** Derived-channel samples computed against this overlay, keyed by the
   *  *primary's* derived channel id. Only populated for formula-mode derived
   *  channels (Python-mode is primary-only). Recomputed on overlay add and on
   *  any primary derived-channel change. */
  derivedSamples: Map<number, ChannelSample[]>;
}

/** Map a primary channel id to the overlay's matching channel id (by shortName).
 *  Returns -1 if no match. */
export function findOverlayChannelId(
  primary: XRKSession,
  overlay: XRKSession,
  primaryChannelId: number,
): number {
  const primaryDef = primary.channels.get(primaryChannelId);
  if (!primaryDef) return -1;
  for (const [oid, odef] of overlay.channels) {
    if (odef.shortName === primaryDef.shortName) return oid;
  }
  return -1;
}

/** Returns true when the matched overlay channel has different units than primary. */
export function hasUnitsMismatch(
  primary: XRKSession,
  overlay: XRKSession,
  primaryChannelId: number,
): boolean {
  const oid = findOverlayChannelId(primary, overlay, primaryChannelId);
  if (oid === -1) return false;
  const pUnits = (primary.channels.get(primaryChannelId)?.units || '').trim();
  const oUnits = (overlay.channels.get(oid)?.units || '').trim();
  return pUnits !== oUnits;
}
