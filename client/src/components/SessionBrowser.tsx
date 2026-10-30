import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  listSessions, loadSession, deleteSession,
  renameSession, getAimStatus, uploadFile,
  type LocalSession, type SessionInfo, type AimStatus,
} from '../lib/api';
import { Loader2, MoreHorizontal, Plus, Search, Upload, X, FileClock, Settings } from 'lucide-react';
import { AimSessionPicker } from './AimSessionPicker';
import { QuickScopeLogo } from './QuickScopeLogo';
import { ThemeToggle } from './ThemeToggle';
import { Button } from './ui/Button';
import { MenuButton } from './ui/Menu';
import { AimStatusChip } from './sessions/AimStatusChip';
import { ActivitySheet, formatBytes, formatRate } from './sessions/ActivitySheet';
import { SessionRow } from './sessions/SessionRow';
import { groupSessionsByDate } from '../lib/session-groups';

interface SessionBrowserProps {
  onSessionLoaded: (info: SessionInfo, sessionId: string, fileName: string, source: LocalSession['source']) => void;
  onOpenSettings: () => void;
  onOpenLive: (device: AimStatus['device']) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

function pathStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

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
  const [showActivityLog, setShowActivityLog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const handleDelete = useCallback(async (sessionId: string) => {
    if (!window.confirm('Delete this session from local storage?')) return;
    try {
      await deleteSession(sessionId);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [refreshSessions]);

  const startRename = useCallback((session: LocalSession) => {
    renameDoneRef.current = false;
    setRenamingId(session.id);
    setRenameValue(session.aim_session_id || pathStem(session.filename));
  }, []);

  const cancelRename = useCallback(() => {
    renameDoneRef.current = true;
    setRenamingId(null);
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

  const filteredSessions = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(s =>
      s.filename.toLowerCase().includes(q) ||
      s.track_name?.toLowerCase().includes(q) ||
      s.driver_name?.toLowerCase().includes(q) ||
      s.vehicle_name?.toLowerCase().includes(q)
    );
  }, [sessions, search]);

  const groups = useMemo(() => groupSessionsByDate(filteredSessions, new Date()), [filteredSessions]);

  return (
    <div
      className="relative flex flex-col h-full bg-background"
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Header */}
      <header className="flex items-center gap-3 px-4 h-[52px] border-b border-separator bg-card flex-shrink-0">
        <QuickScopeLogo />
        <div className="flex-1" />
        <AimStatusChip
          status={aimStatus}
          onPull={() => setAimPickerOpen(true)}
          onOpenLive={() => onOpenLive(aimStatus?.connected ? aimStatus.device : null)}
          onRecheck={checkAimStatus}
          onOpenSettings={onOpenSettings}
        />
        <MenuButton
          label="More"
          align="right"
          icon={<MoreHorizontal size={16} aria-hidden="true" />}
          items={[
            { label: 'Activity', icon: FileClock, onSelect: () => setShowActivityLog(true) },
            { label: 'Settings…', icon: Settings, onSelect: onOpenSettings },
          ]}
        />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </header>

      {/* Scroll body */}
      <div id="session-list-scroll" className="flex-1 overflow-y-auto px-10 py-8">
        <div className="mx-auto max-w-[1080px]">
          <div className="flex items-baseline gap-3">
            <h1 className="m-0 font-display text-[28px] font-bold tracking-[-0.022em] text-foreground">Sessions</h1>
            {!sessionsLoading && (
              <span aria-label={`${sessions.length} session${sessions.length !== 1 ? 's' : ''}`} className="text-[17px] text-label-3">
                {sessions.length}
              </span>
            )}
            <div className="flex-1" />
            <div className="relative self-center">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-label-3" aria-hidden="true" />
              <input
                type="text"
                aria-label="Search sessions"
                placeholder="Search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 w-[250px] rounded-[7px] bg-muted pl-8 pr-3 text-[13px] text-foreground placeholder:text-label-3 outline-none focus-visible:outline-2 focus-visible:outline-primary"
              />
            </div>
            <Button variant="primary" size="lg" className="self-center" onClick={() => fileInputRef.current?.click()}>
              <Plus size={14} aria-hidden="true" />
              Import
            </Button>
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
          </div>

          {/* Status strip: error or upload progress, never both */}
          {error ? (
            <div className="mt-4 flex items-center gap-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
              <span className="min-w-0 flex-1">{error}</span>
              <Button variant="plain" size="sm" onClick={() => setError(null)}>
                <X size={12} aria-hidden="true" />
                Dismiss
              </Button>
            </div>
          ) : uploadProgress ? (
            <div className="mt-4 rounded-lg bg-primary/10 px-3 py-2 text-[12.5px]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-medium text-primary">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Uploading {formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)}
                </span>
                <span className="tabular text-muted-foreground">{formatRate(uploadProgress.ratePerSec)}</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-[width] duration-150"
                  style={{ width: `${Math.max(2, (uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}%` }}
                />
              </div>
            </div>
          ) : null}

          {sessionsLoading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
              <Loader2 className="w-8 h-8 text-primary animate-spin" aria-hidden />
              <p className="text-sm font-medium">Loading sessions...</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
              {sessions.length === 0 ? (
                <>
                  <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                    <Upload className="w-7 h-7" />
                  </div>
                  <p className="text-sm font-medium text-foreground">No sessions yet</p>
                  <p className="text-xs text-center max-w-xs">
                    Upload a <span className="font-mono text-primary">.xrk</span> file or pull from an AiM device to get started.
                  </p>
                </>
              ) : (
                <p className="text-sm">No sessions match your search</p>
              )}
            </div>
          ) : (
            groups.map(group => (
              <section key={group.label} className="mt-6">
                <h2 className="mb-2 ml-1 text-[13px] font-semibold text-muted-foreground">{group.label}</h2>
                <div className="overflow-hidden rounded-xl bg-popover">
                  {group.sessions.map((session, i) => (
                    <div key={session.id} className="relative">
                      {i > 0 && <div className="pointer-events-none absolute left-[74px] right-0 top-0 h-[0.5px] bg-separator" />}
                      <SessionRow
                        session={session}
                        loading={loadingId === session.id}
                        renaming={renamingId === session.id}
                        renameValue={renameValue}
                        onOpen={() => handleSessionClick(session)}
                        onStartRename={() => startRename(session)}
                        onRenameChange={setRenameValue}
                        onRenameSubmit={submitRename}
                        onRenameCancel={cancelRename}
                        onDelete={() => handleDelete(session.id)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
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

      {showActivityLog && <ActivitySheet onClose={() => setShowActivityLog(false)} />}

      {/* AiM Session Picker */}
      {aimPickerOpen && (
        <AimSessionPicker
          onClose={() => setAimPickerOpen(false)}
          onDownloaded={handleAimPickerDownloaded}
        />
      )}
    </div>
  );
}
