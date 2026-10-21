// Unit conversion for live tiles. Each family lists its units as
// [unit, a, b] with base = value * a + b, the base being the unit the AiM
// sends for that kind of channel (see _QUANTITY_UNITS in aim_live_layout.py).
type UnitDef = readonly [unit: string, a: number, b: number];

const FAMILIES: readonly (readonly UnitDef[])[] = [
  [['°C', 1, 0], ['°F', 5 / 9, -160 / 9]],
  [['bar', 1, 0], ['psi', 0.0689476, 0], ['kPa', 0.01, 0]],
  [['km/h', 1, 0], ['mph', 1.609344, 0]],
  [['V', 1, 0], ['mV', 0.001, 0]],
  [['g', 1, 0], ['m/s²', 1 / 9.80665, 0]],
  [['°', 1, 0], ['rad', 180 / Math.PI, 0]],
  [['°/s', 1, 0], ['rad/s', 180 / Math.PI, 0]],
  [['Nm', 1, 0], ['lb·ft', 1.3558179, 0]],
  [['ms', 1, 0], ['s', 1000, 0]],
];

const BY_UNIT = new Map<string, { family: readonly UnitDef[]; def: UnitDef }>(
  FAMILIES.flatMap((family) => family.map((def) => [def[0], { family, def }] as const)),
);

/** `value` in `from` expressed in `to`; undefined when the two aren't the same kind of unit. */
export function convertUnit(value: number, from: string, to: string): number | undefined {
  if (from === to) return value;
  const src = BY_UNIT.get(from);
  const dst = BY_UNIT.get(to);
  if (!src || !dst || src.family !== dst.family) return undefined;
  const base = value * src.def[1] + src.def[2];
  return (base - dst.def[2]) / dst.def[1];
}

/** Units a channel sent in `unit` can be shown in, `unit` first; empty when there's no alternative. */
export function compatibleUnits(unit: string): string[] {
  const entry = BY_UNIT.get(unit);
  if (!entry) return [];
  return [unit, ...entry.family.map((d) => d[0]).filter((u) => u !== unit)];
}
