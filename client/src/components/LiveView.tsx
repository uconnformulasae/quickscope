import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchLiveChannels, type AimStatus } from '../lib/api';
import { AlertCircle, Pencil, Upload, WifiOff, X } from 'lucide-react';
import { Button } from './ui/Button';
import { LiveHeader } from './live/LiveHeader';
import { BUILTIN_CHANNELS, BUILTIN_UNITS, vehicleKind, type VehicleKind } from './live/live-channels';
import { useLiveStream } from './live/useLiveStream';
import { useLiveLayouts } from './live/useLiveLayouts';
import { useUnitOverrides } from './live/useUnitOverrides';
import { LiveDashboard } from './live/LiveDashboard';
import { WidgetConfigDialog } from './live/WidgetConfigDialog';
import { type ChannelSources } from './live/ChannelPicker';
import { BUILTIN_ID, GRID_COLS, cloneLayout, newId, type LiveLayout, type WidgetConfig } from './live/layout-schema';

interface Props {
  onBack: () => void;
  /** Device already discovered on the session browser — live TCP starts immediately. */
  aimDevice?: AimStatus['device'];
  /** Opens the app's settings (network section) from the offline notice. */
  onOpenSettings: () => void;
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

export function LiveView({ onBack, aimDevice = null, onOpenSettings }: Props) {
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
  const [notice, setNotice] = useState<string | null>(null);
  const [seenChannels, setSeenChannels] = useState<string[]>([]);
  const [seenUnits, setSeenUnits] = useState<Record<string, string>>({});

  const layouts = useLiveLayouts(connectedKind, draft !== null);
  const units = useUnitOverrides();
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
      <LiveHeader
        onBack={handleBack}
        layouts={layouts}
        draft={draft}
        onDraftChange={setDraft}
        status={status}
        device={device}
        reconnecting={reconnecting}
        totalReceived={totalReceived}
        onConnect={connect}
        onDisconnect={disconnect}
        onTogglePause={togglePause}
        onEdit={startEdit}
        onCancel={cancelEdit}
        onDone={saveDraft}
        onAddWidget={addWidget}
        onExport={() => downloadLayout(layouts.current)}
        onDelete={() => {
          if (window.confirm(`Delete the layout "${layouts.current.name}"?`)) layouts.remove(layouts.current.id);
        }}
        onImportFile={importFile}
      />

      <main className="flex-1 overflow-auto">
        {/* Banners — slim full-width strips above the grid, never instead of it */}
        <div className="empty:hidden">
          {status === 'error' && error && (
            <Banner tone="red" icon={<AlertCircle className="w-3.5 h-3.5" />}>
              <span className="font-medium">Connection error.</span> {error}
              {isMac() && ' Check System Settings → Privacy & Security → Local Network for QuickScope.'}
            </Banner>
          )}
          {status === 'idle' && (
            <Banner
              tone="muted"
              icon={<WifiOff className="w-3.5 h-3.5" />}
              action={<Button variant="plain" size="sm" onClick={onOpenSettings}>Network Settings…</Button>}
            >
              {receivedAt !== null && latest
                ? <>Not connected — showing last values ({timeAgo(now - receivedAt)}).</>
                : <>Not connected — previewing the layout. Connect to the car's AiM WiFi to see live values.</>}
              {' You can still edit this layout.'}
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
            unitOverrides={units.overrides}
            onCycleUnit={units.cycle}
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

function isMac(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.platform === 'string' && navigator.platform.startsWith('Mac');
}

const BANNER_TONE = {
  red: 'bg-card text-danger',
  amber: 'bg-card text-warning',
  primary: 'bg-primary/10 text-primary dark:text-[#8aa0ff]',
  muted: 'bg-card text-muted-foreground',
} as const;

function Banner({ tone, icon, children, onDismiss, action }: {
  tone: keyof typeof BANNER_TONE;
  icon: ReactNode;
  children: ReactNode;
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  return (
    <div className={`flex items-center gap-2 border-b border-separator px-4 py-1.5 text-xs ${BANNER_TONE[tone]}`}>
      <span className="flex-shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">{children}</div>
      {action}
      {onDismiss && (
        <button onClick={onDismiss} className="p-0.5 opacity-70 hover:opacity-100" title="Dismiss">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
