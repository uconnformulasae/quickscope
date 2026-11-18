// Unit conversion for live tiles. The units and factors are the shared table
// in lib/units.ts; a tile matches a unit by its exact label, the way the AiM
// sends it (see _QUANTITY_UNITS in aim_live_layout.py).
import { liveUnitFamily, unitCoefficients } from '../../lib/units';

/** `value` in `from` expressed in `to`; undefined when the two aren't the same kind of unit. */
export function convertUnit(value: number, from: string, to: string): number | undefined {
  if (from === to) return value;
  if (liveUnitFamily(from).length === 0 || !liveUnitFamily(from).includes(to)) return undefined;
  const c = unitCoefficients(from, to)!;
  return value * c.scale + c.offset;
}

/** Units a channel sent in `unit` can be shown in, `unit` first; empty when there's no alternative. */
export function compatibleUnits(unit: string): string[] {
  const family = liveUnitFamily(unit);
  if (family.length === 0) return [];
  return [unit, ...family.filter((u) => u !== unit)];
}

/**
 * Units a tile steps through when clicked, `home` (the layout's unit) first; empty
 * when there's nothing to switch to. A `home` that's only a label stays in the cycle
 * so clicking can always get back to it.
 */
export function unitCycle(sourceUnit: string | undefined, home: string): string[] {
  const family = sourceUnit ? compatibleUnits(sourceUnit) : [];
  if (family.length === 0) return [];
  const at = family.indexOf(home);
  return at < 0 ? [home, ...family] : [...family.slice(at), ...family.slice(0, at)];
}

/** The unit after `current` in `cycle`, wrapping; a `current` not in it counts as the first. */
export function nextUnit(cycle: string[], current: string): string {
  return cycle[(Math.max(0, cycle.indexOf(current)) + 1) % cycle.length];
}
