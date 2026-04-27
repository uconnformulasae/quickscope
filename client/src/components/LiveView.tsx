import { useEffect, useRef, useState } from 'react';
import { liveWebSocketUrl, fetchLiveStatus, type LiveDeviceInfo, type LiveWSMessage } from '../lib/api';
import { Activity, AlertCircle, ArrowLeft, Pause, Play, Wifi, WifiOff, Loader2 } from 'lucide-react';

interface Props {
  onBack: () => void;
}

interface Snapshot {
  ts: number;
  subsystem: string;
  raw: string;
  channels?: Record<string, number>;  // populated in preview mode; real frames decode this client-side later
}

interface ChannelMeta {
  name: string;
  unit: string;
  /** rendering hint — how many decimals to show */
  precision: number;
}

const RING_BUFFER_SIZE = 240; // 60 s at ~4 Hz

// Channel metadata. Names match the EXACT names the AiM device publishes
// in its channel-config frame (verified against
// docs/protocol/captures/analysis/q6_full_records.py extraction of the
// 103-channel record list). When the real-device decoder lands, channels
// arrive in `snap.channels` keyed by exactly these names — no translation
// layer.
//
// Constants below are CT-17 EV: 100s4p pack, 5 modules of 20s4p, 4.15 V/
// cell ESF cap → pack max 415 V, nominal 370 V (per
// CT17_EV_Powertrain_Binder_Context).
const PACK_V_MAX = 415;
const PACK_V_NOMINAL = 370;
const PACK_TEMP_DERATE = 45;

const CHANNEL_META: ChannelMeta[] = [
  // Vehicle dynamics
  { name: 'RPM',                unit: 'rpm', precision: 0 },
  { name: 'LFspeed',            unit: 'kph', precision: 1 },
  { name: 'Throttle_Pos',       unit: '%',   precision: 0 },
  { name: 'BSE_Voltage',        unit: 'V',   precision: 2 },
  { name: 'Direction',          unit: '',    precision: 0 },
  { name: 'BrakeBias',          unit: '%',   precision: 1 },
  // IMU
  { name: 'LateralAcc',         unit: 'g',   precision: 2 },
  { name: 'InlineAcc',          unit: 'g',   precision: 2 },
  { name: 'VerticalAcc',        unit: 'g',   precision: 2 },
  { name: 'YawRate',            unit: '°/s', precision: 1 },
  { name: 'RollRate',           unit: '°/s', precision: 1 },
  { name: 'PitchRate',          unit: '°/s', precision: 1 },
  // Brake pressure
  { name: 'FrBrakePressure',    unit: 'psi', precision: 0 },
  { name: 'RBrkPressure',       unit: 'psi', precision: 0 },
  // Pack (Orion BMS aggregates — only what the live stream carries)
  { name: 'Pack_Voltage',       unit: 'V',   precision: 1 },
  { name: 'Pack_Current',       unit: 'A',   precision: 1 },
  { name: 'State_of_Charge',    unit: '%',   precision: 1 },
  { name: 'Pack_Temp',          unit: '°C',  precision: 1 },
  { name: 'Min_Cell_Voltage',   unit: 'V',   precision: 3 },
  { name: 'BMS_Disch_Lim',      unit: 'A',   precision: 0 },
  { name: 'BMS_Disch_Enable',   unit: '',    precision: 0 },
  { name: 'BMS_LV_input',       unit: 'V',   precision: 2 },
  // Motor + Inverter (Cascadia CM200DX → Emrax 228 LC)
  { name: 'Motor_Temp',         unit: '°C',  precision: 1 },
  { name: 'Torque_Command',     unit: 'Nm',  precision: 0 },
  { name: 'Torque_Feedback',    unit: 'Nm',  precision: 0 },
  { name: 'MCU_Torque_Limit',   unit: 'Nm',  precision: 0 },
  { name: 'MCU_DC_Current',     unit: 'A',   precision: 1 },
  { name: 'Phase_A_Current',    unit: 'A',   precision: 0 },
  { name: 'Phase_B_Current',    unit: 'A',   precision: 0 },
  { name: 'Phase_C_Current',    unit: 'A',   precision: 0 },
  { name: 'Id_Feeback',         unit: 'A',   precision: 0 },
  { name: 'Iq_Feedback',        unit: 'A',   precision: 0 },
  { name: 'InverterEnable',     unit: '',    precision: 0 },
  // External voltages / logger
  { name: 'External Voltage',   unit: 'V',   precision: 2 },
  { name: 'Logger Temperature', unit: '°C',  precision: 1 },
  // GPS (channel #13, 56-byte struct at offset 168 of the live frame)
  { name: 'GPS_Lat',            unit: '°',   precision: 6 },
  { name: 'GPS_Lon',            unit: '°',   precision: 6 },
  { name: 'GPS_Speed',          unit: 'kph', precision: 1 },
  { name: 'GPS_Heading',        unit: '°',   precision: 1 },
  { name: 'GPS_Altitude',       unit: 'm',   precision: 1 },
  { name: 'GPS_Sats',           unit: '',    precision: 0 },
];

