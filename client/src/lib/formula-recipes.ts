/**
 * Formula recipes — fill-in-the-blank starting points for derived channels.
 *
 * A recipe is shown only when the open session has every channel role it
 * `requires` (roles come from channel-dictionary.ts), so gas recipes never
 * appear on an EV log and battery recipes never appear on an IC log.
 */
import type { ChannelInfo } from './channel-dictionary';
import { formatChannelRef } from './formula-engine';
import { unitCoefficients } from './units';

export type RecipeSlot = { key: string; label: string } & (
  /** `role` may list alternatives in preference order: 'wheel_speed|gps_speed'. */
  | { kind: 'channel'; role?: string }
  | { kind: 'number'; default: number; unit: string }
  | { kind: 'choice'; options: { value: string; label: string }[]; default: string }
);

export interface RecipeResult {
  /** Stored form (raw codes); '' while a channel slot is still empty. */
  expression: string;
  name: string;
  units: string;
}

export interface Recipe {
  id: string;
  title: string;
  blurb: string;
  /** Roles that must all be present; an entry may be 'a|b' (either one). */
  requires: string[];
  slots: RecipeSlot[];
  build(values: Record<string, string>, labelOf: (code: string) => string): RecipeResult;
}

interface Conversion { value: string; label: string; factor: number; offset?: number; units: string }

/** Factors are written into the formula the user sees, so keep them short:
 *  the exact value when it is short already (1.609344, 9.80665), otherwise
 *  six significant figures of it. */
function shown(factor: number): number {
  const exact = Number(factor.toPrecision(12));
  return String(exact).length <= 8 ? exact : Number(factor.toPrecision(6));
}

/** A recipe conversion whose numbers come from the unit table in units.ts. */
function conversion(value: string, label: string, from: string, to: string, units = to): Conversion {
  const c = unitCoefficients(from, to);
  if (!c) throw new Error(`No conversion from ${from} to ${to}`);
  const offset = shown(c.offset);
  return { value, label, factor: shown(c.scale), ...(offset ? { offset } : {}), units };
}

const UNIT_CONVERSIONS: Conversion[] = [
  conversion('kmh_mph', 'km/h → mph', 'km/h', 'mph'),
  conversion('mph_kmh', 'mph → km/h', 'mph', 'km/h'),
  conversion('bar_psi', 'bar → psi', 'bar', 'psi'),
  conversion('psi_bar', 'psi → bar', 'psi', 'bar'),
  conversion('c_f', '°C → °F', '°C', '°F'),
  conversion('ms2_g', 'm/s² → g', 'm/s²', 'g'),
  conversion('g_ms2', 'g → m/s²', 'g', 'm/s²'),
  conversion('nm_lbft', 'N·m → lb·ft', 'Nm', 'lb·ft'),
  conversion('kw_hp', 'kW → hp', 'kW', 'hp'),
];

const FUEL_CONVERSIONS: Conversion[] = [
  conversion('lh_galh', 'L/h → US gal/h', 'L', 'gal', 'gal/h'),
  { value: 'ccmin_lh', label: 'cc/min → L/h', factor: 0.06, units: 'L/h' },
  { value: 'lh_ccmin', label: 'L/h → cc/min', factor: 16.6667, units: 'cc/min' },
];

const ref = formatChannelRef;
const channel = (key: string, label: string, role?: string): RecipeSlot =>
  role ? { key, label, kind: 'channel', role } : { key, label, kind: 'channel' };
const choice = (key: string, label: string, list: Conversion[]): RecipeSlot =>
  ({ key, label, kind: 'choice', options: list.map(c => ({ value: c.value, label: c.label })), default: list[0].value });

/** Build only once every listed channel slot is filled. */
function whenFilled(v: Record<string, string>, keys: string[], make: () => RecipeResult): RecipeResult {
  return keys.every(k => v[k]) ? make() : { expression: '', name: '', units: '' };
}

function convertWith(list: Conversion[], v: Record<string, string>, labelOf: (c: string) => string): RecipeResult {
  return whenFilled(v, ['channel'], () => {
    const c = list.find(x => x.value === v.conversion) ?? list[0];
    const offset = c.offset ? ` + ${c.offset}` : '';
    return { expression: `${ref(v.channel)} * ${c.factor}${offset}`, name: `${labelOf(v.channel)} (${c.units})`, units: c.units };
  });
}

