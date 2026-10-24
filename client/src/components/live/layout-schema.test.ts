import { describe, expect, it } from 'vitest';
import { extractChannelNames } from '../../lib/formula-engine';
import { BUILTIN_LAYOUTS, EV_DEFAULT_LAYOUT, IC_DEFAULT_LAYOUT } from './default-layouts';
import {
  BUILTIN_ID,
  EMPTY_SELECTION,
  cloneLayout,
  layoutForConnect,
  layoutForOffline,
  otherChannelEntries,
  selectionAfterPick,
  usedChannels,
  validateLayout,
  type LayoutSelection,
} from './layout-schema';

const base = {
  id: 'layout-1',
  name: 'Driver',
  vehicle: 'ev',
  version: 1,
  grid: [{ i: 'w1', x: 0, y: 0, w: 6, h: 4 }],
  widgets: [{ id: 'w1', type: 'stats', title: 'Pack', channels: [{ name: 'Pack_Voltage', precision: 1 }] }],
};

describe('validateLayout', () => {
  it('accepts a well-formed layout', () => {
    const { layout, warnings } = validateLayout(base);
    expect(warnings).toEqual([]);
    expect(layout.widgets[0].channels).toEqual([{ name: 'Pack_Voltage', precision: 1 }]);
    expect(layout.grid).toEqual(base.grid);
  });

  it('rejects structurally unusable input', () => {
    expect(() => validateLayout(null)).toThrow(/JSON object/);
    expect(() => validateLayout({ ...base, id: '' })).toThrow(/id/);
    expect(() => validateLayout({ ...base, vehicle: 'hybrid' })).toThrow(/vehicle/);
    expect(() => validateLayout({ ...base, widgets: 'x' })).toThrow(/widgets/);
  });

  it('drops unknown widget types with a warning instead of failing', () => {
    const { layout, warnings } = validateLayout({
      ...base,
      widgets: [...base.widgets, { id: 'w2', type: 'hologram', title: 'Future' }],
      grid: [...base.grid, { i: 'w2', x: 6, y: 0, w: 6, h: 4 }],
    });
    expect(layout.widgets.map((w) => w.id)).toEqual(['w1']);
    expect(layout.grid.map((g) => g.i)).toEqual(['w1']);
    expect(warnings[0]).toMatch(/hologram/);
  });

  it('clamps grid items and places widgets that have no position', () => {
    const { layout } = validateLayout({
      ...base,
      grid: [{ i: 'w1', x: 20, y: -3, w: 40, h: 0 }],
      widgets: [...base.widgets, { id: 'w2', type: 'note', title: 'Note' }],
    });
    expect(layout.grid[0]).toEqual({ i: 'w1', x: 0, y: 0, w: 12, h: 1 });
    expect(layout.grid[1]).toMatchObject({ i: 'w2', x: 0, y: 1 });
  });

  it('cleans channel refs (strings, junk fields, empty entries)', () => {
    const { layout } = validateLayout({
      ...base,
      widgets: [{ id: 'w1', type: 'stats', title: 'x', channels: ['RPM', '', { name: 'A', precision: 'two', kind: 'nope' }, { expr: 'A*2' }] }],
    });
    expect(layout.widgets[0].channels).toEqual([{ name: 'RPM' }, { name: 'A' }, { name: '', expr: 'A*2' }]);
  });

  it('round-trips every built-in layout unchanged', () => {
    for (const builtin of BUILTIN_LAYOUTS) {
      const { layout, warnings } = validateLayout(JSON.parse(JSON.stringify(builtin)));
      expect(warnings).toEqual([]);
      expect(layout.widgets).toEqual(builtin.widgets);
      expect(layout.grid).toEqual(builtin.grid);
    }
  });
});

describe('other channels', () => {
  it('lists live channels no widget uses, including names inside formulas', () => {
    const used = usedChannels(EV_DEFAULT_LAYOUT, extractChannelNames);
    expect(used.has('Pack_Voltage')).toBe(true);
    expect(used.has('RTD_Fault')).toBe(true);
    const others = otherChannelEntries({ Pack_Voltage: 400, Zeta: 1, Alpha: 2 }, used);
    expect(others).toEqual([['Alpha', 2], ['Zeta', 1]]);
  });

  it('IC layout claims its thermocouples and ECU block', () => {
    const used = usedChannels(IC_DEFAULT_LAYOUT, extractChannelNames);
    for (const n of ['0TC01', 'S8_RPM', 'S8_fp1', 'LF_BRKTempCH4', 'External Voltage']) expect(used.has(n)).toBe(true);
  });
});

describe('cloneLayout', () => {
  it('gives the layout and every widget new ids and keeps grid links intact', () => {
    const copy = cloneLayout(EV_DEFAULT_LAYOUT, { name: 'Mine' });
    expect(copy.id).not.toBe(EV_DEFAULT_LAYOUT.id);
    expect(copy.builtIn).toBeUndefined();
    expect(copy.name).toBe('Mine');
    const widgetIds = new Set(copy.widgets.map((w) => w.id));
    expect(EV_DEFAULT_LAYOUT.widgets.some((w) => widgetIds.has(w.id))).toBe(false);
    expect(copy.grid.every((g) => widgetIds.has(g.i))).toBe(true);
    expect(copy.grid.length).toBe(EV_DEFAULT_LAYOUT.grid.length);
  });
});

describe('layout selection rules', () => {
  const ids = new Set([BUILTIN_ID.ev, BUILTIN_ID.ic, 'mine-ev', 'mine-ic']);
  const sel = (s: Partial<LayoutSelection>): LayoutSelection => ({ ...EMPTY_SELECTION, ...s });

  it('offline: last used, falling back to the EV built-in', () => {
    expect(layoutForOffline(ids, sel({}))).toBe(BUILTIN_ID.ev);
    expect(layoutForOffline(ids, sel({ last_used: 'mine-ic' }))).toBe('mine-ic');
    expect(layoutForOffline(ids, sel({ last_used: 'deleted' }))).toBe(BUILTIN_ID.ev);
  });

  it('connect without a pin: that car\'s last-used layout, else its built-in', () => {
    expect(layoutForConnect(ids, sel({ active: { ic: 'mine-ic' } }), 'ic')).toBe('mine-ic');
    expect(layoutForConnect(ids, sel({ active: { ic: 'mine-ic' } }), 'ev')).toBe(BUILTIN_ID.ev);
    expect(layoutForConnect(ids, sel({ active: { ev: 'deleted' } }), 'ev')).toBe(BUILTIN_ID.ev);
  });

  it('connect with a pin keeps the pinned layout, even for the other car', () => {
    expect(layoutForConnect(ids, sel({ pinned: 'mine-ic', active: { ev: 'mine-ev' } }), 'ev')).toBe('mine-ic');
  });

  it('picking a layout records it for its car and moves an existing pin', () => {
    expect(selectionAfterPick(sel({ active: { ic: 'mine-ic' } }), { id: 'mine-ev', vehicle: 'ev' })).toEqual({
      active: { ic: 'mine-ic', ev: 'mine-ev' },
      pinned: null,
      last_used: 'mine-ev',
    });
    expect(selectionAfterPick(sel({ pinned: 'mine-ic' }), { id: 'mine-ev', vehicle: 'ev' }).pinned).toBe('mine-ev');
  });
});
