import type { ChannelSample } from './xrk-parser';

export interface TableRow {
  timestamp: number; // milliseconds
  values: (number | null)[];
  /** Per-cell flag: true if this is a held/repeated value (not a fresh sample) */
  held: boolean[];
}

/**
 * A unified table over channels at different sample rates, materialised
 * lazily. Only the master timeline and one sample index per channel per row
 * are stored; `rowAt` builds a row when the virtualised view asks for it, so
 * a long session doesn't allocate hundreds of thousands of row objects up front.
 */
export interface TableData {
  /** Master timeline (ms) -- one entry per row. */
  timestamps: number[];
  rowCount: number;
  rowAt(index: number): TableRow;
}

const EMPTY_TABLE: TableData = { timestamps: [], rowCount: 0, rowAt: () => { throw new RangeError('empty table'); } };

/**
 * Build a unified table from multiple channels at different sample rates.
 * Uses the highest-frequency channel's timestamps as the master timeline.
 * Lower-frequency channels repeat their last known value (marked as held).
 */
export function buildTableData(
  channelIds: number[],
  samplesMap: Map<number, ChannelSample[]>,
): TableData {
  if (channelIds.length === 0) return EMPTY_TABLE;

  // Find the channel with the most samples (highest frequency) to use as master timeline
  let master: ChannelSample[] = [];
  for (const id of channelIds) {
    const samples = samplesMap.get(id);
    if (samples && samples.length > master.length) master = samples;
  }
  const n = master.length;
  if (n === 0) return EMPTY_TABLE;
  const timestamps = master.map(s => s.timestamp);

  // For each channel, the index of its last sample at or before each row's
  // timestamp, or -1 while the channel hasn't started yet.
  const channelSamples = channelIds.map(id => samplesMap.get(id) || []);
  const sampleIndex = channelSamples.map(samples => {
    const idx = new Int32Array(n);
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const ts = timestamps[i];
      while (ptr < samples.length - 1 && samples[ptr + 1].timestamp <= ts) ptr++;
      idx[i] = samples.length > 0 && samples[ptr].timestamp <= ts ? ptr : -1;
    }
    return idx;
  });

  const rowAt = (i: number): TableRow => {
    const values: (number | null)[] = new Array(channelIds.length);
    const held: boolean[] = new Array(channelIds.length);
    for (let c = 0; c < channelIds.length; c++) {
      const idx = sampleIndex[c];
      const k = idx[i];
      values[c] = k >= 0 ? channelSamples[c][k].value : null;
      // Held = same sample as the previous row, which already showed it.
      held[c] = k >= 0 && i > 0 && idx[i - 1] === k;
    }
    return { timestamp: timestamps[i], values, held };
  };

  return { timestamps, rowCount: n, rowAt };
}

/**
 * Binary search for the row index closest to the given timestamp (ms).
 */
export function findRowByTimestamp(timestamps: number[], targetMs: number): number {
  if (timestamps.length === 0) return 0;
  let lo = 0;
  let hi = timestamps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0 && Math.abs(timestamps[lo - 1] - targetMs) < Math.abs(timestamps[lo] - targetMs)) {
    return lo - 1;
  }
  return lo;
}
