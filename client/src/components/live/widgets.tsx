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
  primary: 'text-primary',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  red: 'text-red-500 dark:text-red-400',
  muted: 'text-muted-foreground',
};

const BORDER_TONE: Record<StatTone, string> = {
  primary: 'border-primary/40',
  emerald: 'border-emerald-500/40',
  amber: 'border-amber-500/60',
  red: 'border-red-500/60',
  muted: 'border-muted-foreground/30',
};

const BAR_TONE: Record<StatTone, string> = {
  primary: 'bg-primary',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  muted: 'bg-muted-foreground/50',
};

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
  return changed ? 'text-primary' : 'text-muted-foreground';
}

interface StatProps {
  label: string;
  value: string;
  unit: string;
  tone?: StatTone;
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
      className={`flex flex-col rounded-lg bg-[hsl(225,30%,95%)] dark:bg-card border ${
        tone === 'primary'
          ? 'border-primary/30'
          : 'border-[hsl(225,25%,85%)] dark:border-border/50'
      } p-3 ${className}`}
    >
      <header className="flex items-center justify-between gap-2 mb-2.5 flex-shrink-0 min-w-0">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{title}</h3>
        {rightSlot}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

export function BigStat({ label, value, unit, tone, unitChanged, onClick }: StatProps) {
  return (
    <div
      {...clickableProps(onClick)}
      className={`rounded-md bg-background/60 dark:bg-background/30 border border-[hsl(225,25%,85%)] dark:border-border/40 px-3 py-2 ${onClick ? CLICKABLE : ''}`}
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p className={`text-2xl font-bold tabular mt-0.5 ${TEXT_TONE[tone ?? 'primary']}`}>
        {value}
        <span className={`text-xs font-normal ml-1 ${unitTone(unitChanged)}`}>{unit}</span>
      </p>
    </div>
  );
}

export function CoolStat({ label, value, unit, tone, unitChanged, onClick }: StatProps) {
  return (
    <div
      {...clickableProps(onClick)}
      className={`rounded-md border ${BORDER_TONE[tone ?? 'muted']} bg-background/60 dark:bg-background/30 px-2.5 py-2 ${onClick ? CLICKABLE : ''}`}
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p className="text-base font-bold tabular mt-0.5 text-foreground">
        {value}
        <span className={`text-[10px] font-normal ml-1 ${unitTone(unitChanged)}`}>{unit}</span>
      </p>
    </div>
  );
}

export function VehicleStat({ label, value, unit, tone, unitChanged, onClick }: StatProps) {
  return (
    <div
      {...clickableProps(onClick)}
      className={`rounded-md bg-background/60 dark:bg-background/30 border border-[hsl(225,25%,85%)] dark:border-border/40 px-2 py-1.5 text-center ${onClick ? CLICKABLE : ''}`}
    >
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground truncate" title={label}>{label}</p>
      <p className={`text-sm font-bold tabular mt-0.5 ${tone && tone !== 'muted' ? TEXT_TONE[tone] : 'text-foreground'}`}>
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
      <div className="flex items-baseline justify-between text-[10px] mb-1 gap-2">
        <span className="font-medium text-muted-foreground truncate">{label}</span>
        <span className={`tabular font-semibold ${TEXT_TONE[tone ?? 'primary']}`}>
          {value}
          {unit && <span className={`font-normal ml-0.5 ${unitTone(unitChanged)}`}>{unit}</span>}
        </span>
      </div>
      <div className="h-1.5 bg-muted/50 rounded-full overflow-hidden">
        {fraction !== undefined && (
          <div className={`h-full rounded-full ${BAR_TONE[tone ?? 'primary']}`} style={{ width: `${fraction * 100}%` }} />
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
        className={`flex items-center justify-between rounded-md px-2 py-1.5 border text-[11px] ${
          !hasValue
            ? 'bg-muted/20 border-border/30 text-muted-foreground/50'
            : on
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
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
      className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 border text-[11px] ${
        !hasValue
          ? 'bg-muted/20 border-border/30 text-muted-foreground/50'
          : on
          ? 'bg-red-500/10 border-red-500/40 text-red-600 dark:text-red-400'
          : 'bg-emerald-500/5 border-emerald-500/20 text-muted-foreground'
      }`}
      title={`${name} = ${hasValue ? value : '—'} (1 = active fault, 0 = healthy)`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          !hasValue ? 'bg-muted-foreground/30' : on ? 'bg-red-500 animate-pulse' : 'bg-emerald-500/60'
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
      <svg viewBox="-50 -50 100 100" className="flex-1 min-h-0 w-full max-h-64" role="img" aria-label="G-force circle">
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
        <span>Lat <span className="text-foreground font-semibold">{fmt(lat, 2)}</span> g</span>
        <span>Long <span className="text-foreground font-semibold">{fmt(long, 2)}</span> g</span>
      </div>
    </div>
  );
}
