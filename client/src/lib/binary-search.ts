/**
 * Binary searches over time-sorted data. Every lookup by timestamp in the app
 * goes through these, for plain number arrays and for sample arrays alike.
 */
import type { ChannelSample } from './xrk-parser';

/** First index whose value is >= `v` (`arr.length` when none is). */
export function lowerBound(arr: ArrayLike<number>, v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** First index whose value is > `v` (`arr.length` when none is). */
export function upperBound(arr: ArrayLike<number>, v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** First sample at or after `tMs` (`samples.length` when none is). */
export function sampleLowerBound(samples: ChannelSample[], tMs: number): number {
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].timestamp < tMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** First sample after `tMs` (`samples.length` when none is). */
export function sampleUpperBound(samples: ChannelSample[], tMs: number): number {
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].timestamp <= tMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Index of the value closest to `v`; the earlier one on a tie; 0 for an empty array. */
export function nearestIndex(arr: ArrayLike<number>, v: number): number {
  if (arr.length === 0) return 0;
  const i = Math.min(lowerBound(arr, v), arr.length - 1);
  return i > 0 && Math.abs(arr[i - 1] - v) < Math.abs(arr[i] - v) ? i - 1 : i;
}

/** Index of the sample closest in time to `tMs`; -1 for an empty array. */
export function nearestSampleIndex(samples: ChannelSample[], tMs: number): number {
  if (samples.length === 0) return -1;
  const i = Math.min(sampleLowerBound(samples, tMs), samples.length - 1);
  return i > 0 && Math.abs(samples[i - 1].timestamp - tMs) < Math.abs(samples[i].timestamp - tMs) ? i - 1 : i;
}

/** Samples with startMs <= timestamp <= endMs, found by bisection instead of
 *  testing every sample. */
export function samplesInRange(samples: ChannelSample[], startMs: number, endMs: number): ChannelSample[] {
  return samples.slice(sampleLowerBound(samples, startMs), sampleUpperBound(samples, endMs));
}
