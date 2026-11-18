import { describe, expect, it } from 'vitest';
import {
  lowerBound, nearestIndex, nearestSampleIndex, sampleLowerBound, sampleUpperBound, upperBound,
} from './binary-search';

const times = [0, 10, 10, 20, 30];
const samples = times.map(t => ({ timestamp: t, value: t }));

describe('binary search', () => {
  it('lowerBound is the first index >= the target', () => {
    expect([-5, 0, 5, 10, 25, 30, 99].map(v => lowerBound(times, v))).toEqual([0, 0, 1, 1, 4, 4, 5]);
  });

  it('upperBound is the first index > the target', () => {
    expect([-5, 0, 10, 25, 30].map(v => upperBound(times, v))).toEqual([0, 1, 3, 4, 5]);
  });

  it('the sample versions agree with the number versions', () => {
    for (const v of [-5, 0, 5, 10, 15, 20, 30, 99]) {
      expect(sampleLowerBound(samples, v)).toBe(lowerBound(times, v));
      expect(sampleUpperBound(samples, v)).toBe(upperBound(times, v));
    }
  });

  it('nearestIndex picks the closer neighbour, the earlier one on a tie, and clamps', () => {
    expect([-5, 4, 5, 6, 26, 99].map(v => nearestIndex(times, v))).toEqual([0, 0, 1, 1, 4, 4]);
    expect(nearestIndex([], 5)).toBe(0);
  });

  it('nearestSampleIndex is -1 only for an empty array', () => {
    expect(nearestSampleIndex([], 5)).toBe(-1);
    expect([-5, 14, 16, 99].map(v => nearestSampleIndex(samples, v))).toEqual([0, 2, 3, 4]);
  });
});
