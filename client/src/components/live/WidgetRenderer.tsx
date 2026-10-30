import type React from 'react';
import { evaluateFormula, type ChannelMap } from '../../lib/formula-engine';
import { BUILTIN_UNITS, CHANNEL_META, IC_ENGINE_STATS, type Snapshot } from './live-channels';
import { convertUnit, unitCycle } from './units';
import { overrideKey, type UnitOverrides } from './useUnitOverrides';
import { otherChannelEntries, type ChannelRef, type StatStyle, type WidgetConfig } from './layout-schema';
import { fmt, directionLabel, clickableProps, unitTone, CLICKABLE, Panel, BigStat, CoolStat, VehicleStat, BarRow, BoolPill, GForceCircle, type StatTone } from './widgets';

// Default unit / precision for channels the layout doesn't override.
const META = new Map<string, { unit: string; precision: number }>([
  ...CHANNEL_META.map((m) => [m.name, m] as const),
  ...IC_ENGINE_STATS.map((s) => [s.name, s] as const),
]);

/** Evaluate a formula against one snapshot (each channel as a one-sample series). */
function evalExpr(expr: string, ch: Record<string, number>): number | undefined {
  const map: ChannelMap = {};
  for (const [name, v] of Object.entries(ch)) map[name] = { timestamps: [0], values: [v] };
  const out = evaluateFormula(expr, map);
  return typeof out === 'string' ? undefined : out.values[0];
}

/** Unit the logger sends this channel in (formulas have none). */
export function sourceUnit(ref: ChannelRef, deviceUnits: Record<string, string>): string | undefined {
  if (ref.expr) return undefined;
  return deviceUnits[ref.name] ?? BUILTIN_UNITS[ref.name];
}

/**
 * The value as the tile shows it: converted into `ref.unit` when that's a unit the
 * channel's own unit converts to (otherwise `ref.unit` is just a label). The no-data
 * floor and thresholds are in this same displayed unit.
 */
export function readValue(ref: ChannelRef, ch: Record<string, number>, deviceUnits: Record<string, string> = {}): number | undefined {
  let v = ref.expr ? evalExpr(ref.expr, ch) : ch[ref.name];
  if (v === undefined || !Number.isFinite(v)) return undefined;
  const from = sourceUnit(ref, deviceUnits);
  if (ref.unit && from) v = convertUnit(v, from, ref.unit) ?? v;
  if (ref.invalidBelow !== undefined && v <= ref.invalidBelow) return undefined;
  return v;
}

const UNIT_FIELDS = ['min', 'max', 'warn', 'crit', 'invalidBelow'] as const;

/**
 * `ref` shown in `unit` instead of its layout unit: the range, thresholds and no-data
 * floor are converted along with it. A layout unit that's only a label counts as the
 * logger's `sourceUnit`, since that's what the values were entered in.
 */
export function withDisplayUnit(ref: ChannelRef, unit: string, sourceUnit: string): ChannelRef {
  const from = ref.unit && convertUnit(0, sourceUnit, ref.unit) !== undefined ? ref.unit : sourceUnit;
  const out: ChannelRef = { ...ref, unit };
  for (const field of UNIT_FIELDS) {
    const v = ref[field];
    if (v !== undefined) out[field] = convertUnit(v, from, unit) ?? v;
  }
  return out;
}

/** Click-to-switch units for live values (absent in edit mode). */
export interface UnitSwitch {
  layoutId: string;
  overrides: UnitOverrides;
  cycle: (key: string, units: string[]) => void;
}

function displayValue(ref: ChannelRef, v: number | undefined): string {
  if (ref.format === 'onoff') return v === undefined ? '—' : v >= 0.5 ? 'ENABLED' : 'DISABLED';
  if (ref.format === 'direction') return directionLabel(v);
  const precision = ref.precision ?? META.get(ref.name)?.precision ?? (v !== undefined && Math.abs(v) >= 100 ? 0 : 2);
  return fmt(v, precision);
}

