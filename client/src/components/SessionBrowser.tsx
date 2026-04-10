import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listSessions, loadSession, syncSessions, pullSession, deleteSession,
  getAimStatus, pullFromAim, uploadFile,
  type LocalSession, type SessionInfo, type AimStatus,
} from '../lib/api';
import {
  RefreshCw, Cloud, CloudOff, Wifi, WifiOff, Upload, Trash2,
  Download, CheckCircle, Clock, Loader2, HardDrive, Radio,
  ChevronRight, Search, Settings,
} from 'lucide-react';

interface SessionBrowserProps {
  onSessionLoaded: (info: SessionInfo, sessionId: string, fileName: string) => void;
  onOpenSettings: () => void;
}

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
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

const SYNC_STATUS_CONFIG = {
  synced: { icon: CheckCircle, label: 'Synced', color: 'text-emerald-400' },
  local_only: { icon: HardDrive, label: 'Local only', color: 'text-amber-400' },
  remote_only: { icon: Cloud, label: 'Remote', color: 'text-blue-400' },
  uploading: { icon: Loader2, label: 'Uploading...', color: 'text-amber-400 animate-spin' },
  downloading: { icon: Loader2, label: 'Downloading...', color: 'text-blue-400 animate-spin' },
} as const;

const SOURCE_CONFIG = {
  manual_upload: { icon: Upload, label: 'Uploaded' },
  aim_device: { icon: Radio, label: 'AiM' },
  railway: { icon: Cloud, label: 'Railway' },
} as const;

export function SessionBrowser({ onSessionLoaded, onOpenSettings }: SessionBrowserProps) {
  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [aimStatus, setAimStatus] = useState<AimStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pullingAim, setPullingAim] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [pullingId, setPullingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handlePullAim = useCallback(async () => {
    setPullingAim(true);
    setError(null);
    try {
      const result = await pullFromAim();
      await refreshSessions();
      if (result.error) {
        setError(result.error);
      } else if (result.errors?.length) {
        setError(`Some downloads failed: ${result.errors.join('; ')}`);
      } else if (result.downloaded?.length === 0) {
        setError(result.message || 'No new sessions found on device');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AiM pull failed');
    } finally {
      setPullingAim(false);
    }
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
    try {
      await deleteSession(sessionId);
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }, [refreshSessions]);

  const handleFileUpload = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.xrk') && !file.name.toLowerCase().endsWith('.xrz')) return;
    setLoadingId('upload');
    setError(null);
    try {
      const info = await uploadFile(file);
      await refreshSessions();
      // Find the new session (most recent)
      const updated = await listSessions();
      const newest = updated.find(s => s.filename === file.name);
      if (newest) {
        onSessionLoaded(info, newest.id, file.name);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setLoadingId(null);
    }
  }, [onSessionLoaded, refreshSessions]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  const filteredSessions = sessions.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.filename.toLowerCase().includes(q) ||
      s.track_name?.toLowerCase().includes(q) ||
      s.driver_name?.toLowerCase().includes(q) ||
      s.vehicle_name?.toLowerCase().includes(q)
    );
  });

  // Sort: most recent first
  const sortedSessions = [...filteredSessions].sort((a, b) => {
    const da = a.recorded_at || a.created_at;
    const db = b.recorded_at || b.created_at;
    return db.localeCompare(da);
  });

  const railwayConfigured = sessions.length > 0 || syncing;

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
            <div className="flex items-center gap-1.5 text-emerald-400" title={aimStatus.device?.device_name || aimStatus.device_ip}>
              <Wifi className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                AiM {aimStatus.device?.device_name ? `(${aimStatus.device.device_name})` : 'Connected'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-muted-foreground/50" title={`Probing ${aimStatus?.device_ip || '10.0.0.1'}:36002`}>
              <WifiOff className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">AiM</span>
            </div>
          )}
        </div>

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
            onClick={handlePullAim}
            disabled={pullingAim}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
          >
            {pullingAim ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            Pull from AiM
          </button>
        )}

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
        <div className="mx-4 mt-2 px-3 py-2 rounded-md text-xs bg-red-500/10 text-red-400 border border-red-500/20">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
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
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left bg-card/50 border border-border/30 hover:border-border hover:bg-card transition-colors disabled:opacity-60 group"
                >
                  {/* Status indicator */}
                  <div className="flex-shrink-0">
                    <StatusIcon className={`w-4 h-4 ${statusCfg.color}`} />
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {session.aim_session_id || session.filename}
                      </span>
                      {session.sync_status === 'remote_only' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 flex-shrink-0">
                          click to download
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      {session.track_name && <span>{session.track_name}</span>}
                      {session.driver_name && <span>{session.driver_name}</span>}
                      {session.recorded_at && <span>{formatDate(session.recorded_at)}</span>}
                    </div>
                  </div>

                  {/* Meta pills */}
                  <div className="hidden sm:flex items-center gap-2 flex-shrink-0 text-xs text-muted-foreground">
                    <span className="tabular">{formatDuration(session.duration_s)}</span>
                    {session.lap_count > 0 && (
                      <span>{session.lap_count} laps</span>
                    )}
                    <SourceIcon className="w-3 h-3" title={sourceCfg.label} />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {(isLoading || isPulling) ? (
                      <Loader2 className="w-4 h-4 text-primary animate-spin" />
                    ) : (
                      <>
                        <button
                          onClick={(e) => handleDelete(e, session.id)}
                          className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all"
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

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border/50 bg-card/30 text-xs text-muted-foreground/50">
        {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        {sessions.filter(s => s.sync_status === 'synced').length > 0 &&
          ` \u00b7 ${sessions.filter(s => s.sync_status === 'synced').length} synced`}
      </div>
    </div>
  );
}


function QuickScopeLogo() {
  return (
    <div className="flex items-center gap-2">
      <svg width="28" height="28" viewBox="0 0 40 40" fill="none" aria-label="QuickScope">
        <rect width="40" height="40" rx="8" fill="hsl(230 25% 10%)"/>
        <circle cx="20" cy="20" r="11" stroke="#4361ee" strokeWidth="2.5"/>
        <line x1="20" y1="5" x2="20" y2="13" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round"/>
        <line x1="20" y1="27" x2="20" y2="35" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round"/>
        <line x1="5" y1="20" x2="13" y2="20" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round"/>
        <line x1="27" y1="20" x2="35" y2="20" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round"/>
        <polyline points="13,22 16,17 19,23 22,18 25,21 27,20" stroke="#f77f00" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        <circle cx="20" cy="20" r="2" fill="#f77f00"/>
      </svg>
      <span className="text-base font-semibold text-foreground tracking-tight">QuickScope</span>
    </div>
  );
}
