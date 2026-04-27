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
}

const RING_BUFFER_SIZE = 240; // 60 s at ~4 Hz

type Status = 'idle' | 'probing' | 'connecting' | 'streaming' | 'paused' | 'error';

export function LiveView({ onBack }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [device, setDevice] = useState<LiveDeviceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [count, setCount] = useState(0);
  const [bufferStats, setBufferStats] = useState({ bySubsystem: {} as Record<string, number> });

  const wsRef = useRef<WebSocket | null>(null);
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
          <div className="max-w-2xl mx-auto mt-6 mx-4">
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-medium text-red-500 dark:text-red-400">Connection error</p>
                <p className="text-muted-foreground mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}

        {isLive && (
          <div className="max-w-3xl mx-auto p-4 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Frames received" value={count.toString()} />
              <Stat
                label="Latest timestamp"
                value={latest ? `${(latest.ts / 1000).toFixed(2)}s` : '—'}
              />
              <Stat label="Latest subsystem" value={latest?.subsystem || '—'} mono />
            </div>

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

            <div className="rounded-lg border border-border/50 bg-card/50 p-3 text-[11px] text-muted-foreground leading-relaxed">
              Field-level decoding of channel values is in progress — the byte-level
              channel map is being extracted from the device's channel-config frame.
              Once that lands, values render on the existing chart engine here.
              For now this view confirms the live stream is healthy.
            </div>
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
