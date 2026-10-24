import { describe, expect, it } from 'vitest';
import { buildTableData, findRowByTimestamp, type TableData } from './table-data';

const s = (timestamp: number, value: number) => ({ timestamp, value });
const allRows = (t: TableData) => Array.from({ length: t.rowCount }, (_, i) => t.rowAt(i));

describe('buildTableData', () => {
  it('returns nothing without channels or samples', () => {
    expect(buildTableData([], new Map()).rowCount).toBe(0);
    expect(buildTableData([1], new Map([[1, []]])).rowCount).toBe(0);
  });

  it('uses the densest channel as the timeline and holds slower channels', () => {
    const fast = [s(0, 1), s(10, 2), s(20, 3), s(30, 4)];
    const slow = [s(0, 100), s(20, 200)];
    const table = buildTableData([1, 2], new Map([[1, fast], [2, slow]]));
    const rows = allRows(table);

    expect(table.timestamps).toEqual([0, 10, 20, 30]);
    expect(rows.map(r => r.timestamp)).toEqual([0, 10, 20, 30]);
    expect(rows.map(r => r.values[0])).toEqual([1, 2, 3, 4]);
    expect(rows.map(r => r.values[1])).toEqual([100, 100, 200, 200]);
    expect(rows.map(r => r.held[1])).toEqual([false, true, false, true]);
    expect(rows.every(r => r.held[0] === false)).toBe(true);
  });

  it('leaves a channel null until its first sample arrives', () => {
    const fast = [s(0, 1), s(10, 2), s(20, 3)];
    const late = [s(15, 9)];
    const rows = allRows(buildTableData([1, 2], new Map([[1, fast], [2, late]])));
    expect(rows.map(r => r.values[1])).toEqual([null, null, 9]);
    // The first row a channel appears on is fresh, not held.
    expect(rows.map(r => r.held[1])).toEqual([false, false, false]);
  });

  it('reports channels with no data as null columns', () => {
    const rows = allRows(buildTableData([1, 2], new Map([[1, [s(0, 1), s(1, 2)]]])));
    expect(rows.map(r => r.values[1])).toEqual([null, null]);
  });

  it('builds rows on demand, so any row can be read without the others', () => {
    const fast = Array.from({ length: 100_000 }, (_, i) => s(i * 10, i));
    const slow = Array.from({ length: 1_000 }, (_, i) => s(i * 1000, -i));
    const table = buildTableData([1, 2], new Map([[1, fast], [2, slow]]));
    expect(table.rowCount).toBe(100_000);
    expect(table.rowAt(54_321)).toEqual({ timestamp: 543_210, values: [54_321, -543], held: [false, true] });
    expect(table.rowAt(54_300).held).toEqual([false, false]); // slow channel's fresh sample at 543 000
  });
});

describe('findRowByTimestamp', () => {
  const rows = [0, 100, 200, 300];
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
