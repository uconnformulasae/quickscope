import { type Snapshot, PACK_V_MAX, PACK_V_NOMINAL, PACK_TEMP_DERATE, CHANNEL_META, BOOL_CHANNELS, NUM_MODULES, PANEL_OWNED_CHANNELS } from './live-channels';
import { fmt, directionLabel, Panel, BigStat, CoolStat, VehicleStat } from './widgets';
import { TrackCanvas } from './TrackCanvas';

// ────────────────────────────────────────────────────────────────────────────
// Dashboard — multi-panel telemetry layout. Modeled on Athena's pit-side
// view (Accumulator / Cooling / Vehicle Overview / PDU / Buffer composition)
// but rendered in QuickScope's own design tokens so it feels like one app.
// Each Panel uses the same card chrome as SessionBrowser rows:
//   bg-[hsl(225,30%,95%)] dark:bg-card / border-[hsl(225,25%,85%)] dark:border-border/50
// ────────────────────────────────────────────────────────────────────────────

export function EVDashboard({
  latest,
  totalReceived,
  gpsTrail,
  onExportGpx,
}: {
  latest: Snapshot | null;
  totalReceived: number;
  gpsTrail: { lat: number; lon: number; speed: number }[];
  onExportGpx: () => void;
}) {
  const ch = latest?.channels ?? {};
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 max-w-[1600px] mx-auto">
      {/* TOP STRIP — pack-level summary. CT-17 nominal 370 V / max 415 V. */}
      <Panel title="Pack · 100s4p · max 415 V" className="lg:col-span-12" tone="primary">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <BigStat label="Pack Voltage" value={fmt(ch['Pack_Voltage'], 1)}     unit="V"  tone="primary" />
          <BigStat label="Pack Current" value={fmt(ch['Pack_Current'], 1)}     unit="A"  tone="primary" />
          <BigStat label="SOC"          value={fmt(ch['State_of_Charge'], 1)}  unit="%"  tone="emerald" />
          <BigStat
            label="Pack Power"
            value={fmt(((ch['Pack_Voltage'] ?? 0) * (ch['Pack_Current'] ?? 0)) / 1000, 1)}
            unit="kW"
            tone="amber"
          />
        </div>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-muted-foreground">
          <span>Max V <span className="tabular text-foreground">{PACK_V_MAX}</span> · Nom <span className="tabular text-foreground">{PACK_V_NOMINAL}</span></span>
          <span>I limit <span className="tabular text-foreground">{fmt(ch['BMS_Disch_Lim'], 0)}</span> A</span>
          <span>Min cell V <span className="tabular text-foreground">{fmt(ch['Min_Cell_Voltage'], 3)}</span></span>
          <span>Disch <span className={`tabular ${ch['BMS_Disch_Enable'] ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
            {ch['BMS_Disch_Enable'] ? 'ENABLED' : 'DISABLED'}
          </span></span>
        </div>
      </Panel>

      {/* Accumulator — Orion broadcasts pack-level only; no per-module
          channels in the live stream, so only pack aggregates are shown. */}
      <Panel title={`Accumulator · ${NUM_MODULES} modules · 20s4p each`} className="lg:col-span-5">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <CoolStat label="Pack Voltage"  value={fmt(ch['Pack_Voltage'], 1)}      unit="V"  borderClass="border-emerald-500/40" />
          <CoolStat label="Pack Temp"     value={fmt(ch['Pack_Temp'], 1)}         unit="°C" borderClass={ (ch['Pack_Temp'] ?? 0) > PACK_TEMP_DERATE ? 'border-red-500/60' : 'border-emerald-500/40' } />
          <CoolStat label="Min Cell V"    value={fmt(ch['Min_Cell_Voltage'], 3)}  unit="V"  borderClass="border-emerald-500/40" />
          <CoolStat label="BMS LV"        value={fmt(ch['BMS_LV_input'], 2)}      unit="V"  borderClass="border-emerald-500/40" />
        </div>
        <p className="text-[10px] text-muted-foreground/60 leading-snug">
          Per-module voltages aren't broadcast on the AiM live stream — Orion BMS
          only exposes pack aggregates, so only those are shown.
        </p>
      </Panel>

      <Panel title="Cooling" className="lg:col-span-4">
        <div className="grid grid-cols-2 gap-2">
          <CoolStat label="Motor Temp" value={fmt(ch['Motor_Temp'], 1)}  unit="°C" borderClass="border-emerald-500/40" />
          <CoolStat label="Pack Temp"  value={fmt(ch['Pack_Temp'], 1)}   unit="°C" borderClass={ (ch['Pack_Temp'] ?? 0) > PACK_TEMP_DERATE ? 'border-red-500/60' : 'border-cyan-500/40' } />
          <CoolStat label="Logger"     value={fmt(ch['Logger Temperature'], 1)} unit="°C" borderClass="border-muted-foreground/30" />
          <CoolStat label="Ambient"    value="—"                          unit=""   borderClass="border-muted-foreground/30" />
        </div>
        <p className="text-[10px] text-muted-foreground/60 mt-2 leading-snug">
          AiM live stream exposes <span className="font-medium">Motor_Temp</span> and <span className="font-medium">Pack_Temp</span> as the only thermal readings.
          Inverter/coolant/pump telemetry runs on the Cascadia/PMC CAN bus
          (not bridged into AiM logging in this firmware).
        </p>
      </Panel>

      {/* Vehicle dynamics. Channel names match AiM exactly. */}
      <Panel title="Vehicle" className="lg:col-span-3">
        <div className="space-y-2.5">
          {/* Throttle / Brake bar */}
          <div>
            <div className="flex items-center justify-between text-[10px] mb-1 gap-2">
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">THR {fmt(ch['Throttle_Pos'], 0)}%</span>
              <span className="text-emerald-600/80 dark:text-emerald-400/80 font-medium">
                TPS1 {fmt(ch['TPS_1'], 1)}% · TPS2 {fmt(ch['TPS_2'], 1)}%
              </span>
              <span className="text-red-500 dark:text-red-400 font-medium shrink-0">
                FR/RR {fmt(ch['FrBrakePressure'], 0)}/{fmt(ch['RBrkPressure'], 0)}
                <span className="text-muted-foreground font-normal"> · Bias {fmt(ch['BrakeBias'], 1)}%</span>
              </span>
            </div>
            <div className="flex gap-0.5 h-1.5">
              <div className="flex-1 bg-muted/50 rounded-l-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-l-full" style={{ width: `${ch['Throttle_Pos'] ?? 0}%` }} />
              </div>
              <div className="flex-1 bg-muted/50 rounded-r-full overflow-hidden">
                <div className="h-full bg-red-500 rounded-r-full ml-auto" style={{ width: `${Math.min(100, (ch['FrBrakePressure'] ?? 0) / 8)}%` }} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <VehicleStat label="Speed"  value={fmt(ch['LFspeed'], 0)}  unit="kph" />
            <VehicleStat label="RPM"    value={fmt(ch['RPM'], 0)}      unit="" />
            <VehicleStat label="Yaw"    value={fmt(ch['YawRate'], 1)}  unit="°/s" />
            <VehicleStat label="Roll"   value={fmt(ch['RollRate'], 1)} unit="°/s" />
            <VehicleStat label="Pitch"  value={fmt(ch['PitchRate'], 1)} unit="°/s" />
            <VehicleStat label="Lat G"  value={fmt(ch['LateralAcc'], 2)} unit="g" />
            <VehicleStat label="Long G" value={fmt(ch['InlineAcc'], 2)}  unit="g" />
            <VehicleStat label="Vert G" value={fmt(ch['VerticalAcc'], 2)} unit="g" />
            <VehicleStat label="BSE"    value={fmt(ch['BSE_Voltage'], 2)} unit="V" />
            <VehicleStat label="Dir"    value={directionLabel(ch['Direction'])} unit="" />
          </div>
        </div>
      </Panel>

      {/* MID STRIP — Track (live GPS path) + Status & Faults */}
      <Panel
        title="Track"
        className="lg:col-span-6"
        rightSlot={
          <button
            onClick={onExportGpx}
            disabled={gpsTrail.length === 0}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:hover:bg-primary/10 transition-colors"
            title={gpsTrail.length === 0 ? 'No GPS points yet' : `Download ${gpsTrail.length} points as GPX`}
          >
            Export GPX
          </button>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <TrackCanvas trail={gpsTrail} latest={latest} />
          <div className="space-y-2 text-xs">
            <div className="grid grid-cols-2 gap-1.5">
              <VehicleStat label="Lat"      value={fmt(ch['GPS_Lat'], 5)} unit="°" />
              <VehicleStat label="Lon"      value={fmt(ch['GPS_Lon'], 5)} unit="°" />
              <VehicleStat label="Speed"    value={fmt(ch['GPS_Speed'], 1)} unit="kph" />
              <VehicleStat label="Heading"  value={fmt(ch['GPS_Heading'], 0)} unit="°" />
              <VehicleStat label="Altitude" value={fmt(ch['GPS_Altitude'], 1)} unit="m" />
              <VehicleStat label="Sats"     value={fmt(ch['GPS_Sats'], 0)} unit="" />
            </div>
            <div className="pt-1.5 border-t border-border/40 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Trail points</span>
              <span className="tabular font-semibold text-foreground">{gpsTrail.length}</span>
            </div>
            <p className="text-[10px] text-muted-foreground/60 leading-snug">
              Trail accumulates while connected (up to 2000 points / ~8 min at
              4 Hz). Export drops a .gpx file you can drop into the session
              browser later.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="Status & Faults" className="lg:col-span-6">
        <div className="space-y-3">
          {/* State row — colored ON/OFF pills */}
          <div>
            <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">State</h4>
            <div className="grid grid-cols-3 sm:grid-cols-3 gap-1.5">
              {BOOL_CHANNELS.filter((b) => b.kind === 'state').map((b) => {
                const v = ch[b.name];
                const on = v === 1;
                return (
                  <div
                    key={b.name}
                    className={`flex items-center justify-between rounded-md px-2 py-1.5 border text-[11px] ${
                      on
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                        : 'bg-muted/40 border-border/40 text-muted-foreground'
                    }`}
                    title={`${b.name} = ${v ?? '—'} (1 = on, 0 = off)`}
                  >
                    <span className="font-medium truncate">{b.label}</span>
                    <span className="font-mono ml-2">{on ? 'ON' : 'OFF'}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Fault row — green dot when 0, red when 1 */}
          <div>
            <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center justify-between">
              <span>Faults</span>
              <span className="text-muted-foreground/60 font-normal normal-case">
                1 = active fault · 0 = healthy
              </span>
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {BOOL_CHANNELS.filter((b) => b.kind === 'fault').map((b) => {
                const v = ch[b.name];
                const fault = v === 1;
                return (
                  <div
                    key={b.name}
                    className={`flex items-center gap-1.5 rounded-md px-2 py-1 border text-[10px] ${
                      fault
                        ? 'bg-red-500/10 border-red-500/40 text-red-600 dark:text-red-400'
                        : 'bg-emerald-500/5 border-emerald-500/20 text-muted-foreground'
                    }`}
                    title={`${b.name} = ${v ?? '—'}`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        fault ? 'bg-red-500 animate-pulse' : 'bg-emerald-500/60'
                      }`}
                    />
                    <span className="truncate">{b.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Panel>

      {/* BOTTOM STRIP — uncategorized channels (auto-fallback) */}
      <Panel
        title="Other channels"
        className="lg:col-span-9"
        rightSlot={
          <span className="text-[10px] text-muted-foreground">
            channels not yet wired into a panel
          </span>
        }
      >
        {(() => {
          const otherEntries = Object.entries(ch).filter(
            ([name]) => !PANEL_OWNED_CHANNELS.has(name),
          );
          if (otherEntries.length === 0) {
            return (
              <p className="text-[11px] text-muted-foreground/60">
                No other channels in this snapshot. New channels added to the device's
                channel-config will appear here automatically.
              </p>
            );
          }
          // Sort alphabetically so the panel is stable across renders.
          otherEntries.sort(([a], [b]) => a.localeCompare(b));
          return (
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
              {otherEntries.map(([name, val]) => {
                // Try to find an explicit precision; fall back to a sensible default.
                const meta = CHANNEL_META.find((m) => m.name === name);
                const precision = meta?.precision ?? (Math.abs(val) >= 100 ? 0 : 2);
                const unit = meta?.unit ?? '';
                return (
                  <div
                    key={name}
                    className="rounded-md bg-background/60 dark:bg-background/30 border border-[hsl(225,25%,85%)] dark:border-border/40 px-2 py-1.5"
                  >
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground truncate" title={name}>
                      {name}
                    </p>
                    <p className="text-sm font-semibold tabular mt-0.5 text-foreground">
                      {fmt(val, precision)}
                      {unit && <span className="text-[9px] text-muted-foreground font-normal ml-1">{unit}</span>}
                    </p>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </Panel>

      <Panel title="Stream health" className="lg:col-span-3">
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
      </Panel>
    </div>
  );
}
