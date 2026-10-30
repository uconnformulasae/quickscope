import { Fragment, useRef, useState } from 'react';
import { Loader2, MoreHorizontal, Pencil, Radio, Trash2, Upload, FolderOpen } from 'lucide-react';
import type { LocalSession } from '../../lib/api';
import { GPSThumbnail } from '../GPSThumbnail';
import { IconButton } from '../ui/Button';
import { ContextMenu, Menu, type MenuEntry } from '../ui/Menu';

const SOURCE_CONFIG = {
  manual_upload: { icon: Upload, label: 'Uploaded' },
  aim_device: { icon: Radio, label: 'AiM' },
} as const;

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function SessionRow({
  session,
  loading,
  renaming,
  renameValue,
  onOpen,
  onStartRename,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: {
  session: LocalSession;
  loading: boolean;
  renaming: boolean;
  renameValue: string;
  onOpen: () => void;
  onStartRename: () => void;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const moreBox = useRef<HTMLDivElement>(null);
  const sourceCfg = SOURCE_CONFIG[session.source];
  const SourceIcon = sourceCfg.icon;

  const items: MenuEntry[] = [
    { label: 'Open', icon: FolderOpen, onSelect: onOpen },
    { label: 'Rename', icon: Pencil, onSelect: onStartRename },
    'separator',
    { label: 'Delete', icon: Trash2, danger: true, onSelect: onDelete },
  ];

  const details = [session.track_name, session.driver_name, session.vehicle_name, formatDate(session.recorded_at)].filter(Boolean);

  return (
    // A div, not a <button>: the row contains its own <input> and action buttons,
    // and interactive content nested in a button is invalid HTML.
    <div
      role="button"
      tabIndex={loading ? -1 : 0}
      aria-disabled={loading}
      onClick={() => { if (!loading) onOpen(); }}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || loading) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary ${loading ? 'opacity-60' : 'cursor-pointer'}`}
    >
      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-muted">
        {session.local_path && <GPSThumbnail sessionId={session.id} size={48} />}
      </div>

      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameSubmit();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full max-w-[280px] rounded-md border border-primary/50 bg-muted px-1.5 py-0.5 text-[14px] font-medium text-foreground outline-none"
            autoFocus
          />
        ) : (
          <div className="truncate text-[14px] font-medium text-foreground">
            {session.aim_session_id || session.filename}
          </div>
        )}
        {details.length > 0 && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            {details.map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <span aria-hidden="true">·</span>}
                <span className="truncate">{part}</span>
              </Fragment>
            ))}
          </div>
        )}
      </div>

      <div className="hidden flex-shrink-0 items-center gap-3 text-[12.5px] text-muted-foreground sm:flex">
        {session.index_status === 'pending' ? (
          <span
            className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
            title="Downloaded; reading laps and metadata in the background"
          >
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            Indexing
          </span>
        ) : (
          <span className="tabular text-foreground">{formatDuration(session.duration_s)}</span>
        )}
        <span className="inline-block w-14 text-right tabular">
          {session.lap_count > 0 ? `${session.lap_count} laps` : ""}
        </span>
        <span title={sourceCfg.label} className="inline-flex">
          <SourceIcon className="h-3.5 w-3.5" />
        </span>
      </div>

      <div
        ref={moreBox}
        className="relative h-7 w-7 flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <Loader2 className="m-1.5 h-4 w-4 animate-spin text-primary" />
        ) : (
          <>
            <IconButton
              label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className={`opacity-0 focus-visible:opacity-100 group-hover:opacity-100 ${menuOpen ? 'opacity-100' : ''}`}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </IconButton>
            {menuOpen && (
              <Menu
                items={items}
                onClose={() => setMenuOpen(false)}
                dismissRef={moreBox}
                className="absolute right-0 top-full mt-1"
              />
            )}
          </>
        )}
      </div>

      {ctx && (
        <div onClick={(e) => e.stopPropagation()}>
          <ContextMenu x={ctx.x} y={ctx.y} items={items} onClose={() => setCtx(null)} />
        </div>
      )}
    </div>
  );
}
