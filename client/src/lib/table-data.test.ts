import { describe, expect, it } from 'vitest';
import { buildTableData, findRowByTimestamp } from './table-data';

const s = (timestamp: number, value: number) => ({ timestamp, value });

describe('buildTableData', () => {
  it('returns nothing without channels or samples', () => {
    expect(buildTableData([], new Map())).toEqual([]);
    expect(buildTableData([1], new Map([[1, []]]))).toEqual([]);
  });

  it('uses the densest channel as the timeline and holds slower channels', () => {
    const fast = [s(0, 1), s(10, 2), s(20, 3), s(30, 4)];
    const slow = [s(0, 100), s(20, 200)];
    const rows = buildTableData([1, 2], new Map([[1, fast], [2, slow]]));

    expect(rows.map(r => r.timestamp)).toEqual([0, 10, 20, 30]);
    expect(rows.map(r => r.values[0])).toEqual([1, 2, 3, 4]);
    expect(rows.map(r => r.values[1])).toEqual([100, 100, 200, 200]);
    expect(rows.map(r => r.held[1])).toEqual([false, true, false, true]);
    expect(rows.every(r => r.held[0] === false)).toBe(true);
  });

  it('leaves a channel null until its first sample arrives', () => {
    const fast = [s(0, 1), s(10, 2), s(20, 3)];
    const late = [s(15, 9)];
    const rows = buildTableData([1, 2], new Map([[1, fast], [2, late]]));
    expect(rows.map(r => r.values[1])).toEqual([null, null, 9]);
  });

  it('reports channels with no data as null columns', () => {
    const rows = buildTableData([1, 2], new Map([[1, [s(0, 1), s(1, 2)]]]));
    expect(rows.map(r => r.values[1])).toEqual([null, null]);
  });
});

describe('findRowByTimestamp', () => {
  const rows = [0, 100, 200, 300].map(timestamp => ({ timestamp, values: [], held: [] }));
  it('finds the closest row', () => {
    expect(findRowByTimestamp(rows, 90)).toBe(1);
    expect(findRowByTimestamp(rows, 149)).toBe(1);
    expect(findRowByTimestamp(rows, 151)).toBe(2);
    expect(findRowByTimestamp(rows, -50)).toBe(0);
    expect(findRowByTimestamp(rows, 9999)).toBe(3);
  });
  it('handles empty tables', () => {
    expect(findRowByTimestamp([], 5)).toBe(0);
  });
});
