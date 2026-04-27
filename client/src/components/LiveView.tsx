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
  /** value generator from the integer frame number */
  gen: (frameNo: number) => number;
}

const RING_BUFFER_SIZE = 240; // 60 s at ~4 Hz

// Subset of the 103-channel EVO5 map (extracted from the channel-def frame
// in the deep-dive). Used by preview mode to drive realistic-looking
// values across the dashboard so users can see what live streaming will
// look like without an actual device on the network.
const PREVIEW_CHANNELS: ChannelMeta[] = [
  { name: 'RPM',           unit: 'rpm', precision: 0, gen: (n) => 4500 + Math.sin(n * 0.08) * 1500 + Math.sin(n * 0.31) * 500 },
  { name: 'Speed',         unit: 'kph', precision: 1, gen: (n) => 60 + Math.sin(n * 0.05) * 35 + Math.sin(n * 0.21) * 8 },
  { name: 'Throttle',      unit: '%',   precision: 1, gen: (n) => 50 + Math.sin(n * 0.07) * 45 },
  { name: 'Brake',         unit: '%',   precision: 1, gen: (n) => Math.max(0, -Math.sin(n * 0.07) * 80) },
  { name: 'Pack Voltage',  unit: 'V',   precision: 1, gen: (n) => 405 - Math.abs(Math.sin(n * 0.05)) * 40 },
  { name: 'Pack Temp',     unit: '°C',  precision: 1, gen: (n) => 28 + n * 0.001 + Math.sin(n * 0.02) * 1.5 },
  { name: 'Motor Temp',    unit: '°C',  precision: 1, gen: (n) => 65 + Math.abs(Math.sin(n * 0.08)) * 35 },
  { name: 'SOC',           unit: '%',   precision: 1, gen: (n) => Math.max(0, 85 - n * 0.005) },
  { name: 'Lat G',         unit: 'g',   precision: 2, gen: (n) => Math.sin(n * 0.13) * 1.4 },
  { name: 'Long G',        unit: 'g',   precision: 2, gen: (n) => Math.sin(n * 0.07) * 1.1 - 0.1 },
];

function generatePreviewChannels(frameNo: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ch of PREVIEW_CHANNELS) {
    out[ch.name] = ch.gen(frameNo);
  }
  return out;
}

function formatChannelValue(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(precision);
}

type Status = 'idle' | 'probing' | 'connecting' | 'streaming' | 'paused' | 'error';

const SUBSYSTEMS_PREVIEW = ['kkk', 'Syst', 'Fuel'] as const;

