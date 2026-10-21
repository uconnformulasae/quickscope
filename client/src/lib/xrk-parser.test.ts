import { describe, expect, it } from 'vitest';
import { computeStats, formatLapTime, formatTime } from './xrk-parser';

const s = (timestamp: number, value: number) => ({ timestamp, value });

describe('computeStats', () => {
  it('returns zeros for an empty channel', () => {
    expect(computeStats([])).toEqual({
      min: 0, max: 0, mean: 0, stdDev: 0, count: 0, minTimestamp: 0, maxTimestamp: 0,
    });
  });

  it('computes min/max with their timestamps, mean and sample std dev', () => {
    const stats = computeStats([s(0, 2), s(10, 4), s(20, 4), s(30, 4), s(40, 5), s(50, 5), s(60, 7), s(70, 9)]);
    expect(stats.min).toBe(2);
    expect(stats.minTimestamp).toBe(0);
    expect(stats.max).toBe(9);
    expect(stats.maxTimestamp).toBe(70);
    expect(stats.mean).toBe(5);
    expect(stats.count).toBe(8);
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('skips NaN and infinite values', () => {
    const stats = computeStats([s(0, NaN), s(10, 1), s(20, Infinity), s(30, 3)]);
    expect(stats.count).toBe(2);
    expect(stats.mean).toBe(2);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(3);
  });

  it('returns zeros when every value is non-finite', () => {
    expect(computeStats([s(0, NaN), s(1, -Infinity)]).count).toBe(0);
  });

  it('uses a divisor of 1 for a single sample', () => {
    const stats = computeStats([s(5, 42)]);
    expect(stats.stdDev).toBe(0);
    expect(stats.minTimestamp).toBe(5);
    expect(stats.maxTimestamp).toBe(5);
  });
});

describe('formatTime', () => {
  it('formats mm:ss.mmm', () => {
    expect(formatTime(0)).toBe('00:00.000');
    expect(formatTime(61_234)).toBe('01:01.234');
    expect(formatTime(600_000)).toBe('10:00.000');
  });

  it('rounds to the nearest millisecond', () => {
    expect(formatTime(999.6)).toBe('00:01.000');
  });

  it('prefixes negative times', () => {
    expect(formatTime(-1500)).toBe('-00:01.500');
  });
});

describe('formatLapTime', () => {
  it('formats m:ss.mmm', () => {
    expect(formatLapTime(65.432)).toBe('1:05.432');
    expect(formatLapTime(9.5)).toBe('0:09.500');
  });

  it('carries rounding into the minute', () => {
    expect(formatLapTime(59.9996)).toBe('1:00.000');
  });

  it('prefixes negative deltas', () => {
    expect(formatLapTime(-1.25)).toBe('-0:01.250');
  });
});
