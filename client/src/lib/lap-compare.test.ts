import { describe, expect, it } from 'vitest';
import { buildLapWindows, lapColor, LAP_COMPARE_PALETTE, lapRelativeRange, shiftToLap, toSessionMs } from './lap-compare';

const markers = [
  { timestamp: 0, lapNumber: 1 },
  { timestamp: 60000, lapNumber: 2 },
  { timestamp: 125000, lapNumber: 3 },
];

describe('buildLapWindows', () => {
  it('pairs consecutive markers into laps', () => {
    const w = buildLapWindows(markers);
    expect(w).toHaveLength(2);
    expect(w[1]).toEqual({ index: 1, lapNumber: 2, startMs: 60000, endMs: 125000, durationMs: 65000 });
  });

  it('has no laps with fewer than two markers', () => {
    expect(buildLapWindows([markers[0]])).toEqual([]);
  });
});

describe('lapRelativeRange', () => {
  it('spans 0 to the longest selected lap, in seconds', () => {
    const w = buildLapWindows(markers);
    expect(lapRelativeRange(w, [0, 1])).toEqual([0, 65]);
    expect(lapRelativeRange(w, [0])).toEqual([0, 60]);
  });

  it('ignores indices that are not laps', () => {
    expect(lapRelativeRange(buildLapWindows(markers), [0, 9])).toEqual([0, 60]);
  });
});

describe('lapColor', () => {
  it('cycles through the palette', () => {
    expect(lapColor(0)).toBe(LAP_COMPARE_PALETTE[0]);
    expect(lapColor(LAP_COMPARE_PALETTE.length + 1)).toBe(LAP_COMPARE_PALETTE[1]);
  });
});

describe('toSessionMs', () => {
  it('maps lap-relative seconds back to session ms', () => {
    expect(toSessionMs(5, buildLapWindows(markers)[1])).toBe(65000);
  });
});

describe('shiftToLap', () => {
  it('keeps only the lap\'s samples, re-timed from 0', () => {
    const samples = [0, 30000, 60000, 90000, 125000, 130000].map((t, i) => ({ timestamp: t, value: i }));
    expect(shiftToLap(samples, buildLapWindows(markers)[1])).toEqual([
      { timestamp: 0, value: 2 },
      { timestamp: 30000, value: 3 },
      { timestamp: 65000, value: 4 },
    ]);
  });
});
