import type React from 'react';

export function fmt(v: number | undefined, precision: number): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(precision);
}

// Direction channel: f32 1.0 = forward (docs/protocol/aim-live-protocol-deep-dive.md).
export function directionLabel(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v >= 0.5 ? 'FWD' : 'REV';
}

export type StatTone = 'primary' | 'emerald' | 'amber' | 'red' | 'muted';

const TEXT_TONE: Record<StatTone, string> = {
  primary: 'text-foreground',
  emerald: 'text-success',
  amber: 'text-warning',
  red: 'text-danger',
  muted: 'text-foreground',
};

// Only warning and alarm states tint the tile.
const TILE_TONE: Record<StatTone, string> = {
  primary: '',
  emerald: '',
  amber: 'bg-warning/10',
  red: 'bg-danger/10',
  muted: '',
};

const BAR_TONE: Record<StatTone, string> = {
  primary: 'bg-primary',
  emerald: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-danger',
  muted: 'bg-label-4',
};

const TILE_BASE = 'rounded-[9px] bg-background dark:bg-card';
const tile = (tone: StatTone | undefined, alert: boolean | undefined) => (alert && tone && TILE_TONE[tone] ? `rounded-[9px] ${TILE_TONE[tone]}` : TILE_BASE);

export const CLICKABLE =
  'cursor-pointer select-none transition-shadow hover:ring-1 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

/** Makes a value switch units on click / Enter / Space; nothing when `onClick` is absent. */
export function clickableProps(onClick: (() => void) | undefined): React.HTMLAttributes<HTMLElement> {
  if (!onClick) return {};
  return {
    role: 'button',
    tabIndex: 0,
    title: 'Click to switch unit',
    onClick,
    onKeyDown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onClick();
    },
  };
}

/** A unit the viewer switched away from the layout's is tinted so a stray tap is noticeable. */
export function unitTone(changed: boolean | undefined): string {
  return changed ? 'text-primary' : 'text-label-3';
}

interface StatProps {
  label: string;
  value: string;
  unit: string;
  tone?: StatTone;
  /** True only when a warn/crit threshold is crossed; a static configured tone colors text only. */
  alert?: boolean;
  unitChanged?: boolean;
  onClick?: () => void;
}

