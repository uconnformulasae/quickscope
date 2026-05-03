import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  listSessions, loadSession, syncSessions, pullSession, deleteSession,
  renameSession, getAimStatus, uploadFile, fetchUploadLog,
  type LocalSession, type SessionInfo, type AimStatus, type UploadLogEntry,
} from '../lib/api';
import {
  RefreshCw, Cloud, Wifi, WifiOff, Upload, Trash2,
  Download, CheckCircle, Loader2, HardDrive, Radio,
  ChevronRight, Search, Settings, Pencil, Activity, FileClock, X,
  ArrowUp, ArrowDown,
} from 'lucide-react';
import { AimSessionPicker } from './AimSessionPicker';
import { QuickScopeLogo } from './QuickScopeLogo';
import { ThemeToggle } from './ThemeToggle';
import { GPSThumbnail } from './GPSThumbnail';

interface SessionBrowserProps {
  onSessionLoaded: (info: SessionInfo, sessionId: string, fileName: string) => void;
  onOpenSettings: () => void;
  onOpenLive: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1) return '0 B/s';
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.floor((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}

function pathStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

type SortKey = 'date' | 'track' | 'duration';
type SortDir = 'asc' | 'desc';
interface SortState { key: SortKey | null; dir: SortDir }

const SORT_STORAGE_KEY = 'quickscope.sessionSort';
const DEFAULT_SORT: SortState = { key: null, dir: 'desc' };
// Direction a column starts in when first activated.
const NATURAL_DIR: Record<SortKey, SortDir> = { date: 'desc', track: 'asc', duration: 'desc' };

function loadSortState(): SortState {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw);
    if (
      (parsed.key === null || parsed.key === 'date' || parsed.key === 'track' || parsed.key === 'duration') &&
      (parsed.dir === 'asc' || parsed.dir === 'desc')
    ) return parsed as SortState;
  } catch { /* ignore */ }
  return DEFAULT_SORT;
}

