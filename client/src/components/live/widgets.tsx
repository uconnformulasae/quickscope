import type React from 'react';

export function fmt(v: number | undefined, precision: number): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(precision);
}

// Direction channel: f32 1.0 = forward (docs/protocol/aim-live-protocol-deep-dive.md).
export function directionLabel(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v === 1 ? 'FWD' : 'REV';
}

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
      className={`rounded-lg bg-[hsl(225,30%,95%)] dark:bg-card border ${
        tone === 'primary'
          ? 'border-primary/30'
          : 'border-[hsl(225,25%,85%)] dark:border-border/50'
      } p-3 ${className}`}
    >
      <header className="flex items-center justify-between mb-2.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {rightSlot}
      </header>
      {children}
    </section>
  );
}

export function BigStat({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  tone?: 'primary' | 'emerald' | 'amber';
}) {
  const colorClass =
    tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' :
    tone === 'amber' ? 'text-amber-600 dark:text-amber-400' :
    'text-primary';
  return (
    <div className="rounded-md bg-background/60 dark:bg-background/30 border border-[hsl(225,25%,85%)] dark:border-border/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold tabular mt-0.5 ${colorClass}`}>
        {value}
        <span className="text-xs text-muted-foreground font-normal ml-1">{unit}</span>
      </p>
    </div>
  );
}

export function CoolStat({
  label,
  value,
  unit,
  borderClass,
}: {
  label: string;
  value: string;
  unit: string;
  borderClass: string;
}) {
  return (
    <div className={`rounded-md border ${borderClass} bg-background/60 dark:bg-background/30 px-2.5 py-2`}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-base font-bold tabular mt-0.5 text-foreground">
        {value}
        <span className="text-[10px] text-muted-foreground font-normal ml-1">{unit}</span>
      </p>
    </div>
  );
}

export function VehicleStat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-md bg-background/60 dark:bg-background/30 border border-[hsl(225,25%,85%)] dark:border-border/40 px-2 py-1.5 text-center">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-bold tabular mt-0.5 text-foreground">
        {value}
        {unit && <span className="text-[9px] text-muted-foreground font-normal ml-0.5">{unit}</span>}
      </p>
    </div>
  );
}