/** Layout override first, then the unit the logger's channel layout declares, then the built-in default. */
function unitOf(ref: ChannelRef, deviceUnits: Record<string, string>): string {
  if (ref.format === 'onoff' || ref.format === 'direction') return '';
  return ref.unit ?? sourceUnit(ref, deviceUnits) ?? '';
}

/**
 * Threshold color wins over the configured tone; on/off tiles go green when on.
 * `alert` is true only for a crossed warn/crit threshold, so static tones don't tint tiles.
 */
function toneFor(ref: ChannelRef, v: number | undefined): { tone: StatTone | undefined; alert: boolean } {
  if (v !== undefined) {
    if (ref.crit !== undefined && v >= ref.crit) return { tone: 'red', alert: true };
    if (ref.warn !== undefined && v >= ref.warn) return { tone: 'amber', alert: true };
    if (ref.format === 'onoff') return { tone: v >= 0.5 ? 'emerald' : 'muted', alert: false };
  }
  return { tone: ref.tone, alert: false };
}

const MIN_TILE_PX: Record<StatStyle, number> = { big: 140, tile: 110, compact: 76 };

// `columns` is a maximum: tiles still wrap once they'd shrink below `minPx`,
// so a fixed 8-across strip doesn't crush itself on a narrow window.
function gridStyle(columns: number | undefined, minPx: number): React.CSSProperties {
  const track = columns
    ? `max(${minPx}px, calc((100% - ${(columns - 1) * 0.5}rem) / ${columns}))`
    : `${minPx}px`;
  return {
    display: 'grid',
    gap: '0.5rem',
    gridTemplateColumns: `repeat(auto-fill, minmax(${track}, 1fr))`,
  };
}

