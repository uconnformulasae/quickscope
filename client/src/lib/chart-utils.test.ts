import { describe, expect, it } from 'vitest';
import {
  brightenColor,
  clamp,
  formatTimeSec,
  formatValue,
  interpolateValue,
  minMaxTrace,
  nearestSample,
  niceAxisTicks,
} from './chart-utils';

const s = (timestamp: number, value: number) => ({ timestamp, value });
const samples = [s(0, 0), s(100, 10), s(200, 30)];

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('interpolateValue', () => {
  it('lerps between bracketing samples', () => {
    expect(interpolateValue(samples, 50)).toBe(5);
    expect(interpolateValue(samples, 150)).toBe(20);
  });
  it('hits exact samples and clamps outside the range', () => {
    expect(interpolateValue(samples, 100)).toBe(10);
    expect(interpolateValue(samples, -10)).toBe(0);
    expect(interpolateValue(samples, 999)).toBe(30);
  });
  it('handles empty input and duplicate timestamps', () => {
    expect(interpolateValue([], 5)).toBeNull();
    expect(interpolateValue([s(0, 1), s(100, 2), s(100, 3), s(200, 4)], 100)).toBeDefined();
  });
});

describe('nearestSample', () => {
  it('snaps to the closest real sample', () => {
    expect(nearestSample(samples, 40)).toEqual(s(0, 0));
    expect(nearestSample(samples, 60)).toEqual(s(100, 10));
    expect(nearestSample(samples, 5000)).toEqual(s(200, 30));
    expect(nearestSample(samples, -5)).toEqual(s(0, 0));
  });
  it('returns null for no samples', () => {
    expect(nearestSample([], 1)).toBeNull();
  });
});

describe('niceAxisTicks', () => {
  it('produces round, ascending ticks inside the range', () => {
    const ticks = niceAxisTicks(0, 100, 5);
    expect(ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });
  it('handles offset and fractional ranges', () => {
    const ticks = niceAxisTicks(0.13, 0.87, 5);
    expect(ticks[0]).toBeGreaterThanOrEqual(0.13);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(0.87 + 1e-9);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });
  it('degenerate ranges return a single tick', () => {
    expect(niceAxisTicks(5, 5, 5)).toEqual([5]);
    expect(niceAxisTicks(0, Infinity, 5)).toEqual([0]);
  });
});

describe('formatting', () => {
  it.each([
    [0, '0'],
    [12345.6, '12346'],
    [123.456, '123.5'],
    [1.2345, '1.23'],
    [0.12345, '0.123'],
    [-250.04, '-250.0'],
  ])('formatValue(%s) = %s', (v, out) => {
    expect(formatValue(v)).toBe(out);
  });

  it('formatTimeSec uses minutes past 60 s and adapts precision', () => {
    expect(formatTimeSec(5)).toBe('5.0s');
    expect(formatTimeSec(5.123, 0.01)).toBe('5.123s');
    expect(formatTimeSec(75.5)).toBe('1:15.5');
    expect(formatTimeSec(605, 1)).toBe('10:05.0');
  });
});

describe('brightenColor', () => {
  it('moves toward white and stays a valid hex', () => {
    expect(brightenColor('#000000', 0)).toBe('#000000');
    expect(brightenColor('#000000', 1)).toBe('#ffffff');
    expect(brightenColor('#ff0000', 0.5)).toBe('#ff8080');
  });
});

describe('minMaxTrace', () => {
  const dense = Array.from({ length: 20_000 }, (_, i) => s(i, Math.sin(i / 50)));

  it('returns the input untouched when already sparse', () => {
    expect(minMaxTrace(samples, t => t, 1000)).toBe(samples);
  });

  it('reduces dense data but keeps extremes and ordering', () => {
    const plotW = 100;
    const out = minMaxTrace(dense, t => (t / 20) * plotW, plotW);
    expect(out.length).toBeLessThan(dense.length);
    expect(Math.max(...out.map(p => p.value))).toBe(Math.max(...dense.map(p => p.value)));
    expect(Math.min(...out.map(p => p.value))).toBe(Math.min(...dense.map(p => p.value)));
    const times = out.map(p => p.timestamp);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
