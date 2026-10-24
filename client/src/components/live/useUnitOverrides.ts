import { useCallback, useState } from 'react';
import { nextUnit } from './units';

/** Unit chosen by clicking a value, keyed by `overrideKey`. Absent = the layout's unit. */
export type UnitOverrides = Record<string, string>;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY = 'quickscope.liveUnits';

/** One entry per value on screen, so the same channel in two widgets is independent. */
export function overrideKey(layoutId: string, widgetId: string, channel: string): string {
  return `${layoutId}:${widgetId}:${channel}`;
}

/**
 * `map` with `key` advanced one step through `cycle` (home first). Landing back on the
 * home unit drops the entry; a stored unit that's no longer in the cycle restarts it.
 */
export function cycleOverride(map: UnitOverrides, key: string, cycle: string[]): UnitOverrides {
  if (cycle.length < 2) return map;
  const next = nextUnit(cycle, map[key] ?? cycle[0]);
  const rest = { ...map };
  delete rest[key];
  return next === cycle[0] ? rest : { ...rest, [key]: next };
}

export function loadOverrides(storage: Storage | undefined = globalThis.localStorage): UnitOverrides {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

export function saveOverrides(map: UnitOverrides, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Private window / blocked storage: the choice just won't outlive the page.
  }
}

/** Per-viewer unit choices for live values, remembered in this browser. */
export function useUnitOverrides() {
  const [overrides, setOverrides] = useState<UnitOverrides>(() => loadOverrides());
  const cycle = useCallback((key: string, units: string[]) => {
    setOverrides((map) => {
      const next = cycleOverride(map, key, units);
      if (next !== map) saveOverrides(next);
      return next;
    });
  }, []);
  return { overrides, cycle };
}