export function WidgetRenderer({
  widget,
  latest,
  totalReceived,
  usedChannels,
  unitSwitch,
}: {
  widget: WidgetConfig;
  latest: Snapshot | null;
  totalReceived: number;
  /** Channels referenced by any widget in the layout (for `otherChannels`). */
  usedChannels: Set<string>;
  unitSwitch?: UnitSwitch;
}) {
  const ch = latest?.channels ?? {};
  const deviceUnits = latest?.units ?? {};
  const unit = (ref: ChannelRef) => unitOf(ref, deviceUnits);
  const read = (ref: ChannelRef) => readValue(ref, ch, deviceUnits);
  // The ref as shown, with the viewer's clicked unit applied, and how to switch it.
  // A stored unit that no longer fits the channel is ignored, so a value never gets stuck.
  const view = (ref: ChannelRef): { ref: ChannelRef; unitChanged: boolean; onClick?: () => void } => {
    const source = sourceUnit(ref, deviceUnits);
    if (!unitSwitch || !source || ref.format === 'onoff' || ref.format === 'direction') return { ref, unitChanged: false };
    const cycle = unitCycle(source, ref.unit ?? source);
    if (cycle.length < 2) return { ref, unitChanged: false };
    const key = overrideKey(unitSwitch.layoutId, widget.id, ref.name);
    const chosen = unitSwitch.overrides[key];
    const active = chosen !== undefined && chosen !== cycle[0] && cycle.includes(chosen) ? chosen : undefined;
    return {
      ref: active ? withDisplayUnit(ref, active, source) : ref,
      unitChanged: active !== undefined,
      onClick: () => unitSwitch.cycle(key, cycle),
    };
  };
  const label = (ref: ChannelRef) => ref.label || ref.name || ref.expr || '—';
  const note = widget.note && widget.type !== 'note' && (
    <p className="mt-2 text-[10px] text-muted-foreground/70 leading-snug whitespace-pre-wrap">{widget.note}</p>
  );
  // With a snapshot in hand but nothing for any of this widget's channels,
  // the source isn't transmitting (e.g. ECU unpowered) — say so instead of a wall of dashes.
  const valueWidget = widget.type === 'stats' || widget.type === 'bars' || widget.type === 'boolGroup' || widget.type === 'gForce';
  const noData = valueWidget && latest !== null && widget.channels.length > 0
    && widget.channels.every((ref) => read(ref) === undefined);
  const rightSlot = noData ? (
    <span className="text-[10px] text-warning shrink-0" title="The logger reports no value for any channel in this widget">
      no data
    </span>
  ) : undefined;

  let body: React.ReactNode;
  switch (widget.type) {
    case 'stats': {
      const style = widget.style ?? 'tile';
      body = (
        <div style={gridStyle(widget.columns, MIN_TILE_PX[style])}>
          {widget.channels.map((layoutRef, i) => {
            const { ref, unitChanged, onClick } = view(layoutRef);
            const v = read(ref);
            const props = { label: label(ref), value: displayValue(ref, v), unit: unit(ref), ...toneFor(ref, v), unitChanged, onClick };
            return style === 'big' ? <BigStat key={i} {...props} />
              : style === 'compact' ? <VehicleStat key={i} {...props} />
              : <CoolStat key={i} {...props} />;
          })}
        </div>
      );
      break;
    }
    case 'bars':
      body = (
        <div className="space-y-2.5">
          {widget.channels.map((layoutRef, i) => {
            const { ref, unitChanged, onClick } = view(layoutRef);
            const v = read(ref);
            const min = ref.min ?? 0;
            const max = ref.max ?? 100;
            const fraction = v === undefined || max <= min ? undefined : Math.max(0, Math.min(1, (v - min) / (max - min)));
            return (
              <BarRow key={i} label={label(ref)} value={displayValue(ref, v)} unit={unit(ref)} fraction={fraction} {...toneFor(ref, v)} unitChanged={unitChanged} onClick={onClick} />
            );
          })}
        </div>
      );
      break;
    case 'boolGroup':
      body = (
        <div style={gridStyle(widget.columns, 130)} className="!gap-1.5">
          {widget.channels.map((ref, i) => (
            <BoolPill key={i} name={ref.name} label={label(ref)} kind={ref.kind ?? 'state'} value={read(ref)} />
          ))}
        </div>
      );
      break;
    case 'gForce': {
      const [latRef, longRef] = widget.channels;
      body = (
        <GForceCircle
          lat={latRef ? read(latRef) : undefined}
          long={longRef ? read(longRef) : undefined}
          range={latRef?.max ?? 2}
        />
      );
      break;
    }
    case 'otherChannels': {
      const entries = otherChannelEntries(ch, usedChannels);
      body = entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60">
          {latest
            ? 'Every channel in this snapshot is already on the dashboard.'
            : 'Channels the car sends that no other widget shows will appear here.'}
        </p>
      ) : (
        <div style={gridStyle(widget.columns, 96)} className="!gap-1.5">
          {entries.map(([name]) => {
            const { ref, unitChanged, onClick } = view({ name });
            const val = read(ref);
            return (
              <div
                key={name}
                {...clickableProps(onClick)}
                className={`rounded-[9px] bg-background dark:bg-card px-2 py-1.5 ${onClick ? CLICKABLE : ''}`}
              >
                <p className="text-[11px] font-medium text-muted-foreground truncate" title={name}>{name}</p>
                <p className="text-sm font-semibold tabular mt-0.5 text-foreground">
                  {displayValue(ref, val)}
                  {unit(ref) && <span className={`text-[9px] font-normal ml-1 ${unitTone(unitChanged)}`}>{unit(ref)}</span>}
                </p>
              </div>
            );
          })}
        </div>
      );
      break;
    }
    case 'streamHealth':
      body = (
        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Snapshots received</span>
            <span className="tabular font-semibold">{totalReceived}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Latest ts</span>
            <span className="tabular font-semibold">{latest ? `${(latest.ts / 1000).toFixed(2)}s` : '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Subsystem</span>
            <span className="font-mono font-semibold">{latest?.subsystem || '—'}</span>
          </div>
        </div>
      );
      break;
    case 'note':
      body = <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{widget.note || ''}</p>;
      break;
  }

  return (
    <Panel title={widget.title} tone={widget.emphasis ? 'primary' : undefined} rightSlot={rightSlot} className="h-full">
      {body}
      {note}
    </Panel>
  );
}
