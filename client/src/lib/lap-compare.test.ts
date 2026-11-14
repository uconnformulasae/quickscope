import { describe, expect, it } from 'vitest';
import { buildLapWindows, lapColor, LAP_COMPARE_PALETTE, segmentInLaps, selectedWindows, shiftToLap, toSessionMs } from './lap-compare';

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

describe('selectedWindows', () => {
  it('returns the selected laps in selection order', () => {
    const w = buildLapWindows(markers);
    expect(selectedWindows(w, [1, 0]).map(l => l.lapNumber)).toEqual([2, 1]);
  });

  it('ignores indices that are not laps', () => {
    expect(selectedWindows(buildLapWindows(markers), [0, 9]).map(l => l.index)).toEqual([0]);
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

describe('segmentInLaps', () => {
  const lap2 = buildLapWindows(markers)[1]; // 60000..125000
  it('is true inside a selected lap and false outside', () => {
    expect(segmentInLaps(70000, [lap2])).toBe(true);
    expect(segmentInLaps(10, [lap2])).toBe(false);
  });
  it('treats no selection as everything highlighted', () => {
    expect(segmentInLaps(10, [])).toBe(true);
  });
});