function saveSortState(s: SortState) {
  try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// Tri-state header click: clicking the active column flips dir, then clears
// to default on the third click. Clicking another column starts that column
// at its natural direction.
function nextSortState(current: SortState, clicked: SortKey): SortState {
  if (current.key !== clicked) return { key: clicked, dir: NATURAL_DIR[clicked] };
  if (current.dir === NATURAL_DIR[clicked]) return { key: clicked, dir: NATURAL_DIR[clicked] === 'desc' ? 'asc' : 'desc' };
  return DEFAULT_SORT;
}

function dateValue(s: LocalSession): number | null {
  const iso = s.recorded_at;
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function trackValue(s: LocalSession): string | null {
  const v = s.track_name?.trim();
  return v ? v.toLowerCase() : null;
}

function durationValue(s: LocalSession): number | null {
  return s.duration_s > 0 ? s.duration_s : null;
}

// Comparator: missing values always sort to the bottom regardless of direction.
function compareSessions(a: LocalSession, b: LocalSession, state: SortState): number {
  // Default state mirrors today's behavior: newest first by recorded_at, falling
  // back to created_at so freshly uploaded sessions without recorded_at don't
  // sink to the bottom of an unsorted list.
  if (state.key === null) {
    const da = a.recorded_at || a.created_at;
    const db = b.recorded_at || b.created_at;
    return db.localeCompare(da);
  }

  const sign = state.dir === 'asc' ? 1 : -1;
  const cmpNum = (x: number | null, y: number | null) => {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * sign;
  };
  const cmpStr = (x: string | null, y: string | null) => {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x.localeCompare(y) * sign;
  };

  let primary = 0;
  if (state.key === 'date') primary = cmpNum(dateValue(a), dateValue(b));
  else if (state.key === 'track') primary = cmpStr(trackValue(a), trackValue(b));
  else if (state.key === 'duration') primary = cmpNum(durationValue(a), durationValue(b));
  if (primary !== 0) return primary;

  // Secondary keys (per design): date→aim_session_id asc; track/duration→date desc.
  if (state.key === 'date') {
    return (a.aim_session_id || a.filename).localeCompare(b.aim_session_id || b.filename);
  }
  const da = dateValue(a);
  const db = dateValue(b);
  if (da === null && db === null) return 0;
  if (da === null) return 1;
  if (db === null) return -1;
  return db - da;
}

const SYNC_STATUS_CONFIG = {
  synced: { icon: CheckCircle, label: 'Synced', color: 'text-emerald-500 dark:text-emerald-400' },
  local_only: { icon: HardDrive, label: 'Local only', color: 'text-amber-500 dark:text-amber-400' },
  remote_only: { icon: Cloud, label: 'Remote', color: 'text-blue-500 dark:text-blue-400' },
  uploading: { icon: Loader2, label: 'Uploading...', color: 'text-amber-500 dark:text-amber-400 animate-spin' },
  downloading: { icon: Loader2, label: 'Downloading...', color: 'text-blue-500 dark:text-blue-400 animate-spin' },
} as const;

const SOURCE_CONFIG = {
  manual_upload: { icon: Upload, label: 'Uploaded' },
  aim_device: { icon: Radio, label: 'AiM' },
  railway: { icon: Cloud, label: 'Railway' },
} as const;

function SortHeader({
  label, sortKey, state, onClick,
}: {
  label: string;
  sortKey: SortKey;
  state: SortState;
  onClick: (key: SortKey) => void;
}) {
  const active = state.key === sortKey;
  const Arrow = state.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onClick(sortKey)}
      className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
        active
          ? 'text-primary bg-primary/10 hover:bg-primary/15'
          : 'hover:text-foreground hover:bg-muted/50'
      }`}
    >
      <span>{label}</span>
      {active && <Arrow className="w-3 h-3" />}
    </button>
  );
}

export function SessionBrowser({ onSessionLoaded, onOpenSettings, onOpenLive, theme, onToggleTheme }: SessionBrowserProps) {
  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [aimStatus, setAimStatus] = useState<AimStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [aimPickerOpen, setAimPickerOpen] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [pullingId, setPullingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [uploadProgress, setUploadProgress] = useState<{
    loaded: number; total: number; ratePerSec: number;
  } | null>(null);
  const [uploadLog, setUploadLog] = useState<UploadLogEntry[]>([]);
  const [showUploadLog, setShowUploadLog] = useState(false);
  const [sortState, setSortState] = useState<SortState>(() => loadSortState());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleSortClick = useCallback((key: SortKey) => {
    setSortState(prev => {
      const next = nextSortState(prev, key);
      saveSortState(next);
      return next;
    });
  }, []);

  const clearSort = useCallback(() => {
    setSortState(DEFAULT_SORT);
    saveSortState(DEFAULT_SORT);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
    } catch (e) {
      console.error('Failed to list sessions:', e);
    }
  }, []);

  const checkAimStatus = useCallback(async () => {
    try {
      const status = await getAimStatus();
      setAimStatus(status);
    } catch {
      setAimStatus(null);
    }
  }, []);

  useEffect(() => {
    refreshSessions();
    checkAimStatus();
    const interval = setInterval(checkAimStatus, 10000);
    return () => clearInterval(interval);
  }, [refreshSessions, checkAimStatus]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await syncSessions();
      await refreshSessions();
      if (result.errors?.length) {
        setError(result.errors.join('; '));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [refreshSessions]);

  const handleAimPickerDownloaded = useCallback(() => {
    refreshSessions();
  }, [refreshSessions]);

  const handleSessionClick = useCallback(async (session: LocalSession) => {
    if (session.sync_status === 'remote_only') {
      // Need to pull first
      setPullingId(session.id);
      try {
        await pullSession(session.id);
        await refreshSessions();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Pull failed');
        setPullingId(null);
        return;
      }
      setPullingId(null);
    }

    setLoadingId(session.id);
    try {
      const info = await loadSession(session.id);
      onSessionLoaded(info, session.id, session.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoadingId(null);
    }
  }, [onSessionLoaded, refreshSessions]);

  const handleDelete = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this session from local storage?')) return;
    try {
      await deleteSession(sessionId);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [refreshSessions]);

  const startRename = useCallback((e: React.MouseEvent, session: LocalSession) => {
    e.stopPropagation();
    setRenamingId(session.id);
    setRenameValue(session.aim_session_id || pathStem(session.filename));
    setTimeout(() => renameInputRef.current?.select(), 0);
  }, []);

  const submitRename = useCallback(async () => {
    const id = renamingId;
    const value = renameValue.trim();
    setRenamingId(null);
    if (!id || !value) return;
    const current = sessions.find(s => s.id === id);
    if (current && value === (current.aim_session_id || pathStem(current.filename))) return;
    try {
      await renameSession(id, value);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  }, [renamingId, renameValue, sessions, refreshSessions]);

  const handleFileUpload = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.xrk') && !file.name.toLowerCase().endsWith('.xrz')) return;
    setLoadingId('upload');
    setUploadProgress({ loaded: 0, total: file.size, ratePerSec: 0 });
    setError(null);
    try {
      const info = await uploadFile(file, (p) => {
        setUploadProgress({
          loaded: p.loaded,
          total: p.total,
          ratePerSec: p.ratePerSec,
        });
      });
      const updated = await listSessions();
      setSessions(updated);
      const newest = updated.find(s => s.filename === file.name);
      if (newest) {
        onSessionLoaded(info, newest.id, file.name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoadingId(null);
      setUploadProgress(null);
    }
  }, [onSessionLoaded]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  const sortedSessions = useMemo(() => {
    const filtered = sessions.filter(s => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        s.filename.toLowerCase().includes(q) ||
        s.track_name?.toLowerCase().includes(q) ||
        s.driver_name?.toLowerCase().includes(q) ||
        s.vehicle_name?.toLowerCase().includes(q)
      );
    });
    return filtered.sort((a, b) => compareSessions(a, b, sortState));
  }, [sessions, search, sortState]);

  return (
    <div
      className="flex flex-col h-full bg-background"
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Header */}
      <header className="flex items-center gap-3 px-4 h-12 border-b border-border bg-card flex-shrink-0">
        <QuickScopeLogo />
        <div className="flex-1" />

        {/* Connection indicators */}
        <div className="flex items-center gap-3 text-xs">
          {aimStatus?.connected ? (
            <div className="flex items-center gap-1.5 text-emerald-500 dark:text-emerald-400" title={aimStatus.device?.device_name || aimStatus.device?.ip}>
              <Wifi className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                AiM {aimStatus.device?.device_name ? `(${aimStatus.device.device_name})` : 'Connected'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-muted-foreground/50">
              <WifiOff className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">AiM</span>
            </div>
          )}
        </div>

        <ThemeToggle theme={theme} onToggle={onToggleTheme} />

        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </header>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-card/50">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          Upload File
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xrk,.xrz,.XRK,.XRZ"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) handleFileUpload(file);
            e.target.value = '';
          }}
        />

        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-muted/50 text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          Sync
        </button>

        {aimStatus?.connected && (
          <button
            onClick={() => setAimPickerOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Pull from AiM
          </button>
        )}

        {/*
         * Live button is always visible. The LiveView itself probes the
         * device on mount and shows a friendly "device not reachable" state
         * when offline, so users can find the feature without an AiM
         * connected and developers can dev against the empty state.
         */}
        <button
          onClick={onOpenLive}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            aimStatus?.connected
              ? 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 hover:bg-emerald-500/20'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          title={aimStatus?.connected ? 'Stream live data from the AiM device' : 'Open live view (AiM device not currently reachable)'}
        >
          <Activity className="w-3.5 h-3.5" />
          Live
        </button>

        <button
          onClick={async () => {
            if (!showUploadLog) {
              try {
                setUploadLog(await fetchUploadLog());
              } catch {
                setUploadLog([]);
              }
            }
            setShowUploadLog(v => !v);
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            showUploadLog
              ? 'bg-primary/20 text-primary'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          title="Recent uploads (server-side log)"
        >
          <FileClock className="w-3.5 h-3.5" />
          Uploads
        </button>

        <div className="flex-1" />

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
          <input
            type="text"
            placeholder="Search sessions..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-7 pr-3 py-1.5 w-48 rounded-md text-xs bg-muted/30 border border-border/50 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
          />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-md text-xs bg-red-500/10 text-red-500 dark:text-red-400 border border-red-500/20">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Upload progress banner */}
      {uploadProgress && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-md text-xs bg-primary/10 border border-primary/20">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-primary font-medium flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Uploading {formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)}
            </span>
            <span className="text-muted-foreground tabular">{formatRate(uploadProgress.ratePerSec)}</span>
          </div>
          <div className="h-1 bg-muted/50 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-150"
              style={{ width: `${Math.max(2, (uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Upload log panel */}
      {showUploadLog && (
        <div className="mx-4 mt-2 rounded-md border border-border/50 bg-card/50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
            <div className="flex items-center gap-2 text-xs font-medium">
              <FileClock className="w-3.5 h-3.5 text-primary" />
              Recent uploads (server-side log)
            </div>
            <button
              onClick={async () => {
                try {
                  setUploadLog(await fetchUploadLog());
                } catch {
                  setUploadLog([]);
                }
              }}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {uploadLog.length === 0 ? (
              <p className="text-xs text-muted-foreground px-3 py-3">No uploads recorded since the backend started.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground bg-muted/30">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">When</th>
                    <th className="text-left px-3 py-1.5 font-medium">File</th>
                    <th className="text-right px-3 py-1.5 font-medium">Size</th>
                    <th className="text-right px-3 py-1.5 font-medium">Time</th>
                    <th className="text-right px-3 py-1.5 font-medium">Rate</th>
                    <th className="text-left px-3 py-1.5 font-medium">From</th>
                    <th className="text-left px-3 py-1.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {uploadLog.map((e, i) => (
                    <tr key={i} className="border-t border-border/30 hover:bg-muted/20">
                      <td className="px-3 py-1.5 text-muted-foreground tabular">{formatRelativeTime(e.ts)}</td>
                      <td className="px-3 py-1.5 font-mono truncate max-w-[200px]" title={e.filename}>{e.filename}</td>
                      <td className="px-3 py-1.5 text-right tabular">{formatBytes(e.size)}</td>
                      <td className="px-3 py-1.5 text-right tabular">{e.duration_s.toFixed(2)}s</td>
                      <td className="px-3 py-1.5 text-right tabular">
                        {e.duration_s > 0 ? formatRate(e.size / e.duration_s) : '—'}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{e.client_ip}</td>
                      <td className="px-3 py-1.5">
                        <span className={
                          e.status === 'ok'
                            ? 'text-emerald-500 dark:text-emerald-400'
                            : 'text-red-500 dark:text-red-400'
                        } title={e.error}>
                          {e.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Sort column headers (hidden when there are no sessions at all) */}
      {sessions.length > 0 && (
        <div
          role="row"
          className="flex items-center gap-2 px-4 py-1.5 border-b border-border/40 bg-card/30 text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex-shrink-0"
        >
          <span className="hidden sm:inline mr-1 normal-case tracking-normal text-muted-foreground/60">Sort by</span>
          <SortHeader label="Date" sortKey="date" state={sortState} onClick={handleSortClick} />
          <SortHeader label="Track" sortKey="track" state={sortState} onClick={handleSortClick} />
          <SortHeader label="Duration" sortKey="duration" state={sortState} onClick={handleSortClick} />
          <div className="flex-1" />
          {sortState.key !== null && (
            <button
              onClick={clearSort}
              className="px-2 py-0.5 rounded text-[10px] normal-case tracking-normal text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              title="Clear sort (default: newest first)"
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {sortedSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground/60">
            {sessions.length === 0 ? (
              <>
                <div className="w-16 h-16 rounded-full bg-muted/20 border border-border/50 flex items-center justify-center">
                  <Upload className="w-7 h-7" />
                </div>
                <p className="text-sm font-medium text-foreground/60">No sessions yet</p>
                <p className="text-xs text-center max-w-xs">
                  Upload a <span className="font-mono text-primary/80">.xrk</span> file, sync from Railway, or pull from an AiM device to get started.
                </p>
              </>
            ) : (
              <p className="text-sm">No sessions match your search</p>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            {sortedSessions.map(session => {
              const isLoading = loadingId === session.id;
              const isPulling = pullingId === session.id;
              const statusCfg = SYNC_STATUS_CONFIG[session.sync_status];
              const sourceCfg = SOURCE_CONFIG[session.source];
              const StatusIcon = statusCfg.icon;
              const SourceIcon = sourceCfg.icon;

              return (
                <button
                  key={session.id}
                  onClick={() => handleSessionClick(session)}
                  disabled={isLoading || isPulling}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left bg-[hsl(225,30%,95%)] dark:bg-card border border-[hsl(225,25%,85%)] dark:border-border/50 hover:bg-[hsl(225,35%,91%)] dark:hover:bg-muted hover:border-[hsl(225,30%,78%)] dark:hover:border-border transition-colors disabled:opacity-60 group"
                >
                  {/* Status indicator */}
                  <div className="flex-shrink-0">
                    <StatusIcon className={`w-4 h-4 ${statusCfg.color}`} />
                  </div>

                  {/* GPS thumbnail (only for sessions with a local file) */}
                  {session.local_path && (
                    <GPSThumbnail sessionId={session.id} size={36} />
                  )}

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {renamingId === session.id ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onBlur={submitRename}
                          onKeyDown={e => {
                            if (e.key === 'Enter') submitRename();
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          onClick={e => e.stopPropagation()}
                          className="text-sm font-medium text-foreground bg-muted/50 border border-primary/50 rounded px-1.5 py-0.5 outline-none w-full max-w-[260px]"
                          autoFocus
                        />
                      ) : (
                        <span className="text-sm font-medium text-foreground truncate">
                          {session.aim_session_id || session.filename}
                        </span>
                      )}
                      {session.track_name && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary dark:text-primary border border-primary/20 flex-shrink-0">
                          {session.track_name}
                        </span>
                      )}
                      {session.sync_status === 'remote_only' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 dark:text-blue-400 flex-shrink-0">
                          click to download
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      {session.driver_name && <span>{session.driver_name}</span>}
                      {session.vehicle_name && <span>{session.vehicle_name}</span>}
                      {session.recorded_at && <span>{formatDate(session.recorded_at)}</span>}
                    </div>
                  </div>

                  {/* Meta pills */}
                  <div className="hidden sm:flex items-center gap-2 flex-shrink-0 text-xs text-muted-foreground">
                    <span className="tabular">{formatDuration(session.duration_s)}</span>
                    {session.lap_count > 0 && (
                      <span>{session.lap_count} laps</span>
                    )}
                    <span title={sourceCfg.label} className="inline-flex">
                      <SourceIcon className="w-3 h-3" />
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {(isLoading || isPulling) ? (
                      <Loader2 className="w-4 h-4 text-primary animate-spin" />
                    ) : (
                      <>
                        <button
                          onClick={(e) => startRename(e, session)}
                          className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all"
                          title="Rename"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => handleDelete(e, session.id)}
                          className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 dark:hover:text-red-400 transition-all"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary/50 flex items-center justify-center z-10 rounded-lg">
          <div className="bg-card/90 rounded-xl px-6 py-4 text-center">
            <Upload className="w-6 h-6 text-primary mx-auto mb-2" />
            <p className="text-sm font-medium text-foreground">Drop .xrk / .xrz file to upload</p>
          </div>
        </div>
      )}

      {/* AiM Session Picker */}
      {aimPickerOpen && (
        <AimSessionPicker
          onClose={() => setAimPickerOpen(false)}
          onDownloaded={handleAimPickerDownloaded}
        />
      )}

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border/50 bg-card/30 text-xs text-muted-foreground/50">
        {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        {sessions.filter(s => s.sync_status === 'synced').length > 0 &&
          ` \u00b7 ${sessions.filter(s => s.sync_status === 'synced').length} synced`}
      </div>
    </div>
  );
}


