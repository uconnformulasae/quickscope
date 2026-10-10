import { type AimStatus } from '../lib/api';
import { Activity, AlertCircle, ArrowLeft, Pause, Play, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { vehicleKind } from './live/live-channels';
import { useLiveStream } from './live/useLiveStream';
import { EVDashboard } from './live/EVDashboard';
import { ICDashboard } from './live/ICDashboard';

interface Props {
  onBack: () => void;
  /** Device already discovered on the session browser — live TCP starts immediately. */
  aimDevice?: AimStatus['device'];
}

export function LiveView({ onBack, aimDevice = null }: Props) {
  const {
    status, device, error, reconnecting, latest, totalReceived, gpsTrail,
    connect, disconnect, togglePause, exportGpx,
  } = useLiveStream(aimDevice);

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
          {status === 'streaming' && reconnecting && (
            <span className="flex items-center gap-1.5 text-amber-500 dark:text-amber-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Reconnecting to logger…
            </span>
          )}
          {status === 'streaming' && !reconnecting && (
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
        </div>
      </header>

      {/* Action bar — mirrors SessionBrowser */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-card/50">
        {!isLive && status !== 'connecting' && (
          <button
            onClick={connect}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
          >
            <Wifi className="w-3.5 h-3.5" />
            {status === 'error' ? 'Retry' : 'Connect'}
          </button>
        )}
        {isLive && (
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
          <span className="text-xs text-muted-foreground tabular" title="Total snapshots received this session">
            Received {totalReceived}
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
            {vehicleKind(device?.vehicle) === 'ic' ? (
              <ICDashboard latest={latest} totalReceived={totalReceived} />
            ) : (
              <EVDashboard
                latest={latest}
                totalReceived={totalReceived}
                gpsTrail={gpsTrail}
                onExportGpx={exportGpx}
              />
            )}
          </div>
        )}

        {status === 'connecting' && !error && (
          <div className="max-w-md mx-auto text-center mt-16 px-4">
            <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-3" />
            <p className="text-sm text-foreground font-medium mb-1">Opening live stream</p>
            <p className="text-xs text-muted-foreground">
              {device
                ? `Connecting to ${device.vehicle || device.model || 'AiM'} at ${device.ip}…`
                : 'Using the same device identity as the session browser when available.'}
            </p>
          </div>
        )}

        {status === 'idle' && !error && (
          <div className="max-w-md mx-auto text-center mt-16 px-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mb-3">
              <Wifi className="w-5 h-5 text-primary" />
            </div>
            <p className="text-sm text-foreground font-medium mb-1">Live stream stopped</p>
            <p className="text-xs text-muted-foreground">
              Click Retry to reconnect, or go back to the session browser.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