// Panels fill their grid cell; the body scrolls if a user shrinks the widget
// below its content height.
export function Panel({
  title,
  children,
  className = '',
  rightSlot,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  rightSlot?: React.ReactNode;
  tone?: 'primary';
}) {
  return (
    <section
      className={`live-panel flex flex-col rounded-[13px] bg-popover ring-[0.5px] ring-separator dark:ring-0 ${
        tone === 'primary' ? 'ring-primary/40' : ''
      } p-3 ${className}`}
    >
      <header className="flex items-center justify-between gap-2 mb-2.5 flex-shrink-0 min-w-0">
        <h3 className="font-display text-[13px] font-semibold text-foreground truncate">{title}</h3>
        {rightSlot}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

export function BigStat({ label, value, unit, tone, alert, unitChanged, onClick }: StatProps) {
  return (
    <div
      {...clickableProps(onClick)}
      className={`${tile(tone, alert)} px-3 py-2 ${onClick ? CLICKABLE : ''}`}
    >
      <p className="text-[11px] font-medium text-muted-foreground truncate">{label}</p>
      <p className={`font-display text-2xl font-medium tabular live-value mt-0.5 ${TEXT_TONE[tone ?? 'primary']}`}>
        {value}
        <span className={`text-xs font-normal ml-1 ${unitTone(unitChanged)}`}>{unit}</span>
      </p>
    </div>
  );
}

export function CoolStat({ label, value, unit, tone, alert, unitChanged, onClick }: StatProps) {
  return (
    <div
      {...clickableProps(onClick)}
      className={`${tile(tone, alert)} px-2.5 py-2 ${onClick ? CLICKABLE : ''}`}
    >
      <p className="text-[11px] font-medium text-muted-foreground truncate">{label}</p>
      <p className={`font-display text-base font-medium tabular live-value mt-0.5 ${TEXT_TONE[tone ?? 'muted']}`}>
        {value}
        <span className={`text-[10px] font-normal ml-1 ${unitTone(unitChanged)}`}>{unit}</span>
      </p>
    </div>
  );
}

export function VehicleStat({ label, value, unit, tone, alert, unitChanged, onClick }: StatProps) {
  return (
    <div
      {...clickableProps(onClick)}
      className={`${tile(tone, alert)} px-2 py-1.5 text-center ${onClick ? CLICKABLE : ''}`}
    >
      <p className="text-[11px] font-medium text-muted-foreground truncate" title={label}>{label}</p>
      <p className={`font-display text-sm font-medium tabular live-value mt-0.5 ${TEXT_TONE[tone ?? 'muted']}`}>
        {value}
        {unit && <span className={`text-[9px] font-normal ml-0.5 ${unitTone(unitChanged)}`}>{unit}</span>}
      </p>
    </div>
  );
}

/** Labeled horizontal bar; `fraction` is 0–1, undefined when there is no value. */
export function BarRow({
  label,
  value,
  unit,
  fraction,
  tone,
  unitChanged,
  onClick,
}: StatProps & { fraction: number | undefined }) {
  return (
    <div {...clickableProps(onClick)} className={onClick ? `rounded-sm ${CLICKABLE}` : undefined}>
      <div className="flex items-baseline justify-between text-[11px] mb-1 gap-2">
        <span className="font-medium text-muted-foreground truncate">{label}</span>
        <span className={`tabular live-value font-semibold ${TEXT_TONE[tone ?? 'primary']}`}>
          {value}
          {unit && <span className={`font-normal ml-0.5 ${unitTone(unitChanged)}`}>{unit}</span>}
        </span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        {fraction !== undefined && (
          <div className={`live-indicator h-full rounded-full ${BAR_TONE[tone ?? 'primary']}`} style={{ width: `${fraction * 100}%` }} />
        )}
      </div>
    </div>
  );
}

/** State pill (1 = on, green) or fault pill (1 = active fault, red). Neutral grey when there's no value. */
export function BoolPill({
  name,
  label,
  kind,
  value,
}: {
  name: string;
  label: string;
  kind: 'state' | 'fault';
  value: number | undefined;
}) {
  const hasValue = value !== undefined && Number.isFinite(value);
  const on = hasValue && value >= 0.5;
  if (kind === 'state') {
    return (
      <div
        className={`live-indicator flex items-center justify-between rounded-md px-2 py-1.5 border text-[11px] ${
          !hasValue
            ? 'bg-muted/20 border-border/30 text-muted-foreground/50'
            : on
            ? 'bg-success/10 border-success/30 text-success'
            : 'bg-muted/40 border-border/40 text-muted-foreground'
        }`}
        title={`${name} = ${hasValue ? value : '—'} (1 = on, 0 = off)`}
      >
        <span className="font-medium truncate">{label}</span>
        <span className="font-mono ml-2">{!hasValue ? '—' : on ? 'ON' : 'OFF'}</span>
      </div>
    );
  }
  return (
    <div
      className={`live-indicator flex items-center gap-1.5 rounded-md px-2 py-1.5 border text-[11px] ${
        !hasValue
          ? 'bg-muted/20 border-border/30 text-muted-foreground/50'
          : on
          ? 'bg-danger/10 border-danger/40 text-danger'
          : 'bg-success/5 border-success/20 text-muted-foreground'
      }`}
      title={`${name} = ${hasValue ? value : '—'} (1 = active fault, 0 = healthy)`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          !hasValue ? 'bg-muted-foreground/30' : on ? 'bg-danger animate-pulse' : 'bg-success/60'
        }`}
      />
      <span className="truncate">{label}</span>
    </div>
  );
}

/** Friction circle: lateral on x, longitudinal on y, rings every 0.5 g. */
export function GForceCircle({
  lat,
  long,
  range,
}: {
  lat: number | undefined;
  long: number | undefined;
  range: number;
}) {
  const r = 45;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v / range));
  const hasDot = lat !== undefined && long !== undefined && Number.isFinite(lat) && Number.isFinite(long);
  const rings: number[] = [];
  for (let g = 0.5; g <= range + 1e-9; g += 0.5) rings.push(g);
  return (
    <div className="flex flex-col items-center gap-1.5 h-full">
      <svg viewBox="-50 -50 100 100" className="live-indicator flex-1 min-h-0 w-full max-h-64" role="img" aria-label="G-force circle">
        {rings.map((g) => (
          <circle key={g} cx={0} cy={0} r={(g / range) * r} fill="none" className="stroke-border" strokeWidth={0.6} />
        ))}
        <line x1={-r} y1={0} x2={r} y2={0} className="stroke-border" strokeWidth={0.6} />
        <line x1={0} y1={-r} x2={0} y2={r} className="stroke-border" strokeWidth={0.6} />
        {hasDot && (
          // Braking (negative long) plots downward, like a standard g-g diagram.
          <circle cx={clamp(lat) * r} cy={-clamp(long) * r} r={3.5} className="fill-primary" />
        )}
      </svg>
      <div className="flex gap-3 text-[10px] text-muted-foreground tabular">
        <span>Lat <span className="live-value text-foreground font-semibold">{fmt(lat, 2)}</span> g</span>
        <span>Long <span className="text-foreground font-semibold">{fmt(long, 2)}</span> g</span>
      </div>
    </div>
  );
}