// Boolean / state channels from the AiM channel-config. Each carries 0/1
// on the wire — meaningless as a number, very meaningful as a label.
// Polarity differs by channel: for "state" 1 = enabled (green); for
// "fault" 1 = active fault (red).
type BoolKind = 'state' | 'fault';
interface BoolChannelMeta {
  name: string;
  label: string;
  kind: BoolKind;
}
const BOOL_CHANNELS: BoolChannelMeta[] = [
  // Enable / state (1 = active / good)
  { name: 'BMS_Disch_Enable',   label: 'BMS Discharge',  kind: 'state' },
  { name: 'InverterEnable',     label: 'Inverter',       kind: 'state' },
  { name: 'lc_enabled',         label: 'Launch Control', kind: 'state' },
  { name: 'lc_sensor_health',   label: 'LC Sensors OK',  kind: 'state' },
  { name: 'cut_rate_active',    label: 'Cut-rate Active',kind: 'state' },
  { name: 'StartRec',           label: 'Logging',        kind: 'state' },
  // Faults (1 = fault active / BAD)
  { name: 'RTD_Fault',           label: 'RTD',                 kind: 'fault' },
  { name: 'BSE_Fault',           label: 'BSE Plausibility',    kind: 'fault' },
  { name: 'TPS1_OOR_Fault',      label: 'TPS1 Out of Range',   kind: 'fault' },
  { name: 'TPS2_OOR_Fault',      label: 'TPS2 Out of Range',   kind: 'fault' },
  { name: 'APPS_Dist_Fault',     label: 'APPS Plausibility',   kind: 'fault' },
  { name: 'DC_Undervoltage',     label: 'DC Undervoltage',     kind: 'fault' },
  { name: 'InverterTempHi',      label: 'Inverter Temp Hi',    kind: 'fault' },
  { name: 'InverterTempLo',      label: 'Inverter Temp Lo',    kind: 'fault' },
  { name: 'MCU_LV_Out_of_Range', label: 'MCU LV OOR',          kind: 'fault' },
  { name: 'MotorOverTemp',       label: 'Motor Over Temp',     kind: 'fault' },
  { name: 'MotorOverSpeed',      label: 'Motor Over Speed',    kind: 'fault' },
  { name: 'InvOverVolt',         label: 'Inverter OverVolt',   kind: 'fault' },
  { name: 'HWOverCurrent',       label: 'HW Over Current',     kind: 'fault' },
  { name: 'CANCommandLost',      label: 'CAN Cmd Lost',        kind: 'fault' },
];

// CT-17 has 5 modules of 20s4p (80 cells/module). Per-module data is NOT
// in the AiM live stream — Orion BMS broadcasts pack-level aggregates only
// (Pack_Voltage, Pack_Temp, Min_Cell_Voltage, SOC). The Accumulator panel
// is structured around those plus BMS state channels.
const NUM_MODULES = 5;

