import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  listSessions, loadSession, deleteSession,
  renameSession, getAimStatus, uploadFile, fetchUploadLog, fetchAimPullLog,
  type LocalSession, type SessionInfo, type AimStatus, type UploadLogEntry,
  type AimPullLogEntry,
} from '../lib/api';
import {
  RefreshCw, Wifi, WifiOff, Upload, Trash2,
  Download, Loader2, Radio,
  ChevronRight, Search, Settings, Pencil, Activity, FileClock,
} from 'lucide-react';
import { AimSessionPicker } from './AimSessionPicker';
import { Presence } from '../lib/motion';
import { QuickScopeLogo } from './QuickScopeLogo';
import { ThemeToggle } from './ThemeToggle';
import { GPSThumbnail } from './GPSThumbnail';

interface SessionBrowserProps {
  onSessionLoaded: (info: SessionInfo, sessionId: string, fileName: string, source: LocalSession['source']) => void;
  onOpenSettings: () => void;
  onOpenLive: (device: AimStatus['device']) => void;
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
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function pathStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

const SOURCE_CONFIG = {
  manual_upload: { icon: Upload, label: 'Uploaded' },
  aim_device: { icon: Radio, label: 'AiM' },
} as const;

export function SessionBrowser({ onSessionLoaded, onOpenSettings, onOpenLive, theme, onToggleTheme }: SessionBrowserProps) {
  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [aimStatus, setAimStatus] = useState<AimStatus | null>(null);
  const [aimPickerOpen, setAimPickerOpen] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [uploadProgress, setUploadProgress] = useState<{
    loaded: number; total: number; ratePerSec: number;
  } | null>(null);
  const [uploadLog, setUploadLog] = useState<UploadLogEntry[]>([]);
  const [aimPullLog, setAimPullLog] = useState<AimPullLogEntry[]>([]);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [activityTab, setActivityTab] = useState<'uploads' | 'aim'>('uploads');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Enter commits and then the input's blur fires too; only the first counts.
  const renameDoneRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
    } catch (e) {
      console.error('Failed to list sessions:', e);
    } finally {
      setSessionsLoading(false);
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

  const hasIndexingSessions = sessions.some(s => s.index_status === 'pending');
  useEffect(() => {
    if (!hasIndexingSessions) return;
    const interval = setInterval(refreshSessions, 1500);
    return () => clearInterval(interval);
  }, [hasIndexingSessions, refreshSessions]);

  const handleAimPickerDownloaded = useCallback(() => {
    refreshSessions();
  }, [refreshSessions]);

  const handleSessionClick = useCallback(async (session: LocalSession) => {
    setLoadingId(session.id);
    try {
      const info = await loadSession(session.id);
      onSessionLoaded(info, session.id, session.filename, session.source);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoadingId(null);
    }
  }, [onSessionLoaded]);

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
    renameDoneRef.current = false;
    setRenamingId(session.id);
    setRenameValue(session.aim_session_id || pathStem(session.filename));
    setTimeout(() => renameInputRef.current?.select(), 0);
  }, []);

  const submitRename = useCallback(async () => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
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
      const newest = info.sessionId
        ? updated.find(s => s.id === info.sessionId)
        : updated.find(s => s.filename === file.name);
      if (newest) {
        onSessionLoaded(info, newest.id, file.name, newest.source);
      } else if (info.sessionId) {
        onSessionLoaded(info, info.sessionId, file.name, 'manual_upload');
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
    return filtered.sort((a, b) => {
      const da = a.recorded_at || a.created_at;
      const db = b.recorded_at || b.created_at;
      return db.localeCompare(da);
    });
  }, [sessions, search]);

  // Month groups ("October 2026") so a long history reads like a calendar,
  // not one undifferentiated list. Order within and across groups is unchanged.
  const sessionGroups = useMemo(() => {
    const groups: { label: string; items: typeof sortedSessions }[] = [];
    for (const s of sortedSessions) {
      const d = new Date(s.recorded_at || s.created_at);
      const label = isNaN(d.getTime()) ? 'Undated' : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(s);
      else groups.push({ label, items: [s] });
    }
    return groups;
  }, [sortedSessions]);

  return (
    <div
      className="flex flex-col h-full bg-background"
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Toolbar — one bar, every action visible. Views leads: it's the
          trackside entry point. Status colors mean status only (green = AiM
          reachable); the Views button's tint is emphasis. */}
      <header className="flex items-center gap-2 px-4 h-14 border-b border-border bg-card flex-shrink-0">
        <QuickScopeLogo />
        <div className="w-px h-6 bg-border mx-2" />

        {/*
         * Live opens the dashboard and starts the live TCP session immediately
         * (same idea as Race Studio’s first screen after selecting the logger).
         */}
        <button
          onClick={() => onOpenLive(aimStatus?.connected ? aimStatus.device : null)}
          className="flex items-center gap-2 h-8 px-3.5 rounded-lg text-[13px] font-semibold bg-primary/15 text-primary-text hover:bg-primary/25 transition-colors"
          title={aimStatus?.connected ? 'Open Views: stream live data from the AiM device' : 'Open Views (offline preview: AiM device not reachable)'}
        >
          <Activity className="w-4 h-4" />
          Views
        </button>

        <button
          onClick={() => setAimPickerOpen(true)}
          className={`flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium transition-colors ${
            aimStatus?.connected
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20'
              : 'text-foreground/85 hover:bg-muted'
          }`}
          title={aimStatus?.connected ? 'Download sessions from AiM device' : 'Pull sessions from AiM (device not currently reachable via WiFi)'}
        >
          <Download className="w-4 h-4" />
          Pull
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium text-foreground/85 hover:bg-muted transition-colors"
          title="Upload an .xrk / .xrz file"
        >
          <Upload className="w-4 h-4" />
          Upload
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
          onClick={async () => {
            if (!showActivityLog) {
              try {
                const [uploads, aimPulls] = await Promise.all([
                  fetchUploadLog(),
                  fetchAimPullLog(),
                ]);
                setUploadLog(uploads);
                setAimPullLog(aimPulls);
              } catch {
                setUploadLog([]);
                setAimPullLog([]);
              }
            }
            setShowActivityLog(v => !v);
          }}
          className={`flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium transition-colors ${
            showActivityLog
              ? 'bg-primary/15 text-primary-text'
              : 'text-foreground/85 hover:bg-muted'
          }`}
          title="Recent uploads and AiM pulls (server-side log)"
          aria-pressed={showActivityLog}
        >
          <FileClock className="w-4 h-4" />
          Activity
        </button>

        <div className="flex-1" />

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search sessions..."
            aria-label="Search sessions"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 pr-3 h-8 w-56 rounded-lg text-[13px] bg-muted/60 border border-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:bg-background transition-colors"
          />
        </div>

        {/* AiM connection, in words rather than a faded icon */}
        {aimStatus?.connected ? (
          <div className="hidden md:flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 ml-2" title={aimStatus.device?.device_name || aimStatus.device?.ip}>
            <Wifi className="w-3.5 h-3.5" />
            AiM {aimStatus.device?.device_name ? `(${aimStatus.device.device_name})` : 'Connected'}
          </div>
        ) : (
          <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground ml-2" title="AiM device not reachable over WiFi">
            <WifiOff className="w-3.5 h-3.5" />
            AiM offline
          </div>
        )}

        <div className="w-px h-6 bg-border mx-1" />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Settings"
          aria-label="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </header>

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
            <span className="text-primary-text font-medium flex items-center gap-1.5">
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

      {/* Activity log panel */}
      {showActivityLog && (
        <div className="mx-4 mt-2 rounded-md border border-border/50 bg-card/50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
            <div className="flex items-center gap-2 text-xs font-medium">
              <FileClock className="w-3.5 h-3.5 text-primary-text" />
              Activity (server-side log)
              <div className="flex rounded-md border border-border/50 overflow-hidden ml-2">
                <button
                  onClick={() => setActivityTab('uploads')}
                  className={`px-2 py-0.5 text-[10px] ${activityTab === 'uploads' ? 'bg-primary/20 text-primary-text' : 'text-muted-foreground hover:bg-muted/50'}`}
                >
                  Uploads
                </button>
                <button
                  onClick={() => setActivityTab('aim')}
                  className={`px-2 py-0.5 text-[10px] ${activityTab === 'aim' ? 'bg-primary/20 text-primary-text' : 'text-muted-foreground hover:bg-muted/50'}`}
                >
                  AiM Pulls
                </button>
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  const [uploads, aimPulls] = await Promise.all([
                    fetchUploadLog(),
                    fetchAimPullLog(),
                  ]);
                  setUploadLog(uploads);
                  setAimPullLog(aimPulls);
                } catch {
                  setUploadLog([]);
                  setAimPullLog([]);
                }
              }}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {activityTab === 'uploads' ? (
              uploadLog.length === 0 ? (
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
              )
            ) : aimPullLog.length === 0 ? (
              <p className="text-xs text-muted-foreground px-3 py-3">No AiM list/pull attempts recorded since the backend started.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground bg-muted/30">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">When</th>
                    <th className="text-left px-3 py-1.5 font-medium">Action</th>
                    <th className="text-left px-3 py-1.5 font-medium">File</th>
                    <th className="text-right px-3 py-1.5 font-medium">Size</th>
                    <th className="text-right px-3 py-1.5 font-medium">Time</th>
                    <th className="text-left px-3 py-1.5 font-medium">Device</th>
                    <th className="text-left px-3 py-1.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {aimPullLog.map((e, i) => (
                    <tr key={i} className="border-t border-border/30 hover:bg-muted/20">
                      <td className="px-3 py-1.5 text-muted-foreground tabular">{formatRelativeTime(e.ts)}</td>
                      <td className="px-3 py-1.5">{e.action}</td>
                      <td className="px-3 py-1.5 font-mono truncate max-w-[160px]" title={e.filename}>
                        {e.filename || (e.session_count != null ? `${e.session_count} sessions` : '—')}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular">{e.size > 0 ? formatBytes(e.size) : '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular">{e.duration_s > 0 ? `${e.duration_s.toFixed(2)}s` : '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{e.device_ip || '—'}</td>
                      <td className="px-3 py-1.5">
                        <span className={
                          e.status === 'ok' || e.status === 'list_ok'
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

      {/* Session list */}
      <div id="session-list-scroll" className="flex-1 overflow-y-auto px-4 py-3">
        {sessionsLoading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <Loader2 className="w-8 h-8 text-primary-text animate-spin" aria-hidden />
            <p className="text-sm font-medium text-foreground/60">Loading sessions...</p>
          </div>
        ) : sortedSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            {sessions.length === 0 ? (
              <>
                <div className="w-16 h-16 rounded-full bg-muted/20 border border-border/50 flex items-center justify-center">
                  <Upload className="w-7 h-7" />
                </div>
                <p className="text-sm font-medium text-foreground/60">No sessions yet</p>
                <p className="text-xs text-center max-w-xs">
                  Upload a <span className="font-mono text-primary-text/80">.xrk</span> file or pull from an AiM device to get started.
                </p>
              </>
            ) : (
              <p className="text-sm">No sessions match your search</p>
            )}
          </div>
        ) : (
          <div className="space-y-5 max-w-5xl mx-auto">
            {sessionGroups.map(group => (
            <section key={group.label} aria-label={group.label}>
              <h2 className="px-1 mb-1.5 text-xs font-semibold text-muted-foreground">{group.label}</h2>
              <div className="rounded-xl border border-[hsl(225,25%,85%)] dark:border-border/60 bg-[hsl(225,30%,97%)] dark:bg-card overflow-hidden divide-y divide-[hsl(225,25%,88%)] dark:divide-border/50">
            {group.items.map(session => {
              const isLoading = loadingId === session.id;
              const sourceCfg = SOURCE_CONFIG[session.source];
              const SourceIcon = sourceCfg.icon;

              return (
                // A div, not a <button>: the row contains its own <input> and action buttons,
                // and interactive content nested in a button is invalid HTML.
                <div
                  key={session.id}
                  role="button"
                  tabIndex={isLoading ? -1 : 0}
                  aria-disabled={isLoading}
                  onClick={() => { if (!isLoading) handleSessionClick(session); }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || isLoading) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSessionClick(session);
                    }
                  }}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-[hsl(225,35%,93%)] dark:hover:bg-muted/70 focus-visible:bg-muted/70 transition-colors group ${isLoading ? 'opacity-60' : 'cursor-pointer'}`}
                >
                  {/* GPS thumbnail (only for sessions with a local file) */}
                  {session.local_path ? (
                    <GPSThumbnail sessionId={session.id} size={36} />
                  ) : (
                    <div aria-hidden className="w-9 h-9 rounded-md bg-muted/50 flex-shrink-0" />
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
                            if (e.key === 'Escape') {
                              renameDoneRef.current = true;
                              setRenamingId(null);
                            }
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
                    </div>
                    {/* One quiet details line; each item its own node, dot-separated */}
                    <div className="flex items-center mt-0.5 text-xs text-muted-foreground min-w-0 overflow-hidden whitespace-nowrap">
                      {[session.vehicle_name, session.track_name, session.driver_name, session.recorded_at && formatDate(session.recorded_at)]
                        .filter(Boolean)
                        .map((item, i) => (
                          <span key={i} className="flex items-center min-w-0">
                            {i > 0 && <span aria-hidden className="mx-1.5 text-muted-foreground/60">·</span>}
                            <span className="truncate">{item}</span>
                          </span>
                        ))}
                    </div>
                  </div>

                  {/* Meta pills */}
                  <div className="hidden sm:flex items-center gap-4 flex-shrink-0 text-[13px] text-muted-foreground">
                    {session.index_status === 'pending' ? (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary-text"
                        title="Downloaded; reading laps and metadata in the background"
                      >
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        Indexing
                      </span>
                    ) : null}
                    {/* Fixed-width, right-aligned columns so numbers line up row to row */}
                    <span className="w-14 text-right tabular">{session.lap_count > 0 ? `${session.lap_count} laps` : ''}</span>
                    {session.index_status !== 'pending' && (
                      <span className="w-16 text-right tabular text-foreground">{formatDuration(session.duration_s)}</span>
                    )}
                    <span title={sourceCfg.label} aria-label={sourceCfg.label} className="inline-flex w-4 justify-center">
                      <SourceIcon className="w-3.5 h-3.5" />
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isLoading ? (
                      <Loader2 className="w-4 h-4 text-primary-text animate-spin" />
                    ) : (
                      <>
                        <button
                          onClick={(e) => startRename(e, session)}
                          className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary-text transition-all"
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
                </div>
              );
            })}
              </div>
            </section>
            ))}
          </div>
        )}
      </div>

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary/50 flex items-center justify-center z-10 rounded-lg">
          <div className="bg-card/90 rounded-xl px-6 py-4 text-center">
            <Upload className="w-6 h-6 text-primary-text mx-auto mb-2" />
            <p className="text-sm font-medium text-foreground">Drop .xrk / .xrz file to upload</p>
          </div>
        </div>
      )}

      {/* AiM Session Picker */}
      <Presence show={aimPickerOpen}>
        {aimPickerOpen && (
        <AimSessionPicker
          onClose={() => setAimPickerOpen(false)}
          onDownloaded={handleAimPickerDownloaded}
        />
        )}
      </Presence>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border/50 bg-card/30 text-xs text-muted-foreground">
        {sessionsLoading
          ? 'Loading sessions…'
          : `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}
      </div>
    </div>
  );
}


