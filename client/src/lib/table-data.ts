import type { ChannelSample } from './xrk-parser';

export interface TableRow {
  timestamp: number; // milliseconds
  values: (number | null)[];
  /** Per-cell flag: true if this is a held/repeated value (not a fresh sample) */
  held: boolean[];
}

/**
 * Build a unified table from multiple channels at different sample rates.
 * Uses the highest-frequency channel's timestamps as the master timeline.
 * Lower-frequency channels repeat their last known value (marked as held).
 */
export function buildTableData(
  channelIds: number[],
  samplesMap: Map<number, ChannelSample[]>,
): TableRow[] {
  if (channelIds.length === 0) return [];

  // Find the channel with the most samples (highest frequency) to use as master timeline
  let masterTimestamps: number[] = [];
  for (const id of channelIds) {
    const samples = samplesMap.get(id);
    if (samples && samples.length > masterTimestamps.length) {
      masterTimestamps = samples.map(s => s.timestamp);
    }
  }

  if (masterTimestamps.length === 0) return [];

  // For each channel, build a pointer-based walk through its samples
  const channelPointers = channelIds.map(id => {
    const samples = samplesMap.get(id) || [];
    return { samples, ptr: 0 };
  });

  const rows: TableRow[] = new Array(masterTimestamps.length);

  for (let i = 0; i < masterTimestamps.length; i++) {
    const ts = masterTimestamps[i];
    const values: (number | null)[] = new Array(channelIds.length);
    const held: boolean[] = new Array(channelIds.length);

    for (let c = 0; c < channelIds.length; c++) {
      const ch = channelPointers[c];
      const { samples, ptr } = ch;

      if (samples.length === 0) {
        values[c] = null;
        held[c] = false;
        continue;
      }

      // Advance pointer to the last sample at or before this timestamp
      while (ch.ptr < samples.length - 1 && samples[ch.ptr + 1].timestamp <= ts) {
        ch.ptr++;
      }

      const sample = samples[ch.ptr];
      if (sample.timestamp <= ts) {
        values[c] = sample.value;
        held[c] = sample.timestamp < ts;
      } else {
        values[c] = null;
        held[c] = false;
      }
    }

    rows[i] = { timestamp: ts, values, held };
  }

  return rows;
}

/**
 * Binary search for the row index closest to the given timestamp (ms).
 */
export function findRowByTimestamp(rows: TableRow[], targetMs: number): number {
  if (rows.length === 0) return 0;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].timestamp < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0 && Math.abs(rows[lo - 1].timestamp - targetMs) < Math.abs(rows[lo].timestamp - targetMs)) {
    return lo - 1;
  }
  return lo;
}
