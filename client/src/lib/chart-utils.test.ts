import { describe, expect, it } from 'vitest';
import {
  brightenColor,
  clamp,
  contrastText,
  formatTimeSec,
  formatValue,
  interpolateValue,
  minMaxTrace,
  scanSeries,
  visibleSampleRange,
  nearestSample,
  niceAxisTicks,
  placeLabelBox,
  scaledFont,
  layoutLegendRows,
  thinLabels,
  chooseLabelBox,
  visibleMinMax,
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
    // At a duplicated timestamp, the first sample there wins.
    expect(interpolateValue([s(0, 1), s(100, 2), s(100, 3), s(200, 4)], 100)).toBe(2);
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

  it('formatTimeSec never shows negative zero', () => {
    expect(formatTimeSec(-0.0001)).toBe('0.0s');
    expect(formatTimeSec(-0.0004, 0.01)).toBe('0.000s');
    expect(formatTimeSec(-0.5)).toBe('-0.5s');
  });
});

describe('brightenColor', () => {
  it('moves toward white and stays a valid hex', () => {
    expect(brightenColor('#000000', 0)).toBe('#000000');
    expect(brightenColor('#000000', 1)).toBe('#ffffff');
  });

  it('expands shorthand #rgb before brightening', () => {
    expect(brightenColor('#fff', 0)).toBe('#ffffff');
    expect(brightenColor('#000', 0.5)).toBe('#808080');
    expect(brightenColor('#f00', 0)).toBe('#ff0000');
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

describe('visibleMinMax', () => {
  // 0..10 s, one sample every 10 ms, value rising with time
  const ramp = Array.from({ length: 1001 }, (_, i) => ({ timestamp: i * 10, value: i }));

  it('finds min and max inside the window only', () => {
    const mm = visibleMinMax(ramp, 2000, 3000)!;
    expect(mm.min.timestamp).toBe(2000);
    expect(mm.max.timestamp).toBe(3000);
  });

  it('returns null when no sample is in the window', () => {
    expect(visibleMinMax(ramp, 20000, 30000)).toBeNull();
    expect(visibleMinMax([], 0, 1000)).toBeNull();
  });

  it('skips non-finite values', () => {
    const s = [{ timestamp: 0, value: NaN }, { timestamp: 10, value: 5 }, { timestamp: 20, value: 2 }];
    const mm = visibleMinMax(s, 0, 20)!;
    expect(mm.min.value).toBe(2);
    expect(mm.max.value).toBe(5);
  });
});

describe('placeLabelBox', () => {
  const bounds = { left: 0, right: 1000, top: 0, bottom: 100 };

  it('flips to the left of the point near the right edge', () => {
    expect(placeLabelBox(990, 50, 60, 16, bounds).x).toBe(990 - 6 - 60);
  });

  it('sits right of the point and keeps y inside the bounds', () => {
    const p = placeLabelBox(10, 5, 60, 16, bounds);
    expect(p.x).toBe(16);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(placeLabelBox(10, 99, 60, 16, bounds).y).toBe(100 - 16);
  });
});

describe('contrastText', () => {
  it('uses black on light fills and white on dark fills', () => {
    expect(contrastText('#facc15')).toBe('#000');
    expect(contrastText('#4361ee')).toBe('#fff');
  });
});

describe('scaledFont', () => {
  it('scales and rounds the pixel size', () => {
    expect(scaledFont(10, 1.5)).toBe('15px JetBrains Mono, monospace');
    expect(scaledFont(9, 1.2, 'bold')).toBe('bold 11px JetBrains Mono, monospace');
  });
});

describe('layoutLegendRows', () => {
  it('wraps entries onto new rows instead of running past the width', () => {
    expect(layoutLegendRows([100, 100, 100], 250, 10)).toEqual([
      { row: 0, x: 0 }, { row: 0, x: 110 }, { row: 1, x: 0 },
    ]);
  });

  it('keeps an entry wider than the row on a row of its own', () => {
    expect(layoutLegendRows([50, 400, 50], 250, 10)).toEqual([
      { row: 0, x: 0 }, { row: 1, x: 0 }, { row: 2, x: 0 },
    ]);
  });
});

describe('thinLabels', () => {
  it('skips labels that would overlap the previous one shown', () => {
    // centred labels 20 px wide at x = 0, 15, 40, 45, 100
    expect(thinLabels([0, 15, 40, 45, 100], [20, 20, 20, 20, 20], 4)).toEqual([true, false, true, false, true]);
  });
});

describe('chooseLabelBox', () => {
  const bounds = { left: 0, right: 1000, top: 0, bottom: 200 };

  it('prefers above-right of a max point when nothing is in the way', () => {
    const p = chooseLabelBox(500, 100, 60, 16, bounds, 'above', [], []);
    expect(p.x).toBeGreaterThan(500);
    expect(p.y + 16).toBeLessThanOrEqual(100);
  });

  it('moves to a spot that no trace runs through', () => {
    // A horizontal trace just above the point, across the whole width.
    const xs = Array.from({ length: 1001 }, (_, i) => i);
    const trace = { xs, ys: xs.map(() => 90) };
    const p = chooseLabelBox(500, 100, 60, 16, bounds, 'above', [trace], []);
    const hits = xs.filter(x => x >= p.x && x <= p.x + 60 && 90 >= p.y && 90 <= p.y + 16);
    expect(hits).toHaveLength(0);
  });

  it('avoids boxes already placed', () => {
    const first = chooseLabelBox(500, 100, 60, 16, bounds, 'above', [], []);
    const second = chooseLabelBox(500, 100, 60, 16, bounds, 'above', [], [{ x: first.x, y: first.y, w: 60, h: 16 }]);
    const overlap = second.x < first.x + 60 && second.x + 60 > first.x && second.y < first.y + 16 && second.y + 16 > first.y;
    expect(overlap).toBe(false);
  });

  it('stays inside the bounds near a corner', () => {
    const p = chooseLabelBox(995, 198, 60, 16, bounds, 'below', [], []);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + 60).toBeLessThanOrEqual(1000);
    expect(p.y + 16).toBeLessThanOrEqual(200);
  });
});


describe('visibleSampleRange', () => {
  const ramp = Array.from({ length: 101 }, (_, i) => ({ timestamp: i * 100, value: i })); // 0..10 s

  it('covers the window plus one neighbour on each side, without copying', () => {
    const [start, end] = visibleSampleRange(ramp, [2, 3]);
    expect(ramp[start].timestamp).toBeLessThan(2000);
    expect(ramp[end - 1].timestamp).toBeGreaterThan(3000);
    expect(end - start).toBeLessThan(20);
  });

  it('is the whole array when zoomed all the way out, and empty for no samples', () => {
    expect(visibleSampleRange(ramp, [0, 10])).toEqual([0, ramp.length]);
    expect(visibleSampleRange([], [0, 10])).toEqual([0, 0]);
  });
});

describe('scanSeries', () => {
  const wave = Array.from({ length: 20_000 }, (_, i) => ({ timestamp: i, value: Math.sin(i / 50) * (i % 7 === 0 ? NaN : 1) }));
  const timeToX = (t: number) => (t / 20) * 500;

  it('gives the same trace and min/max as the separate helpers, in one walk', () => {
    const scan = scanSeries(wave, 0, wave.length, timeToX, 500, 2000, 9000);
    expect(scan.trace).toEqual(minMaxTrace(wave, timeToX, 500));
    expect(scan.minMax).toEqual(visibleMinMax(wave, 2000, 9000));
    const finite = wave.map(s => s.value).filter(Number.isFinite);
    expect(scan.valueRange).toEqual([Math.min(...finite), Math.max(...finite)]);
  });

  it('only looks at the index range it is given', () => {
    const sparse = wave.slice(0, 50);
    const scan = scanSeries(sparse, 10, 20, timeToX, 500, 0, 1e9);
    expect(scan.trace).toEqual(sparse.slice(10, 20));
    expect(scan.minMax!.min.timestamp).toBeGreaterThanOrEqual(10);
    expect(scan.minMax!.max.timestamp).toBeLessThan(20);
  });

  it('hands back the array itself when nothing needs reducing', () => {
    const few = wave.slice(0, 10);
    expect(scanSeries(few, 0, few.length, timeToX, 500, 0, 1e9).trace).toBe(few);
    expect(scanSeries([], 0, 0, timeToX, 500, 0, 1e9)).toEqual({ trace: [], valueRange: [Infinity, -Infinity], minMax: null });
  });
});
