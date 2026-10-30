import { useRef, type ReactNode } from 'react';
import { ArrowLeft, Copy, Download, Loader2, MoreHorizontal, Pause, Pin, PinOff, Play, Plus, Trash2, Upload, Wifi, WifiOff } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { MenuButton, type MenuEntry } from '../ui/Menu';
import { type LiveDeviceInfo } from '../../lib/api';
import { type Status } from './useLiveStream';
import { type VehicleKind } from './live-channels';
import { type LiveLayout } from './layout-schema';

const VEHICLE_LABEL: Record<VehicleKind, string> = { ev: 'EV', ic: 'IC' };

const CHIP =
  'h-7 rounded-[7px] bg-muted px-2 text-[13px] text-foreground focus:outline-none focus-visible:outline-2 focus-visible:outline-primary';

interface Layouts {
  layouts: LiveLayout[];
  current: LiveLayout;
  loaded: boolean;
  pinned: boolean;
  select: (id: string) => void;
  togglePin: () => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
}

interface Props {
  onBack: () => void;
  layouts: Layouts;
  draft: LiveLayout | null;
  onDraftChange: (draft: LiveLayout) => void;
  status: Status;
  device: LiveDeviceInfo | null;
  reconnecting: boolean;
  totalReceived: number;
  onConnect: () => void;
  onDisconnect: () => void;
  onTogglePause: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onDone: () => void;
  onAddWidget: () => void;
  onExport: () => void;
  onDelete: () => void;
  onImportFile: (file: File) => void;
}

function StatusIndicator({ status, reconnecting, device, totalReceived }: Pick<Props, 'status' | 'reconnecting' | 'device' | 'totalReceived'>) {
  let tone = 'text-muted-foreground';
  let lead: ReactNode = <span className="h-1.5 w-1.5 rounded-full bg-label-3" />;
  let text = 'Disconnected';
  if (status === 'streaming' && reconnecting) {
    tone = 'text-warning';
    lead = <Loader2 className="h-3 w-3 animate-spin" />;
    text = 'Reconnecting to logger…';
  } else if (status === 'streaming') {
    tone = 'text-success';
    lead = <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />;
    text = 'Streaming';
  } else if (status === 'paused') {
    tone = 'text-warning';
    lead = <Pause className="h-3 w-3" />;
    text = 'Paused';
  } else if (status === 'connecting') {
    lead = <Loader2 className="h-3 w-3 animate-spin" />;
    text = 'Connecting';
  } else if (status === 'error') {
    tone = 'text-danger';
    lead = <span className="h-1.5 w-1.5 rounded-full bg-danger" />;
    text = 'Not connected';
  }
  const deviceText = device ? [device.model, device.vehicle].filter(Boolean).join(' · ') : '';
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-xs"
      title={totalReceived > 0 ? `Received ${totalReceived}` : undefined}
    >
      {deviceText && <span className="hidden truncate text-label-3 sm:inline">{deviceText}</span>}
      <span className={`flex items-center gap-1.5 whitespace-nowrap ${tone}`}>
        {lead}
        {text}
      </span>
    </div>
  );
}

/** The single 52 px live-view header: layout controls on the left, connection on the right. */
export function LiveHeader(p: Props) {
  const { layouts, draft, status } = p;
  const fileInput = useRef<HTMLInputElement>(null);
  const isLive = status === 'streaming' || status === 'paused';

  const connection = (
    <>
      <StatusIndicator status={status} reconnecting={p.reconnecting} device={p.device} totalReceived={p.totalReceived} />
      {!isLive && status !== 'connecting' && (
        <Button variant="tinted" onClick={p.onConnect}>
          <Wifi size={14} aria-hidden="true" />
          {status === 'error' ? 'Retry' : 'Connect'}
        </Button>
      )}
      {isLive && (
        <>
          <Button onClick={p.onTogglePause}>
            {status === 'paused' ? <><Play size={14} aria-hidden="true" /> Resume</> : <><Pause size={14} aria-hidden="true" /> Pause</>}
          </Button>
          <Button variant="danger" onClick={p.onDisconnect}>
            <WifiOff size={14} aria-hidden="true" />
            Disconnect
          </Button>
        </>
      )}
    </>
  );

  const back = (
    <IconButton label="Back to sessions" onClick={p.onBack}>
      <ArrowLeft size={16} aria-hidden="true" />
    </IconButton>
  );

  const items: MenuEntry[] = [
    {
      label: layouts.pinned ? 'Unpin Layout' : 'Pin Layout',
      icon: layouts.pinned ? PinOff : Pin,
      onSelect: layouts.togglePin,
    },
    { label: 'Duplicate', icon: Copy, onSelect: () => layouts.duplicate(layouts.current.id) },
    { label: 'Export to File', icon: Download, onSelect: p.onExport },
    { label: 'Import from File…', icon: Upload, onSelect: () => fileInput.current?.click() },
    ...(layouts.current.builtIn
      ? []
      : [{ label: 'Delete', icon: Trash2, danger: true, onSelect: p.onDelete } as MenuEntry]),
  ];

  return (
    <header className="flex h-[52px] flex-shrink-0 items-center gap-2.5 border-b border-separator bg-card px-4">
      {back}
      {draft ? (
        <>
          <input
            value={draft.name}
            onChange={(e) => p.onDraftChange({ ...draft, name: e.target.value })}
            className={`${CHIP} w-48`}
            placeholder="Layout name"
            aria-label="Layout name"
          />
          <select
            value={draft.vehicle}
            onChange={(e) => p.onDraftChange({ ...draft, vehicle: e.target.value as VehicleKind })}
            className={CHIP}
            title="Which car this layout is for — used to auto-pick it on connect"
            aria-label="Vehicle"
          >
            <option value="ev">EV</option>
            <option value="ic">IC</option>
          </select>
          {layouts.current.builtIn && (
            <span className="hidden truncate text-xs text-label-3 lg:inline">Built-in layouts are edited as a copy</span>
          )}
          <div className="flex-1" />
          {connection}
          <Button variant="secondary" onClick={p.onAddWidget}>
            <Plus size={14} aria-hidden="true" /> Add Widget
          </Button>
          <Button variant="plain" onClick={p.onCancel}>Cancel</Button>
          <Button variant="primary" onClick={p.onDone}>Done</Button>
        </>
      ) : (
        <>
          <h1 className="font-display text-[15px] font-semibold">Live</h1>
          <select
            value={layouts.current.id}
            onChange={(e) => layouts.select(e.target.value)}
            disabled={!layouts.loaded}
            className={`${CHIP} max-w-[14rem]`}
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
          <Button
            variant="plain"
            onClick={p.onEdit}
            title={layouts.current.builtIn ? 'Built-in layouts are edited as a copy' : 'Edit layout'}
          >
            Edit
          </Button>
          <MenuButton label="More layout actions" icon={<MoreHorizontal size={16} aria-hidden="true" />} items={items} />
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) p.onImportFile(file);
            }}
          />
          <div className="flex-1" />
          {connection}
        </>
      )}
    </header>
  );
}
