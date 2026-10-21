import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchLiveChannels, type AimStatus } from '../lib/api';
import {
  Activity, AlertCircle, ArrowLeft, Copy, Download, Loader2, MoreHorizontal, Pause, Pencil, Pin, PinOff,
  Play, Plus, Save, Trash2, Upload, Wifi, WifiOff, X,
} from 'lucide-react';
import { BUILTIN_CHANNELS, BUILTIN_UNITS, vehicleKind, type VehicleKind } from './live/live-channels';
import { useLiveStream } from './live/useLiveStream';
import { useLiveLayouts } from './live/useLiveLayouts';
import { LiveDashboard } from './live/LiveDashboard';
import { WidgetConfigDialog } from './live/WidgetConfigDialog';
import { type ChannelSources } from './live/ChannelPicker';
import { BUILTIN_ID, GRID_COLS, cloneLayout, newId, type LiveLayout, type WidgetConfig } from './live/layout-schema';

interface Props {
  onBack: () => void;
  /** Device already discovered on the session browser — live TCP starts immediately. */
  aimDevice?: AimStatus['device'];
}

const VEHICLE_LABEL: Record<VehicleKind, string> = { ev: 'EV', ic: 'IC' };

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function downloadLayout(layout: LiveLayout) {
  const { builtIn: _builtIn, ...data } = layout;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${layout.name.replace(/[^\w.-]+/g, '_') || 'layout'}.qslayout.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const BTN = 'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50';
const BTN_MUTED = `${BTN} bg-muted/50 text-foreground hover:bg-muted`;
const BTN_PRIMARY = `${BTN} bg-primary/10 text-primary hover:bg-primary/20`;

export function LiveView({ onBack, aimDevice = null }: Props) {
  const {
    status, device, error, reconnecting, latest, totalReceived, receivedAt,
    connect, disconnect, togglePause,
  } = useLiveStream(aimDevice);

  const isLive = status === 'streaming' || status === 'paused';
  const connectedKind: VehicleKind | null = isLive && device ? vehicleKind(device.vehicle) : null;

  // Edit mode works on a draft copy; nothing is persisted until Save.
  const [draft, setDraft] = useState<LiveLayout | null>(null);
  const draftOrigin = useRef('');
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [seenChannels, setSeenChannels] = useState<string[]>([]);
  const [seenUnits, setSeenUnits] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const layouts = useLiveLayouts(connectedKind, draft !== null);
  const shown = draft ?? layouts.current;
  const dirty = draft !== null && JSON.stringify(draft) !== draftOrigin.current;
  const mismatch = connectedKind !== null && shown.vehicle !== connectedKind;
  const now = useNow(!isLive && receivedAt !== null);

  // Channels this car sent on earlier sessions, for the picker while offline.
  const draftVehicle = draft?.vehicle;
  useEffect(() => {
    if (!draftVehicle) return;
    let cancelled = false;
    fetchLiveChannels(draftVehicle)
      .then((res) => {
        if (cancelled) return;
        setSeenChannels(res.channels);
        setSeenUnits(res.units ?? {});
      })
      .catch(() => {
        if (cancelled) return;
        setSeenChannels([]);
        setSeenUnits({});
      });
    return () => { cancelled = true; };
  }, [draftVehicle]);

  const startEdit = () => {
    const base = layouts.current;
    // Built-ins are read-only: edit a copy so the defaults always stay available.
    const next = base.builtIn
      ? cloneLayout(base, { name: `${base.name} (custom)` })
      : (JSON.parse(JSON.stringify(base)) as LiveLayout);
    draftOrigin.current = JSON.stringify(next);
    setDraft(next);
    setMenuOpen(false);
  };

  const cancelEdit = () => {
    if (dirty && !window.confirm('Discard your changes to this layout?')) return;
    setDraft(null);
    setEditingWidgetId(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const name = draft.name.trim() || 'Untitled layout';
    if (await layouts.save({ ...draft, name })) {
      setDraft(null);
      setEditingWidgetId(null);
    }
  };

  const handleBack = () => {
    if (dirty && !window.confirm('Leave without saving your layout changes?')) return;
    onBack();
  };

  const addWidget = () => {
    if (!draft) return;
    const widget: WidgetConfig = { id: newId(), type: 'stats', title: 'New widget', style: 'tile', channels: [] };
    const bottom = draft.grid.reduce((m, g) => Math.max(m, g.y + g.h), 0);
    setDraft({
      ...draft,
      widgets: [...draft.widgets, widget],
      grid: [...draft.grid, { i: widget.id, x: 0, y: bottom, w: Math.min(4, GRID_COLS), h: 6 }],
    });
    setEditingWidgetId(widget.id);
  };

  const removeWidget = (id: string) => {
    if (!draft) return;
    setDraft({ ...draft, widgets: draft.widgets.filter((w) => w.id !== id), grid: draft.grid.filter((g) => g.i !== id) });
  };

  const importFile = async (file: File) => {
    try {
      const warnings = await layouts.importLayout(JSON.parse(await file.text()));
      setNotice(warnings.length ? `Imported with warnings: ${warnings.join('; ')}` : `Imported "${file.name}".`);
    } catch (e) {
      setNotice(`Couldn't import ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const editingWidget = draft?.widgets.find((w) => w.id === editingWidgetId) ?? null;
  const sources: ChannelSources | null = draft && {
    // Only offer live keys when the car on the wire is the one this layout is for.
    live: connectedKind === draft.vehicle ? Object.keys(latest?.channels ?? {}) : [],
    seen: seenChannels,
    builtin: BUILTIN_CHANNELS[draft.vehicle],
    units: {
      ...BUILTIN_UNITS,
      ...seenUnits,
      ...(connectedKind === draft.vehicle ? latest?.units : undefined),
    },
    vehicleLabel: VEHICLE_LABEL[draft.vehicle],
  };

  const carLayoutId = connectedKind
    ? (layouts.selection.active[connectedKind] && layouts.layouts.some((l) => l.id === layouts.selection.active[connectedKind])
        ? layouts.selection.active[connectedKind]!
        : BUILTIN_ID[connectedKind])
    : null;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* Header — mirrors SessionBrowser */}
      <header className="flex items-center gap-3 px-4 h-12 border-b border-border bg-card flex-shrink-0">
        <button
          onClick={handleBack}
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

        {/* Status indicator — always shows something, so the dashboard can stay up offline */}
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
          {status === 'idle' && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" />
              Disconnected
            </span>
          )}
          {status === 'error' && (
            <span className="flex items-center gap-1.5 text-red-500 dark:text-red-400">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400" />
              Not connected
            </span>
          )}
        </div>
      </header>

      {/* Action bar — stream controls, then layout controls (or the editor's) */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border/50 bg-card/50">
        {!isLive && status !== 'connecting' && (
          <button onClick={connect} className={BTN_PRIMARY}>
            <Wifi className="w-3.5 h-3.5" />
            {status === 'error' ? 'Retry' : 'Connect'}
          </button>
        )}
        {isLive && (
          <>
            <button onClick={togglePause} className={BTN_MUTED}>
              {status === 'paused' ? <><Play className="w-3.5 h-3.5" /> Resume</> : <><Pause className="w-3.5 h-3.5" /> Pause</>}
            </button>
            <button
              onClick={disconnect}
              className={`${BTN} bg-red-500/10 text-red-500 dark:text-red-400 hover:bg-red-500/20`}
            >
              <WifiOff className="w-3.5 h-3.5" />
              Disconnect
            </button>
          </>
        )}

        <div className="w-px h-5 bg-border mx-1 hidden sm:block" />

        {draft ? (
          <>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="px-2 py-1.5 w-48 bg-background border border-border rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Layout name"
              aria-label="Layout name"
            />
            <select
              value={draft.vehicle}
              onChange={(e) => setDraft({ ...draft, vehicle: e.target.value as VehicleKind })}
              className="px-2 py-1.5 bg-background border border-border rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              title="Which car this layout is for — used to auto-pick it on connect"
              aria-label="Vehicle"
            >
              <option value="ev">EV</option>
              <option value="ic">IC</option>
            </select>
            <button onClick={addWidget} className={BTN_PRIMARY}>
              <Plus className="w-3.5 h-3.5" /> Add widget
            </button>
            <button onClick={cancelEdit} className={BTN_MUTED}>
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
            <button onClick={saveDraft} className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90`}>
              <Save className="w-3.5 h-3.5" /> Save
            </button>
          </>
        ) : (
          <>
            <select
              value={layouts.current.id}
              onChange={(e) => layouts.select(e.target.value)}
              disabled={!layouts.loaded}
              className="px-2 py-1.5 max-w-[14rem] bg-background border border-border rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              aria-label="Dashboard layout"
            >
              {(['ev', 'ic'] as const).map((kind) => (
                <optgroup key={kind} label={VEHICLE_LABEL[kind]}>
                  {layouts.layouts.filter((l) => l.vehicle === kind).map((l) => (
                    <option key={l.id} value={l.id}>{l.name}{l.builtIn ? ' (built-in)' : ''}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              onClick={layouts.togglePin}
              className={`p-1.5 rounded-md transition-colors ${
                layouts.pinned ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
              title={layouts.pinned
                ? 'Pinned: connecting to a car keeps this layout. Click to unpin.'
                : "Pin this layout so connecting to a car doesn't switch away from it"}
            >
              {layouts.pinned ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
            </button>
            <button onClick={startEdit} className={BTN_MUTED} title={layouts.current.builtIn ? 'Built-in layouts are edited as a copy' : 'Edit layout'}>
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                title="More layout actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div role="menu" className="absolute left-0 top-full mt-1 z-50 w-44 py-1 rounded-md border border-border bg-card shadow-xl text-xs">
                    <MenuItem icon={Copy} label="Duplicate" onClick={() => { setMenuOpen(false); layouts.duplicate(layouts.current.id); }} />
                    <MenuItem icon={Download} label="Export to file" onClick={() => { setMenuOpen(false); downloadLayout(layouts.current); }} />
                    <MenuItem icon={Upload} label="Import from file…" onClick={() => { setMenuOpen(false); fileInput.current?.click(); }} />
                    {!layouts.current.builtIn && (
                      <MenuItem
                        icon={Trash2}
                        label="Delete"
                        danger
                        onClick={() => {
                          setMenuOpen(false);
                          if (window.confirm(`Delete the layout "${layouts.current.name}"?`)) layouts.remove(layouts.current.id);
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) importFile(file);
              }}
            />
          </>
        )}

        <div className="flex-1" />

        {totalReceived > 0 && (
          <span className="text-xs text-muted-foreground tabular" title="Total snapshots received this session">
            Received {totalReceived}
          </span>
        )}
      </div>

      <main className="flex-1 overflow-auto">
        {/* Banners — slim, above the grid, never instead of it */}
        <div className="max-w-[1600px] mx-auto px-3 pt-3 space-y-2 empty:hidden">
          {status === 'error' && error && (
            <Banner tone="red" icon={<AlertCircle className="w-3.5 h-3.5" />}>
              <span className="font-medium">Connection error.</span> {error}
            </Banner>
          )}
          {status === 'connecting' && !error && (
            <Banner tone="muted" icon={<Loader2 className="w-3.5 h-3.5 animate-spin" />}>
              {device
                ? `Connecting to ${device.vehicle || device.model || 'AiM'} at ${device.ip}…`
                : 'Connecting to the AiM logger…'}
            </Banner>
          )}
          {status === 'idle' && (
            <Banner tone="muted" icon={<WifiOff className="w-3.5 h-3.5" />}>
              {receivedAt !== null && latest
                ? <>Not connected — showing last values ({timeAgo(now - receivedAt)}).</>
                : <>Not connected — previewing the layout. Connect to the car's AiM WiFi to see live values.</>}
            </Banner>
          )}
          {mismatch && !draft && connectedKind && (
            <Banner tone="amber" icon={<AlertCircle className="w-3.5 h-3.5" />}>
              This layout is for the {VEHICLE_LABEL[shown.vehicle]} car, but the connected car is {VEHICLE_LABEL[connectedKind]}.
              {carLayoutId && carLayoutId !== shown.id && (
                <button onClick={() => layouts.select(carLayoutId)} className="ml-2 underline hover:no-underline">
                  Switch to the {VEHICLE_LABEL[connectedKind]} layout
                </button>
              )}
            </Banner>
          )}
          {draft && (
            <Banner tone="primary" icon={<Pencil className="w-3.5 h-3.5" />}>
              Editing — drag widgets to move them, drag the bottom-right corner to resize, use ✎ to pick channels.
              {layouts.current.builtIn && ' Saving creates a new layout; the built-in one is unchanged.'}
            </Banner>
          )}
          {layouts.error && (
            <Banner tone="red" icon={<AlertCircle className="w-3.5 h-3.5" />} onDismiss={layouts.clearError}>
              {layouts.error}
            </Banner>
          )}
          {notice && (
            <Banner tone="muted" icon={<Upload className="w-3.5 h-3.5" />} onDismiss={() => setNotice(null)}>
              {notice}
            </Banner>
          )}
        </div>

        <div className="p-3">
          <LiveDashboard
            layout={shown}
            latest={latest}
            totalReceived={totalReceived}
            stale={!isLive && latest !== null}
            editing={draft !== null}
            onGridChange={(grid) => draft && setDraft({ ...draft, grid })}
            onEditWidget={setEditingWidgetId}
            onRemoveWidget={removeWidget}
          />
        </div>
      </main>

      {editingWidget && sources && draft && (
        <WidgetConfigDialog
          key={editingWidget.id}
          widget={editingWidget}
          sources={sources}
          onClose={() => setEditingWidgetId(null)}
          onSave={(w) => {
            setDraft({ ...draft, widgets: draft.widgets.map((x) => (x.id === w.id ? w : x)) });
            setEditingWidgetId(null);
          }}
        />
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
        danger ? 'text-red-500 hover:bg-red-500/10' : 'text-foreground hover:bg-muted/60'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

const BANNER_TONE = {
  red: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  primary: 'border-primary/30 bg-primary/10 text-primary',
  muted: 'border-border bg-card/60 text-muted-foreground',
} as const;

function Banner({ tone, icon, children, onDismiss }: {
  tone: keyof typeof BANNER_TONE;
  icon: ReactNode;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${BANNER_TONE[tone]}`}>
      <span className="flex-shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} className="p-0.5 opacity-70 hover:opacity-100" title="Dismiss">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