export function LiveView({ onBack }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [device, setDevice] = useState<LiveDeviceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [count, setCount] = useState(0);
  const [bufferStats, setBufferStats] = useState({ bySubsystem: {} as Record<string, number> });
  const [previewMode, setPreviewMode] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const ringRef = useRef<Snapshot[]>([]);
  const pausedRef = useRef(false);

  useEffect(() => {
    setStatus('probing');
    fetchLiveStatus()
      .then(s => {
        if (s.reachable && s.device) {
          setDevice(s.device);
          setStatus('idle');
        } else {
          setStatus('error');
          setError(`AiM device not reachable at ${s.host}. Connect to the device's WiFi hotspot first.`);
        }
      })
      .catch(err => {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      wsRef.current?.close();
      wsRef.current = null;
      if (previewTimerRef.current !== null) {
        window.clearInterval(previewTimerRef.current);
        previewTimerRef.current = null;
      }
    };
  }, []);

  const connect = () => {
    if (wsRef.current) return;
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
          setLatest(snap);
          setCount(ringRef.current.length);
          if (ringRef.current.length % 8 === 0) {
            const bySubsystem: Record<string, number> = {};
            for (const s of ringRef.current) {
              bySubsystem[s.subsystem] = (bySubsystem[s.subsystem] || 0) + 1;
            }
            setBufferStats({ bySubsystem });
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
    setCount(0);
    setLatest(null);
    setBufferStats({ bySubsystem: {} });
    setStatus('idle');
  };

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setStatus(pausedRef.current ? 'paused' : 'streaming');
  };

  const startPreview = () => {
    if (previewTimerRef.current !== null) return;
    // Tear down any in-flight WebSocket *and* its callbacks before starting
    // preview. Otherwise a pending ws.onclose (e.g. from a failed Connect a
    // moment ago) will fire after we set status='streaming' and clobber it
    // back to 'idle'.
    if (wsRef.current) {
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    ringRef.current = [];
    pausedRef.current = false;
    setCount(0);
    setLatest(null);
    setBufferStats({ bySubsystem: {} });
    setPreviewMode(true);
    setError(null);
    setDevice({ ip: 'preview', model: 'EVO5', serial: '00740', vehicle: 'UConn-EV (preview)' });
    setStatus('streaming');
    let frameNo = 0;
    const baseTs = Math.floor(Date.now() % 1e7);
    previewTimerRef.current = window.setInterval(() => {
      if (pausedRef.current) return;
      const subsystem = SUBSYSTEMS_PREVIEW[frameNo % SUBSYSTEMS_PREVIEW.length];
      const snap: Snapshot = {
        ts: baseTs + frameNo * 250,
        subsystem,
        raw: '',
        channels: generatePreviewChannels(frameNo),
      };
      ringRef.current.push(snap);
      if (ringRef.current.length > RING_BUFFER_SIZE) {
        ringRef.current.shift();
      }
      setLatest(snap);
      setCount(ringRef.current.length);
      if (frameNo % 8 === 0) {
        const bySubsystem: Record<string, number> = {};
        for (const s of ringRef.current) {
          bySubsystem[s.subsystem] = (bySubsystem[s.subsystem] || 0) + 1;
        }
        setBufferStats({ bySubsystem });
      }
      frameNo += 1;
    }, 250);
  };

  const stopPreview = () => {
    if (previewTimerRef.current !== null) {
      window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    setPreviewMode(false);
    ringRef.current = [];
    setCount(0);
    setLatest(null);
    setBufferStats({ bySubsystem: {} });
    setStatus('idle');
    setDevice(null);
    pausedRef.current = false;
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
          <>
            <button
              onClick={connect}
              disabled={status === 'connecting' || status === 'probing'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
            >
              <Wifi className="w-3.5 h-3.5" />
              Connect
            </button>
            <button
              onClick={startPreview}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
              title="Run the dashboard with synthetic data so you can see what it looks like without a connected AiM device"
            >
              <Activity className="w-3.5 h-3.5" />
              Preview UI (mock data)
            </button>
          </>
        ) : (
          <>
            <button
              onClick={togglePause}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-muted/50 text-foreground hover:bg-muted transition-colors"
            >
              {status === 'paused' ? <><Play className="w-3.5 h-3.5" /> Resume</> : <><Pause className="w-3.5 h-3.5" /> Pause</>}
            </button>
            <button
              onClick={previewMode ? stopPreview : disconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-red-500/10 text-red-500 dark:text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <WifiOff className="w-3.5 h-3.5" />
              {previewMode ? 'Exit preview' : 'Disconnect'}
            </button>
          </>
        )}

        <div className="flex-1" />

        {previewMode && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 font-medium">
            Preview mode — mock data
          </span>
        )}

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
                <button
                  onClick={startPreview}
                  className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
                >
                  <Activity className="w-3 h-3" />
                  Preview UI with mock data
                </button>
              </div>
            </div>
          </div>
        )}

        {isLive && (
          <div className="max-w-4xl mx-auto p-4 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Frames received" value={count.toString()} />
              <Stat
                label="Latest timestamp"
                value={latest ? `${(latest.ts / 1000).toFixed(2)}s` : '—'}
              />
              <Stat label="Latest subsystem" value={latest?.subsystem || '—'} mono />
            </div>

            {/* Live channel grid — populated in preview mode; real frames will
                drive this once the offset→name decoder lands. */}
            {latest?.channels && (
              <div className="rounded-lg bg-[hsl(225,30%,95%)] dark:bg-card border border-[hsl(225,25%,85%)] dark:border-border/50 p-3">
                <h3 className="text-xs font-medium text-foreground mb-3 flex items-center justify-between">
                  <span>Live channels</span>
                  {previewMode && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 font-normal">synthetic preview values</span>
                  )}
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  {PREVIEW_CHANNELS.map((ch) => {
                    const val = latest.channels?.[ch.name];
                    const display = val !== undefined ? formatChannelValue(val, ch.precision) : '—';
                    return (
                      <div
                        key={ch.name}
                        className="rounded-md bg-background/60 dark:bg-background/30 border border-[hsl(225,25%,85%)] dark:border-border/40 px-2.5 py-2"
                      >
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{ch.name}</p>
                        <p className="text-base font-semibold tabular mt-0.5 text-foreground">
                          {display}
                          <span className="text-[10px] text-muted-foreground font-normal ml-1">{ch.unit}</span>
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="rounded-lg bg-[hsl(225,30%,95%)] dark:bg-card border border-[hsl(225,25%,85%)] dark:border-border/50 p-3">
              <h3 className="text-xs font-medium text-foreground mb-2.5">
                Buffer composition
                <span className="text-muted-foreground font-normal ml-2">last {RING_BUFFER_SIZE} frames</span>
              </h3>
              <div className="space-y-1.5">
                {Object.entries(bufferStats.bySubsystem).map(([subsystem, n]) => (
                  <div key={subsystem} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground w-20 truncate">{subsystem}</span>
                    <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${(n / Math.max(1, count)) * 100}%` }}
                      />
                    </div>
                    <span className="tabular text-muted-foreground w-10 text-right">{n}</span>
                  </div>
                ))}
              </div>
            </div>

            {!previewMode && (
              <div className="rounded-lg border border-border/50 bg-card/50 p-3 text-[11px] text-muted-foreground leading-relaxed">
                Field-level decoding of real-device channel values is in progress —
                the offset→name decoder is being wired in. Once it lands, the Live
                channels grid above will populate from the actual 547-byte snapshots.
                For now this view confirms the live stream is healthy.
              </div>
            )}
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

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-[hsl(225,30%,95%)] dark:bg-card border border-[hsl(225,25%,85%)] dark:border-border/50 px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-base font-semibold mt-0.5 ${mono ? 'font-mono' : 'tabular'}`}>{value}</p>
    </div>
  );
}
