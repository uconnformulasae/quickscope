import { type VehicleKind } from './live-channels';

// ────────────────────────────────────────────────────────────────────────────
// User-customizable live dashboard layouts. A layout is a list of widgets
// (each one a titled Panel on screen) plus their react-grid-layout positions.
// The backend stores layouts as opaque JSON; this file owns the schema, so
// everything loaded from disk or imported from a file goes through
// `validateLayout` first.
// ────────────────────────────────────────────────────────────────────────────

export type WidgetType =
  | 'stats'          // grid of value tiles (big / tile / compact)
  | 'bars'           // one horizontal min→max bar per channel
  | 'boolGroup'      // state / fault pills
  | 'gForce'         // lateral vs. longitudinal friction circle (2 channels)
  | 'otherChannels'  // every live channel not used elsewhere in the layout
  | 'streamHealth'   // snapshots received, latest ts, subsystem
  | 'note';          // free text

export const WIDGET_TYPES: { type: WidgetType; label: string; description: string }[] = [
  { type: 'stats',         label: 'Stats',          description: 'Grid of channel values' },
  { type: 'bars',          label: 'Bars',           description: 'Horizontal bar per channel (needs min/max)' },
  { type: 'boolGroup',     label: 'Status lights',  description: 'ON/OFF state and fault pills' },
  { type: 'gForce',        label: 'G-force circle', description: 'Lateral + longitudinal acceleration' },
  { type: 'otherChannels', label: 'Other channels', description: 'Live channels not used by any other widget' },
  { type: 'streamHealth',  label: 'Stream health',  description: 'Snapshot count, timestamp, subsystem' },
  { type: 'note',          label: 'Note',           description: 'Free text' },
];

export type ValueFormat = 'number' | 'onoff' | 'direction';
export type StatStyle = 'big' | 'tile' | 'compact';
export type Tone = 'primary' | 'emerald' | 'amber' | 'red' | 'muted';

/** One channel shown inside a widget, with optional display overrides. */
export interface ChannelRef {
  name: string;
  label?: string;
  unit?: string;
  precision?: number;
  /** Formula (formula-engine syntax) evaluated against the snapshot instead of reading `name`. */
  expr?: string;
  format?: ValueFormat;
  min?: number;
  max?: number;
  /** Value at/above which the tile is amber / red. */
  warn?: number;
  crit?: number;
  /** Values at/below this are treated as "no data" (e.g. a disconnected thermocouple). */
  invalidBelow?: number;
  /** boolGroup polarity: state 1 = good (green), fault 1 = bad (red). */
  kind?: 'state' | 'fault';
  tone?: Tone;
}

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  title: string;
  channels: ChannelRef[];
  /** Tile columns at full width (stats / boolGroup / otherChannels). */
  columns?: number;
  style?: StatStyle;
  /** Highlighted panel border (the "hero" panel). */
  emphasis?: boolean;
  /** Text under the widget body; the whole body for `note`. */
  note?: string;
}

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LiveLayout {
  id: string;
  name: string;
  vehicle: VehicleKind;
  version: 1;
  grid: GridItem[];
  widgets: WidgetConfig[];
  /** Shipped defaults: read-only, duplicated before editing. */
  builtIn?: boolean;
  updatedAt: string;
}

export const GRID_COLS = 12;

export function newId(prefix = 'w'): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

// ── Validation ──────────────────────────────────────────────────────────────

const WIDGET_TYPE_SET = new Set<string>(WIDGET_TYPES.map((t) => t.type));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function cleanChannel(raw: unknown): ChannelRef | null {
  if (typeof raw === 'string') return raw ? { name: raw } : null;
  if (!isObj(raw)) return null;
  const name = str(raw.name) ?? '';
  const expr = str(raw.expr);
  if (!name && !expr) return null;
  const ref: ChannelRef = { name };
  const label = str(raw.label); if (label !== undefined) ref.label = label;
  const unit = str(raw.unit); if (unit !== undefined) ref.unit = unit;
  if (expr) ref.expr = expr;
  for (const k of ['precision', 'min', 'max', 'warn', 'crit', 'invalidBelow'] as const) {
    const v = num(raw[k]);
    if (v !== undefined) ref[k] = v;
  }
  if (raw.format === 'onoff' || raw.format === 'direction' || raw.format === 'number') ref.format = raw.format;
  if (raw.kind === 'state' || raw.kind === 'fault') ref.kind = raw.kind;
  if (['primary', 'emerald', 'amber', 'red', 'muted'].includes(raw.tone as string)) ref.tone = raw.tone as Tone;
  return ref;
}

/**
 * Parse untrusted JSON (backend file, imported file) into a LiveLayout.
 * Throws on a structurally unusable layout; drops individual widgets it
 * doesn't understand (e.g. from a newer QuickScope) and reports them.
 */