export const RECIPES: Recipe[] = [
  {
    id: 'convert', title: 'Convert units', blurb: 'Show a channel in different units (mph, psi, °F…)',
    requires: [], slots: [channel('channel', 'Channel'), choice('conversion', 'Conversion', UNIT_CONVERSIONS)],
    build: (v, labelOf) => convertWith(UNIT_CONVERSIONS, v, labelOf),
  },
  {
    id: 'difference', title: 'Difference', blurb: 'One channel minus another',
    requires: [], slots: [channel('a', 'Channel'), channel('b', 'minus')],
    build: (v, labelOf) => whenFilled(v, ['a', 'b'], () => ({
      expression: `${ref(v.a)} - ${ref(v.b)}`, name: `${labelOf(v.a)} minus ${labelOf(v.b)}`, units: '',
    })),
  },
  {
    id: 'ratio', title: 'Ratio / percentage', blurb: 'One channel divided by another, or its share of the two',
    requires: [],
    slots: [channel('a', 'Channel'), channel('b', 'compared with'), {
      key: 'mode', label: 'Show as', kind: 'choice', default: 'ratio',
      options: [{ value: 'ratio', label: 'A ÷ B' }, { value: 'share', label: 'A as % of (A + B)' }],
    }],
    build: (v, labelOf) => whenFilled(v, ['a', 'b'], () => v.mode === 'share'
      ? { expression: `${ref(v.a)} / (${ref(v.a)} + ${ref(v.b)}) * 100`, name: `${labelOf(v.a)} share`, units: '%' }
      : { expression: `${ref(v.a)} / ${ref(v.b)}`, name: `${labelOf(v.a)} / ${labelOf(v.b)}`, units: '' }),
  },
  {
    id: 'smooth', title: 'Smooth out noise', blurb: 'Average a noisy channel over a short time window',
    requires: [], slots: [channel('channel', 'Channel'), { key: 'window', label: 'Window', kind: 'number', default: 200, unit: 'ms' }],
    build: (v, labelOf) => whenFilled(v, ['channel'], () => ({
      expression: `mavg(${ref(v.channel)}, ${Number(v.window) > 0 ? Number(v.window) : 200})`, name: `${labelOf(v.channel)} (smoothed)`, units: '',
    })),
  },
  {
    id: 'rate', title: 'Rate of change', blurb: 'How fast a channel is changing, per second',
    requires: [], slots: [channel('channel', 'Channel')],
    build: (v, labelOf) => whenFilled(v, ['channel'], () => ({
      expression: `diff(${ref(v.channel)})`, name: `${labelOf(v.channel)} rate`, units: '/s',
    })),
  },
  {
    id: 'combined-g', title: 'Combined G-force', blurb: 'Total grip used: lateral and longitudinal G together',
    requires: ['lat_accel', 'long_accel'],
    slots: [channel('lat', 'Lateral G', 'lat_accel'), channel('long', 'Longitudinal G', 'long_accel')],
    build: (v) => whenFilled(v, ['lat', 'long'], () => ({
      expression: `sqrt(${ref(v.lat)}^2 + ${ref(v.long)}^2)`, name: 'Combined G', units: 'g',
    })),
  },
  {
    id: 'brake-balance', title: 'Brake balance', blurb: 'Percent of brake pressure on the front axle',
    requires: ['brake_pressure_front', 'brake_pressure_rear'],
    slots: [channel('front', 'Front pressure', 'brake_pressure_front'), channel('rear', 'Rear pressure', 'brake_pressure_rear')],
    build: (v) => whenFilled(v, ['front', 'rear'], () => ({
      // max(…, 2): off the brakes both pressures are ~0, and dividing by ~0
      // would swing wildly; this reads ~0 % until there's real pressure.
      expression: `${ref(v.front)} / max(${ref(v.front)} + ${ref(v.rear)}, 2) * 100`, name: 'Brake Balance', units: '%',
    })),
  },
  {
    id: 'battery-power', title: 'Battery power', blurb: 'Power drawn from the HV battery (voltage × current)',
    requires: ['pack_voltage', 'pack_current'],
    slots: [channel('v', 'Battery voltage', 'pack_voltage'), channel('i', 'Battery current', 'pack_current')],
    build: (v) => whenFilled(v, ['v', 'i'], () => ({
      expression: `${ref(v.v)} * ${ref(v.i)} / 1000`, name: 'Battery Power', units: 'kW',
    })),
  },
  {
    id: 'power-500ms', title: 'Power, 500 ms average', blurb: 'Battery power averaged over 500 ms (FSAE EV power rule)',
    requires: ['pack_voltage', 'pack_current'],
    slots: [channel('v', 'Battery voltage', 'pack_voltage'), channel('i', 'Battery current', 'pack_current')],
    build: (v) => whenFilled(v, ['v', 'i'], () => ({
      expression: `mavg(${ref(v.v)} * ${ref(v.i)} / 1000, 500)`, name: 'Battery Power (500 ms avg)', units: 'kW',
    })),
  },
  {
    id: 'phase-current-rms', title: 'Motor phase current (RMS)', blurb: 'Overall motor current from the three phase currents',
    requires: ['phase_current_a', 'phase_current_b', 'phase_current_c'],
    slots: [channel('a', 'Phase A', 'phase_current_a'), channel('b', 'Phase B', 'phase_current_b'), channel('c', 'Phase C', 'phase_current_c')],
    build: (v) => whenFilled(v, ['a', 'b', 'c'], () => ({
      expression: `sqrt((${ref(v.a)}^2 + ${ref(v.b)}^2 + ${ref(v.c)}^2) / 3)`, name: 'Phase Current RMS', units: 'A',
    })),
  },
  {
    id: 'afr', title: 'Air-fuel ratio', blurb: 'Convert lambda to a gasoline air-fuel ratio (× 14.7)',
    requires: ['lambda'], slots: [channel('lambda', 'Lambda', 'lambda')],
    build: (v) => whenFilled(v, ['lambda'], () => ({ expression: `${ref(v.lambda)} * 14.7`, name: 'Air-Fuel Ratio', units: 'AFR' })),
  },
  {
    id: 'fuel-flow-convert', title: 'Fuel flow units', blurb: 'Show fuel flow in different units',
    requires: ['fuel_flow'], slots: [channel('channel', 'Fuel flow', 'fuel_flow'), choice('conversion', 'Conversion', FUEL_CONVERSIONS)],
    build: (v, labelOf) => convertWith(FUEL_CONVERSIONS, v, labelOf),
  },
  {
    id: 'gear-ratio', title: 'Estimated gear ratio', blurb: 'Engine RPM divided by speed — flat steps show each gear',
    requires: ['engine_rpm', 'wheel_speed|gps_speed'],
    slots: [channel('rpm', 'Engine RPM', 'engine_rpm'), channel('speed', 'Speed', 'wheel_speed|gps_speed')],
    build: (v) => whenFilled(v, ['rpm', 'speed'], () => ({
      // max(…, 5): avoid dividing by ~0 when the car is stopped.
      expression: `${ref(v.rpm)} / max(${ref(v.speed)}, 5)`, name: 'Gear Ratio (est.)', units: '',
    })),
  },
];

const hasRole = (channels: ChannelInfo[], spec: string) =>
  spec.split('|').some(role => channels.some(c => c.role === role));

export function availableRecipes(channels: ChannelInfo[]): Recipe[] {
  return RECIPES.filter(r => r.requires.every(spec => hasRole(channels, spec)));
}

/** Best channel for a role spec: earlier alternatives first, then lowest roleRank. */
function bestFor(channels: ChannelInfo[], spec: string): string {
  for (const role of spec.split('|')) {
    const matches = channels.filter(c => c.role === role);
    if (matches.length) {
      return matches.reduce((a, b) => ((b.roleRank ?? 10) < (a.roleRank ?? 10) ? b : a)).code;
    }
  }
  return '';
}

export function prefillSlots(recipe: Recipe, channels: ChannelInfo[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of recipe.slots) {
    if (s.kind === 'channel') out[s.key] = s.role ? bestFor(channels, s.role) : '';
    else out[s.key] = String(s.default);
  }
  return out;
}