// Channels rendered by an explicit panel. The "Other" panel filters
// everything NOT in this set so newly-added device channels (e.g. the ~70
// fault/alarm bits, launch-control telemetry, lap timing) appear
// automatically without layout edits.
const PANEL_OWNED_CHANNELS = new Set<string>([
  // Pack hero
  'Pack_Voltage', 'Pack_Current', 'State_of_Charge',
  // Accumulator (Orion-exposed)
  'Pack_Temp', 'Min_Cell_Voltage', 'BMS_Disch_Lim', 'BMS_Disch_Enable', 'BMS_LV_input',
  // Cooling
  'Motor_Temp',
  // Vehicle dynamics
  'Throttle_Pos', 'BSE_Voltage', 'LFspeed', 'RPM', 'YawRate', 'RollRate', 'PitchRate',
  'LateralAcc', 'InlineAcc', 'VerticalAcc',
  'FrBrakePressure', 'RBrkPressure', 'BrakeBias', 'Direction',
  // Inverter / motor
  'Torque_Command', 'Torque_Feedback', 'MCU_Torque_Limit', 'MCU_DC_Current',
  'Phase_A_Current', 'Phase_B_Current', 'Phase_C_Current',
  'Id_Feeback', 'Iq_Feedback', 'InverterEnable',
  // GPS (rendered in the Track panel)
  'GPS_Lat', 'GPS_Lon', 'GPS_Speed', 'GPS_Heading', 'GPS_Altitude', 'GPS_Sats',
  // Boolean state + fault channels (rendered in the Status & Faults panel)
  ...BOOL_CHANNELS.map((b) => b.name),
]);

type Status = 'idle' | 'probing' | 'connecting' | 'streaming' | 'paused' | 'error';