export function validateLayout(json: unknown): { layout: LiveLayout; warnings: string[] } {
  if (!isObj(json)) throw new Error('Layout is not a JSON object');
  const id = str(json.id);
  const name = str(json.name);
  if (!id) throw new Error('Layout is missing an id');
  if (!name) throw new Error('Layout is missing a name');
  if (json.vehicle !== 'ev' && json.vehicle !== 'ic') throw new Error('Layout vehicle must be "ev" or "ic"');
  if (!Array.isArray(json.widgets)) throw new Error('Layout has no widgets list');

  const warnings: string[] = [];
  const widgets: WidgetConfig[] = [];
  const seen = new Set<string>();
  for (const raw of json.widgets) {
    if (!isObj(raw) || !str(raw.id) || seen.has(raw.id as string)) {
      warnings.push('Skipped a widget without a unique id');
      continue;
    }
    if (!WIDGET_TYPE_SET.has(raw.type as string)) {
      warnings.push(`Skipped widget "${str(raw.title) ?? raw.id}" with unknown type "${String(raw.type)}"`);
      continue;
    }
    seen.add(raw.id as string);
    const w: WidgetConfig = {
      id: raw.id as string,
      type: raw.type as WidgetType,
      title: str(raw.title) ?? '',
      channels: Array.isArray(raw.channels)
        ? raw.channels.map(cleanChannel).filter((c): c is ChannelRef => c !== null)
        : [],
    };
    const columns = num(raw.columns);
    if (columns !== undefined) w.columns = Math.max(1, Math.min(12, Math.round(columns)));
    if (raw.style === 'big' || raw.style === 'tile' || raw.style === 'compact') w.style = raw.style;
    if (raw.emphasis === true) w.emphasis = true;
    const note = str(raw.note); if (note) w.note = note;
    widgets.push(w);
  }

  // Grid items: keep those that point at a kept widget; place any widget
  // missing a position at the bottom so nothing silently disappears.
  const rawGrid = Array.isArray(json.grid) ? json.grid : [];
  const grid: GridItem[] = [];
  for (const g of rawGrid) {
    if (!isObj(g) || !seen.has(g.i as string) || grid.some((x) => x.i === g.i)) continue;
    const w = Math.max(1, Math.min(GRID_COLS, Math.round(num(g.w) ?? 4)));
    grid.push({
      i: g.i as string,
      x: Math.max(0, Math.min(GRID_COLS - w, Math.round(num(g.x) ?? 0))),
      y: Math.max(0, Math.round(num(g.y) ?? 0)),
      w,
      h: Math.max(1, Math.round(num(g.h) ?? 4)),
    });
  }
  let bottom = grid.reduce((m, g) => Math.max(m, g.y + g.h), 0);
  for (const w of widgets) {
    if (!grid.some((g) => g.i === w.id)) {
      grid.push({ i: w.id, x: 0, y: bottom, w: GRID_COLS, h: 4 });
      bottom += 4;
    }
  }

  return {
    layout: {
      id,
      name,
      vehicle: json.vehicle,
      version: 1,
      grid,
      widgets,
      updatedAt: str(json.updatedAt) ?? new Date().toISOString(),
    },
    warnings,
  };
}

// ── Helpers used by the renderer and editor ─────────────────────────────────

/** Channel names referenced anywhere in the layout (including inside formulas). */
export function usedChannels(layout: Pick<LiveLayout, 'widgets'>, extractNames: (expr: string) => string[]): Set<string> {
  const used = new Set<string>();
  for (const w of layout.widgets) {
    for (const c of w.channels) {
      if (c.name) used.add(c.name);
      if (c.expr) for (const n of extractNames(c.expr)) used.add(n);
    }
  }
  return used;
}

/** Live channels no widget shows — the content of an `otherChannels` widget. */
export function otherChannelEntries(channels: Record<string, number>, used: Set<string>): [string, number][] {
  return Object.entries(channels)
    .filter(([name]) => !used.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Copy of a layout with fresh ids (layout + widgets), for duplicate / import. */
export function cloneLayout(layout: LiveLayout, overrides: Partial<Pick<LiveLayout, 'name' | 'vehicle'>> = {}): LiveLayout {
  const idMap = new Map<string, string>();
  const widgets = layout.widgets.map((w) => {
    const id = newId();
    idMap.set(w.id, id);
    return { ...w, id, channels: w.channels.map((c) => ({ ...c })) };
  });
  return {
    ...layout,
    ...overrides,
    id: newId('layout'),
    builtIn: undefined,
    widgets,
    grid: layout.grid.filter((g) => idMap.has(g.i)).map((g) => ({ ...g, i: idMap.get(g.i)! })),
    updatedAt: new Date().toISOString(),
  };
}

// ── Layout selection rules ──────────────────────────────────────────────────

export interface LayoutSelection {
  /** Last layout chosen for each car — what auto-switch picks on connect. */
  active: Partial<Record<VehicleKind, string>>;
  /** When set, connecting never switches away from this layout. */
  pinned: string | null;
  /** Shown when the view opens offline. */
  last_used: string | null;
}

export const EMPTY_SELECTION: LayoutSelection = { active: {}, pinned: null, last_used: null };

export const BUILTIN_ID: Record<VehicleKind, string> = { ev: 'builtin-ev', ic: 'builtin-ic' };

/** Layout to show when the view opens (no car yet). */
export function layoutForOffline(layoutIds: Set<string>, sel: LayoutSelection): string {
  if (sel.pinned && layoutIds.has(sel.pinned)) return sel.pinned;
  if (sel.last_used && layoutIds.has(sel.last_used)) return sel.last_used;
  return BUILTIN_ID.ev;
}

/** Layout to switch to when a car connects. Pinned wins; else the car's last-used layout. */
export function layoutForConnect(layoutIds: Set<string>, sel: LayoutSelection, kind: VehicleKind): string {
  if (sel.pinned && layoutIds.has(sel.pinned)) return sel.pinned;
  const active = sel.active[kind];
  if (active && layoutIds.has(active)) return active;
  return BUILTIN_ID[kind];
}

/** Selection after the user picks a layout. */
export function selectionAfterPick(sel: LayoutSelection, layout: Pick<LiveLayout, 'id' | 'vehicle'>): LayoutSelection {
  return {
    ...sel,
    active: { ...sel.active, [layout.vehicle]: layout.id },
    last_used: layout.id,
    // Picking a different layout while pinned moves the pin with it.
    pinned: sel.pinned ? layout.id : null,
  };
}
