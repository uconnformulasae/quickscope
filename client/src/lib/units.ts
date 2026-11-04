/**
 * Display-unit conversion. Raw samples keep the logger's units; views convert
 * values on the way to the screen (see useDisplaySamples).
 */
import type { UnitSystem } from './usePreferences';

type Dimension = 'speed' | 'temperature' | 'pressure' | 'length' | 'torque' | 'volume' | 'mass';

/** Canonical unit → dimension and affine transform to the dimension's base unit
 *  (base = value * scale + offset). */
const UNITS: Record<string, { dim: Dimension; scale: number; offset?: number }> = {
  'km/h': { dim: 'speed', scale: 1 },
  'mph': { dim: 'speed', scale: 1.609344 },
  'm/s': { dim: 'speed', scale: 3.6 },
  '°C': { dim: 'temperature', scale: 1 },
  '°F': { dim: 'temperature', scale: 5 / 9, offset: -32 * 5 / 9 },
  'bar': { dim: 'pressure', scale: 1 },
  'kPa': { dim: 'pressure', scale: 0.01 },
  'psi': { dim: 'pressure', scale: 0.0689475729 },
  'm': { dim: 'length', scale: 1 },
  'km': { dim: 'length', scale: 1000 },
  'ft': { dim: 'length', scale: 0.3048 },
  'mi': { dim: 'length', scale: 1609.344 },
  'Nm': { dim: 'torque', scale: 1 },
  'lb·ft': { dim: 'torque', scale: 1.3558179483 },
  'L': { dim: 'volume', scale: 1 },
  'gal': { dim: 'volume', scale: 3.785411784 },
  'kg': { dim: 'mass', scale: 1 },
  'lb': { dim: 'mass', scale: 0.45359237 },
};

/** Lower-cased, space-stripped spelling → canonical label. */
const ALIASES: Record<string, string> = {
  'km/h': 'km/h', 'kph': 'km/h', 'kmh': 'km/h', 'km/hr': 'km/h',
  'mph': 'mph', 'mi/h': 'mph',
  'm/s': 'm/s', 'mps': 'm/s',
  '°c': '°C', 'c': '°C', 'degc': '°C', 'deg c': '°C', '°f': '°F', 'f': '°F', 'degf': '°F',
  'bar': 'bar', 'kpa': 'kPa', 'psi': 'psi',
  'm': 'm', 'km': 'km', 'ft': 'ft', 'mi': 'mi',
  'nm': 'Nm', 'n·m': 'Nm', 'n-m': 'Nm',
  'lb·ft': 'lb·ft', 'lbft': 'lb·ft', 'lb-ft': 'lb·ft', 'ft-lb': 'lb·ft', 'ft·lb': 'lb·ft',
  'l': 'L', 'gal': 'gal', 'kg': 'kg', 'lb': 'lb', 'lbs': 'lb',
};

const TO_IMPERIAL: Record<string, string> = {
  'km/h': 'mph', 'm/s': 'mph', '°C': '°F', 'bar': 'psi', 'kPa': 'psi',
  'm': 'ft', 'km': 'mi', 'Nm': 'lb·ft', 'L': 'gal', 'kg': 'lb',
};
const TO_METRIC: Record<string, string> = {
  'mph': 'km/h', '°F': '°C', 'psi': 'bar', 'ft': 'm', 'mi': 'km', 'lb·ft': 'Nm', 'gal': 'L', 'lb': 'kg',
};

export interface Converter {
  unit: string;
  fn: (v: number) => number;
  identity: boolean;
}

export function normalizeUnit(u: string): string | null {
  const key = u.trim().toLowerCase().replace(/\s+/g, '');
  if (!key) return null;
  return ALIASES[key] ?? ALIASES[u.trim().toLowerCase()] ?? null;
}

export function convertibleUnits(rawUnit: string): string[] {
  const canon = normalizeUnit(rawUnit);
  if (!canon) return [];
  const dim = UNITS[canon].dim;
  return Object.keys(UNITS).filter(k => UNITS[k].dim === dim);
}

const identityOf = (rawUnit: string): Converter => ({ unit: rawUnit, fn: v => v, identity: true });

export function getConverter(rawUnit: string, target: string): Converter {
  const from = normalizeUnit(rawUnit);
  const to = normalizeUnit(target);
  if (!from || !to || from === to) return identityOf(rawUnit);
  const a = UNITS[from], b = UNITS[to];
  if (a.dim !== b.dim) return identityOf(rawUnit);
  const aOff = a.offset ?? 0, bOff = b.offset ?? 0;
  return {
    unit: to,
    fn: v => ((v * a.scale + aOff) - bOff) / b.scale,
    identity: false,
  };
}

export function resolveDisplayUnit(
  shortName: string,
  rawUnit: string,
  prefs: { unitSystem: UnitSystem; unitOverrides: Record<string, string> },
): string {
  const canon = normalizeUnit(rawUnit);
  if (!canon) return rawUnit;
  const override = prefs.unitOverrides[shortName];
  if (override && convertibleUnits(rawUnit).includes(override)) return override;
  if (prefs.unitSystem === 'imperial') return TO_IMPERIAL[canon] ?? rawUnit;
  if (prefs.unitSystem === 'metric') return TO_METRIC[canon] ?? rawUnit;
  return rawUnit;
}

/** All supported conversions are affine; express one as value * scale + offset
 *  (used to hand the conversion to the backend CSV export). */
export function linearCoefficients(conv: Converter): { scale: number; offset: number } {
  const offset = conv.fn(0);
  return { scale: conv.fn(1) - offset, offset };
}
