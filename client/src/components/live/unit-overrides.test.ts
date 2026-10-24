import { describe, expect, it } from 'vitest';
import { cycleOverride, loadOverrides, saveOverrides } from './useUnitOverrides';

describe('cycleOverride', () => {
  const cycle = ['bar', 'psi', 'kPa'];

  it('stores the next unit and removes it on the way back to the layout unit', () => {
    let map = cycleOverride({}, 'k', cycle);
    expect(map).toEqual({ k: 'psi' });
    map = cycleOverride(map, 'k', cycle);
    expect(map).toEqual({ k: 'kPa' });
    map = cycleOverride(map, 'k', cycle);
    expect(map).toEqual({});
  });

  it('restarts from the layout unit when the stored unit no longer fits', () => {
    expect(cycleOverride({ k: '°F' }, 'k', cycle)).toEqual({ k: 'psi' });
  });

  it('leaves other values alone', () => {
    expect(cycleOverride({ other: '°F' }, 'k', cycle)).toEqual({ other: '°F', k: 'psi' });
  });

  it('does nothing for a value with no alternatives', () => {
    const map = { k: 'x' };
    expect(cycleOverride(map, 'k', [])).toBe(map);
  });
});

describe('loadOverrides / saveOverrides', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  };
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

  it('round-trips', () => {
    const s = memory();
    saveOverrides({ a: '°F' }, s);
    expect(loadOverrides(s)).toEqual({ a: '°F' });
  });

  it('survives blocked or garbage storage', () => {
    expect(loadOverrides(throwing)).toEqual({});
    expect(() => saveOverrides({ a: '°F' }, throwing)).not.toThrow();
    const s = memory();
    s.setItem('quickscope.liveUnits', '{nope');
    expect(loadOverrides(s)).toEqual({});
    s.setItem('quickscope.liveUnits', JSON.stringify({ a: '°F', b: 3, c: null }));
    expect(loadOverrides(s)).toEqual({ a: '°F' });
  });
});
