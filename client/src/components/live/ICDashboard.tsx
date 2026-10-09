import { type Snapshot, RING_BUFFER_SIZE, IC_ENGINE_STATS, IC_WHEEL_SPEEDS, IC_ENGINE_FLAGS, IC_BRAKE_TEMPS, IC_TIRE_TEMPS, IC_TC_DISCONNECTED, IC_PANEL_OWNED_CHANNELS } from './live-channels';
import { fmt, Panel, BigStat, CoolStat, VehicleStat } from './widgets';

// ────────────────────────────────────────────────────────────────────────────
// IC dashboard (UConn-IC). Same card chrome as the EV dashboard, but built
// from the IC layout's channels: the ECU "S8_*" block, IMU, brake pressure /
// bias, brake-rotor and tire thermocouples, and logger supply voltage. The
// ECU block reads the device's "no data" sentinel (decoded as absent) when
// the ECU isn't transmitting — those tiles show "—" and a banner explains why.
// ────────────────────────────────────────────────────────────────────────────

export function ICDashboard({
  latest,
  count,
  totalReceived,
  bufferStats,
}: {
  latest: Snapshot | null;
  count: number;
  totalReceived: number;
  bufferStats: { bySubsystem: Record<string, number> };
}) {
  const ch = latest?.channels ?? {};
  const ecuAlive = IC_ENGINE_STATS.some((s) => ch[s.name] !== undefined);
  const tireTemp = (name: string): string => {
    const v = ch[name];
    return v === undefined || v <= IC_TC_DISCONNECTED ? '—' : fmt(v, 1);
  };
  const others = Object.entries(ch)
    .filter(([name]) => !IC_PANEL_OWNED_CHANNELS.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 max-w-[1600px] mx-auto">
      <Panel
        title="Engine · ECU"
        className="lg:col-span-12"
        tone="primary"
        rightSlot={
          <span className={`text-[10px] ${ecuAlive ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
            {latest ? (ecuAlive ? 'ECU data live' : 'ECU not transmitting') : 'waiting…'}
          </span>
        }
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <BigStat label="RPM"  value={fmt(ch['S8_RPM'], 0)}  unit="rpm" tone="primary" />
          <BigStat label="Gear" value={fmt(ch['S8_gear'], 0)} unit="" tone="emerald" />
          <BigStat label="TPS"  value={fmt(ch['S8_tps1'], 1)} unit="" tone="amber" />
          <BigStat label="Lambda" value={fmt(ch['S8_lam1'], 2)} unit="" tone="primary" />
        </div>
        <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {IC_ENGINE_STATS.filter((s) => !['S8_RPM', 'S8_gear', 'S8_tps1', 'S8_lam1'].includes(s.name)).map((s) => (
            <VehicleStat key={s.name} label={s.label} value={fmt(ch[s.name], s.precision)} unit={s.unit} />
          ))}
        </div>
        {!ecuAlive && latest && (
          <p className="mt-2 text-[10px] text-muted-foreground/80 leading-snug">
            The logger is reporting no value for any ECU channel (S8_*). That means the ECU CAN feed
            isn't reaching the logger (key off, ECU unpowered or CAN not connected) — not a QuickScope fault.
          </p>
        )}
      </Panel>

      <Panel title="Chassis" className="lg:col-span-5">
        <div className="grid grid-cols-3 gap-2">
          <VehicleStat label="Lat G"  value={fmt(ch['LateralAcc'], 2)}  unit="g" />
          <VehicleStat label="Long G" value={fmt(ch['InlineAcc'], 2)}   unit="g" />
          <VehicleStat label="Vert G" value={fmt(ch['VerticalAcc'], 2)} unit="g" />
          <VehicleStat label="Yaw"    value={fmt(ch['YawRate'], 1)}     unit="°/s" />
          <VehicleStat label="Roll"   value={fmt(ch['RollRate'], 1)}    unit="°/s" />
          <VehicleStat label="Pitch"  value={fmt(ch['PitchRate'], 1)}   unit="°/s" />
        </div>
        <p className="mt-2.5 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Wheel speed</p>
        <div className="grid grid-cols-4 gap-2">
          {IC_WHEEL_SPEEDS.map((n, i) => (
            <VehicleStat key={n} label={['LF', 'RF', 'LR', 'RR'][i]} value={fmt(ch[n], 1)} unit="" />
          ))}
        </div>
      </Panel>

      <Panel title="Brakes" className="lg:col-span-4">
        <div className="grid grid-cols-3 gap-2">
          <VehicleStat label="Front" value={fmt(ch['FBrakePressCorr'], 1)} unit="" />
          <VehicleStat label="Rear"  value={fmt(ch['RBrakePressCorr'], 1)} unit="" />
          <VehicleStat label="Bias"  value={fmt(ch['Brake_Bias'], 1)}      unit="" />
        </div>
        <p className="mt-2.5 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">LF rotor temp (CH1–4)</p>
        <div className="grid grid-cols-4 gap-2">
          {IC_BRAKE_TEMPS.map((n, i) => (
            <VehicleStat key={n} label={`CH${i + 1}`} value={fmt(ch[n], 1)} unit="°C" />
          ))}
        </div>
      </Panel>

      <Panel title="Tires · Electrical" className="lg:col-span-3">
        <div className="grid grid-cols-4 gap-2">
          {IC_TIRE_TEMPS.map((n, i) => (
            <VehicleStat key={n} label={`TC${i + 1}`} value={tireTemp(n)} unit="" />
          ))}
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <CoolStat
            label="Ext Voltage"
            value={fmt(ch['External Voltage'], 2)}
            unit="V"
            borderClass="border-[hsl(225,25%,85%)] dark:border-border/40"
          />
        </div>
      </Panel>

      <Panel title="Status" className="lg:col-span-12">
        <div className="flex flex-wrap gap-1.5">
          {IC_ENGINE_FLAGS.map((f) => {
            const v = ch[f.name];
            const on = v !== undefined && v >= 0.5;
            const tone =
              v === undefined
                ? 'border-border/40 text-muted-foreground/60'
                : on
                  ? f.kind === 'fault'
                    ? 'border-red-500/40 bg-red-500/10 text-red-500'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-border/40 text-muted-foreground';
            return (
              <span key={f.name} title={`${f.name} = ${v ?? '—'}`} className={`px-2 py-1 rounded-md border text-[10px] font-medium ${tone}`}>
                {f.label}
              </span>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="Other channels"
        className="lg:col-span-9"
        rightSlot={<span className="text-[10px] text-muted-foreground">channels not yet wired into a panel</span>}
      >
        {others.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No other channels in this snapshot.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
            {others.map(([name, val]) => (
              <div
                key={name}
                className="rounded-md bg-background/60 dark:bg-background/30 border border-[hsl(225,25%,85%)] dark:border-border/40 px-2 py-1.5"
              >
                <p className="text-[9px] uppercase tracking-wide text-muted-foreground truncate" title={name}>{name}</p>
                <p className="text-sm font-semibold tabular mt-0.5 text-foreground">{fmt(val, Math.abs(val) >= 100 ? 0 : 2)}</p>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Stream health" className="lg:col-span-3">
        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">History buffer</span>
            <span className="tabular font-semibold">{count} / {RING_BUFFER_SIZE}</span>
          </div>
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
          {Object.entries(bufferStats.bySubsystem).length === 0 && (
            <p className="text-[10px] text-muted-foreground/60">collecting…</p>
          )}
        </div>
      </Panel>
    </div>
  );
}