export function LiveView({ onBack }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [device, setDevice] = useState<LiveDeviceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [count, setCount] = useState(0);
  const [bufferStats, setBufferStats] = useState({ bySubsystem: {} as Record<string, number> });
  const [gpsTrail, setGpsTrail] = useState<{ lat: number; lon: number; speed: number }[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const ringRef = useRef<Snapshot[]>([]);
  const gpsTrailRef = useRef<{ lat: number; lon: number; speed: number }[]>([]);
  const pausedRef = useRef(false);
  // Once the user has clicked Connect, the mount-time UDP probe's late-
  // arriving response must not clobber state.
  const connectInitiatedRef = useRef(false);

  useEffect(() => {
    setStatus('probing');
    fetchLiveStatus()
      .then(s => {
        if (connectInitiatedRef.current) return;
        if (s.reachable && s.device) {
          setDevice(s.device);
          setStatus('idle');
        } else {
          setStatus('error');
          setError(`AiM device not reachable at ${s.host}. Connect to the device's WiFi hotspot first.`);
        }
      })
      .catch(err => {
        if (connectInitiatedRef.current) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const connect = () => {
    if (wsRef.current) return;
    connectInitiatedRef.current = true;
    setStatus('connecting');
    setError(null);
    const ws = new WebSocket(liveWebSocketUrl());
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg: LiveWSMessage = JSON.parse(event.data);
        if (msg.type === 'connected') {
          setDevice(msg.device);
          setStatus('streaming');
        } else if (msg.type === 'snapshot') {
          if (pausedRef.current) return;
          const snap: Snapshot = { ts: msg.ts, subsystem: msg.subsystem, raw: msg.raw };
          ringRef.current.push(snap);
          if (ringRef.current.length > RING_BUFFER_SIZE) {
            ringRef.current.shift();
          }
          // GPS trail — once channel decoding lands, snap.channels.GPS_Lat
          // / GPS_Lon arrive here and we append. Until then there are no
          // GPS points and the Track panel shows the "waiting for fix"
          // empty state.
          const lat = snap.channels?.['GPS_Lat'];
          const lon = snap.channels?.['GPS_Lon'];
          if (lat !== undefined && lon !== undefined && Math.abs(lat) > 0.1 && Math.abs(lon) > 0.1) {
            gpsTrailRef.current.push({ lat, lon, speed: snap.channels?.['GPS_Speed'] ?? 0 });
            if (gpsTrailRef.current.length > 2000) {
              gpsTrailRef.current.shift();
            }
          }
          setLatest(snap);
          setCount(ringRef.current.length);
          if (ringRef.current.length % 8 === 0) {
            const bySubsystem: Record<string, number> = {};
            for (const s of ringRef.current) {
              bySubsystem[s.subsystem] = (bySubsystem[s.subsystem] || 0) + 1;
            }
            setBufferStats({ bySubsystem });
            setGpsTrail([...gpsTrailRef.current]);
          }
        } else if (msg.type === 'error') {
          setStatus('error');
          setError(msg.message);
        }
      } catch {
        // ignore non-JSON
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setError('WebSocket connection failed');
    };

    ws.onclose = () => {
      wsRef.current = null;
      setStatus(prev => (prev === 'error' ? 'error' : 'idle'));
    };
  };

  const disconnect = () => {
    wsRef.current?.send('stop');
    wsRef.current?.close();
    wsRef.current = null;
    ringRef.current = [];
    gpsTrailRef.current = [];
    setCount(0);
    setLatest(null);
    setBufferStats({ bySubsystem: {} });
    setGpsTrail([]);
    setStatus('idle');
  };

  const exportGpx = () => {
    if (gpsTrailRef.current.length === 0) return;
    const now = new Date().toISOString();
    const points = gpsTrailRef.current
      .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"></trkpt>`)
      .join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="QuickScope" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><time>${now}</time></metadata>
  <trk>
    <name>QuickScope Live</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quickscope-live-${now.replace(/[:.]/g, '-')}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setStatus(pausedRef.current ? 'paused' : 'streaming');
  };

  const isLive = status === 'streaming' || status === 'paused';

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* Header — mirrors SessionBrowser */}
      <header className="flex items-center gap-3 px-4 h-12 border-b border-border bg-card flex-shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          title="Back to session browser"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Activity className="w-4 h-4 text-primary" />
        <h1 className="text-sm font-semibold">Live data</h1>

        <div className="flex-1" />

        {/* Device pill */}
        {device && (
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">AiM {device.model}</span>
            {device.serial && <span className="text-muted-foreground/50">·</span>}
            {device.serial && <span className="font-mono">{device.serial}</span>}
            {device.vehicle && <span className="text-muted-foreground/50">·</span>}
            {device.vehicle && <span>{device.vehicle}</span>}
          </div>
        )}

        {/* Status indicator */}
        <div className="flex items-center gap-1.5 text-xs">
          {status === 'streaming' && (
            <span className="flex items-center gap-1.5 text-emerald-500 dark:text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse" />
              Streaming
            </span>
          )}
          {status === 'paused' && (
            <span className="flex items-center gap-1.5 text-amber-500 dark:text-amber-400">
              <Pause className="w-3 h-3" />
              Paused
            </span>
          )}
          {status === 'connecting' && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Connecting
            </span>
          )}
          {status === 'probing' && (
            <span className="flex items-center gap-1.5 text-muted-foreground/50">
              <Loader2 className="w-3 h-3 animate-spin" />
              Probing
            </span>
          )}
        </div>
      </header>

      {/* Action bar — mirrors SessionBrowser */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-card/50">
        {!isLive ? (
          <button
            onClick={connect}
            disabled={status === 'connecting' || status === 'probing'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
          >
            <Wifi className="w-3.5 h-3.5" />
            Connect
          </button>
        ) : (
          <>
            <button
              onClick={togglePause}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-muted/50 text-foreground hover:bg-muted transition-colors"
            >
              {status === 'paused' ? <><Play className="w-3.5 h-3.5" /> Resume</> : <><Pause className="w-3.5 h-3.5" /> Pause</>}
            </button>
            <button
              onClick={disconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-red-500/10 text-red-500 dark:text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <WifiOff className="w-3.5 h-3.5" />
              Disconnect
            </button>
          </>
        )}

        <div className="flex-1" />

        {isLive && (
          <span className="text-xs text-muted-foreground tabular">
            {count} / {RING_BUFFER_SIZE} frames buffered
          </span>
        )}
      </div>

      <main className="flex-1 overflow-auto">
        {status === 'error' && error && (
          <div className="max-w-2xl mx-auto mt-6 px-4">
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs flex-1">
                <p className="font-medium text-red-500 dark:text-red-400">Connection error</p>
                <p className="text-muted-foreground mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}

        {isLive && (
          <div className="p-3 space-y-3">
            <Dashboard
              latest={latest}
              count={count}
              bufferStats={bufferStats}
              gpsTrail={gpsTrail}
              onExportGpx={exportGpx}
            />
          </div>
        )}

        {status === 'idle' && !error && (
          <div className="max-w-md mx-auto text-center mt-16 px-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mb-3">
              <Wifi className="w-5 h-5 text-primary" />
            </div>
            <p className="text-sm text-foreground font-medium mb-1">
              {device ? `Ready to connect to ${device.vehicle || 'AiM device'}` : 'Connect to AiM device'}
            </p>
            <p className="text-xs text-muted-foreground">
              {device
                ? `${device.model} ${device.serial} reachable at ${device.ip}.`
                : 'Connect to the AiM device WiFi hotspot, then click Connect.'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Dashboard — multi-panel telemetry layout. Modeled on Athena's pit-side
// view (Accumulator / Cooling / Vehicle Overview / PDU / Buffer composition)
// but rendered in QuickScope's own design tokens so it feels like one app.
// Each Panel uses the same card chrome as SessionBrowser rows:
//   bg-[hsl(225,30%,95%)] dark:bg-card / border-[hsl(225,25%,85%)] dark:border-border/50
// ────────────────────────────────────────────────────────────────────────────

function Dashboard({
  latest,
  count,
  bufferStats,
  gpsTrail,
  onExportGpx,
}: {
  latest: Snapshot | null;
  count: number;
  bufferStats: { bySubsystem: Record<string, number> };
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
          channels in the live stream. Display the structural breakdown so
          users know it's 5 modules × 20s4p, but data is pack-aggregate. */}
      <Panel title={`Accumulator · ${NUM_MODULES} modules · 20s4p each`} className="lg:col-span-5">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <CoolStat label="Pack Voltage"  value={fmt(ch['Pack_Voltage'], 1)}      unit="V"  borderClass="border-emerald-500/40" />
          <CoolStat label="Pack Temp"     value={fmt(ch['Pack_Temp'], 1)}         unit="°C" borderClass={ (ch['Pack_Temp'] ?? 0) > PACK_TEMP_DERATE ? 'border-red-500/60' : 'border-emerald-500/40' } />
          <CoolStat label="Min Cell V"    value={fmt(ch['Min_Cell_Voltage'], 3)}  unit="V"  borderClass="border-emerald-500/40" />
          <CoolStat label="BMS LV"        value={fmt(ch['BMS_LV_input'], 2)}      unit="V"  borderClass="border-emerald-500/40" />
        </div>
        {/* Module structural map — visual reminder that there are 5
            segments even though we only get aggregate data. Each block
            renders the pack voltage divided by 5 (estimated per-module
            average) and the single Pack_Temp value. */}
        <div className="grid grid-cols-5 gap-1">
          {Array.from({ length: NUM_MODULES }, (_, i) => {
            const avgV = (ch['Pack_Voltage'] ?? 0) / NUM_MODULES;
            const t = ch['Pack_Temp'] ?? 0;
            return (
              <div
                key={i}
                className="rounded border border-emerald-500/25 bg-emerald-500/5 px-1.5 py-1.5 text-center"
                title={`Module ${i + 1} of ${NUM_MODULES} · 20s4p · estimated avg from pack aggregate`}
              >
                <p className="text-[9px] uppercase tracking-wide text-muted-foreground">M{i + 1}</p>
                <p className="text-xs font-bold tabular text-emerald-600 dark:text-emerald-400 mt-0.5">~{avgV.toFixed(0)}V</p>
                <p className="text-[9px] text-muted-foreground tabular">{t.toFixed(0)}°C</p>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-muted-foreground/60 mt-2 leading-snug">
          Per-module voltages aren't broadcast on the AiM live stream — Orion BMS
          only exposes pack aggregates. Module values shown are <span className="font-medium">estimates</span> (Pack ÷ {NUM_MODULES}).
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
            <div className="flex items-center justify-between text-[10px] mb-1">
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">THR {fmt(ch['Throttle_Pos'], 0)}%</span>
              <span className="text-red-500 dark:text-red-400 font-medium">
                FR/RR {fmt(ch['FrBrakePressure'], 0)}/{fmt(ch['RBrkPressure'], 0)}
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
            <VehicleStat label="Lat G"  value={fmt(ch['LateralAcc'], 2)} unit="g" />
            <VehicleStat label="Long G" value={fmt(ch['InlineAcc'], 2)}  unit="g" />
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
            <span className="text-muted-foreground">Frames</span>
            <span className="tabular font-semibold">{count} / {RING_BUFFER_SIZE}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Latest ts</span>
            <span className="tabular font-semibold">{latest ? `${(latest.ts / 1000).toFixed(2)}s` : '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Subsystem</span>
            <span className="font-mono font-semibold">{latest?.subsystem || '—'}</span>
          </div>
          <div className="pt-1.5 border-t border-border/40 space-y-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Buffer composition</p>
            {Object.entries(bufferStats.bySubsystem).length === 0 && (
              <p className="text-[10px] text-muted-foreground/60">collecting…</p>
            )}
            {Object.entries(bufferStats.bySubsystem).map(([subsystem, n]) => (
              <div key={subsystem} className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground w-12 truncate">{subsystem}</span>
                <div className="flex-1 h-1 bg-muted/50 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full"
                    style={{ width: `${(n / Math.max(1, count)) * 100}%` }}
                  />
                </div>
                <span className="tabular text-muted-foreground w-7 text-right">{n}</span>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function fmt(v: number | undefined, precision: number): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(precision);
}

function Panel({
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

function BigStat({
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

function CoolStat({
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

function VehicleStat({ label, value, unit }: { label: string; value: string; unit: string }) {
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

function TrackCanvas({
  trail,
  latest,
}: {
  trail: { lat: number; lon: number; speed: number }[];
  latest: Snapshot | null;
}) {
  // Empty state — no GPS points yet.
  if (trail.length < 2) {
    return (
      <div
        className="rounded-md bg-muted/30 dark:bg-background/40 border border-border/40 flex items-center justify-center text-[11px] text-muted-foreground"
        style={{ aspectRatio: '1 / 1', minHeight: 160 }}
      >
        Waiting for GPS fix…
      </div>
    );
  }

  // Bounds + aspect-correction (lon shrinks as lat moves away from equator).
  const minLat = Math.min(...trail.map((p) => p.lat));
  const maxLat = Math.max(...trail.map((p) => p.lat));
  const minLon = Math.min(...trail.map((p) => p.lon));
  const maxLon = Math.max(...trail.map((p) => p.lon));
  const midLat = (minLat + maxLat) / 2;
  const lonM = (maxLon - minLon) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const latM = (maxLat - minLat) * 111_320;
  const span = Math.max(lonM, latM) || 1;

  const VB = 200;  // viewBox size — coords scale into [0..VB]
  const project = (lat: number, lon: number) => {
    const xM = (lon - minLon) * 111_320 * Math.cos((midLat * Math.PI) / 180);
    const yM = (lat - minLat) * 111_320;
    const cx = (span - lonM) / 2;
    const cy = (span - latM) / 2;
    const x = ((xM + cx) / span) * VB;
    const y = VB - ((yM + cy) / span) * VB;  // SVG y grows downward
    return [x, y] as const;
  };

  const path = trail
    .map((p, i) => {
      const [x, y] = project(p.lat, p.lon);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  const [sx, sy] = project(trail[0].lat, trail[0].lon);
  const [cx, cy] = project(trail[trail.length - 1].lat, trail[trail.length - 1].lon);
  const heading = latest?.channels?.['GPS_Heading'] ?? 0;

  return (
    <div
      className="rounded-md bg-muted/30 dark:bg-background/40 border border-border/40 overflow-hidden"
      style={{ aspectRatio: '1 / 1', minHeight: 160 }}
    >
      <svg viewBox={`0 0 ${VB} ${VB}`} width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-primary"
        />
        {/* Start marker */}
        <circle cx={sx} cy={sy} r={2.5} className="fill-emerald-500" />
        {/* Current position with heading triangle */}
        <g transform={`translate(${cx}, ${cy}) rotate(${heading})`}>
          <polygon points="0,-5 4,4 0,2 -4,4" className="fill-amber-500 stroke-amber-700" strokeWidth={0.5} />
        </g>
      </svg>
    </div>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-[hsl(225,30%,95%)] dark:bg-card border border-[hsl(225,25%,85%)] dark:border-border/50 px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-base font-semibold mt-0.5 ${mono ? 'font-mono' : 'tabular'}`}>{value}</p>
    </div>
  );
}
