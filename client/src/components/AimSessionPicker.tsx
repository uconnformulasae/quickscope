import { useState, useEffect, useCallback, useRef } from 'react';
import { Download, Loader2, CheckCircle, HardDrive, Radio } from 'lucide-react';
import {
  listAimSessions,
  pullFromAim,
  fetchAimPullProgress,
  type AimSession,
  type AimPullProgress,
  type AimIndexStatus,
} from '../lib/api';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Button';
import { formatAimDeviceListDate } from '../lib/time-format';

interface AimSessionPickerProps {
  onClose: () => void;
  onDownloaded: () => void;
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '--';
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

function mergePullProgress(queue: string[], server: AimPullProgress): Record<string, number> {
  const next: Record<string, number> = {};
  for (const name of queue) next[name] = 0;
  if (!server.active) return next;

  const completedCount = Math.max(0, server.file_index - 1);
  for (let i = 0; i < completedCount && i < queue.length; i++) {
    next[queue[i]] = 100;
  }

  const current = server.filename;
  if (!current || !queue.includes(current)) return next;

  if (server.bytes_total > 0) {
    next[current] = Math.min(100, Math.round((server.bytes_received / server.bytes_total) * 100));
  }
  return next;
}

function isIndexingInFlight(status: AimIndexStatus | undefined): boolean {
  return status === 'pending' || status === 'running';
}

function pickIndexing(queue: string[], server: AimPullProgress): Record<string, AimIndexStatus> {
  const picked: Record<string, AimIndexStatus> = {};
  for (const name of queue) {
    const status = server.indexing?.[name];
    if (status) picked[name] = status;
  }
  return picked;
}

const INDEX_BADGE: Record<AimIndexStatus, { label: string; className: string }> = {
  pending: { label: 'indexing', className: 'bg-primary/10 text-primary' },
  running: { label: 'indexing', className: 'bg-primary/10 text-primary' },
  ok: { label: 'indexed', className: 'bg-success/10 text-success' },
  failed: { label: 'parse warning', className: 'bg-warning/10 text-warning' },
};

export function AimSessionPicker({ onClose, onDownloaded }: AimSessionPickerProps) {
  const [sessions, setSessions] = useState<AimSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [pullPercent, setPullPercent] = useState<Record<string, number>>({});
  const [indexing, setIndexing] = useState<Record<string, AimIndexStatus>>({});
  const [downloadResult, setDownloadResult] = useState<string | null>(null);
  const pullPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Polling outlives the pull request: indexing runs after the device is released.
  const isPullingRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listAimSessions()
      .then(result => {
        if (!result.ok) {
          setError(result.error || 'Failed to list sessions');
        } else {
          setSessions(result.sessions);
        }
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed'))
      .finally(() => setLoading(false));
  }, []);

  const toggleSelect = useCallback((filename: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(sessions.filter(s => !s.already_downloaded).map(s => s.filename)));
  }, [sessions]);

  const selectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const stopPullPoll = useCallback(() => {
    if (pullPollRef.current !== null) {
      clearInterval(pullPollRef.current);
      pullPollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPullPoll(), [stopPullPoll]);

  const pollPullProgress = useCallback((queue: string[]) => {
    fetchAimPullProgress()
      .then(progress => {
        if (progress.active) setPullPercent(mergePullProgress(queue, progress));
        const picked = pickIndexing(queue, progress);
        setIndexing(prev => ({ ...prev, ...picked }));
        const isIndexing = Object.values(picked).some(isIndexingInFlight);
        if (!isPullingRef.current && !isIndexing) {
          stopPullPoll();
          onDownloaded();
        }
      })
      .catch(err => console.warn('AiM pull progress poll failed:', err));
  }, [stopPullPoll, onDownloaded]);

  const handleDownload = useCallback(async () => {
    if (selected.size === 0) return;
    const queue = Array.from(selected);
    setDownloading(true);
    setPullPercent(Object.fromEntries(queue.map(name => [name, 0])));
    setError(null);
    setDownloadResult(null);
    stopPullPoll();
    isPullingRef.current = true;
    pullPollRef.current = setInterval(() => pollPullProgress(queue), 200);
    try {
      const result = await pullFromAim(queue);
      if (result.error) {
        setError(result.error);
      } else {
        const count = result.downloaded?.length || 0;
        const errCount = result.errors?.length || 0;
        if (errCount > 0) {
          setError(`${errCount} download(s) failed: ${result.errors!.join('; ')}`);
        }
        if (count > 0) {
          const summaries = (result.results || [])
            .filter(r => result.downloaded?.includes(r.filename))
            .map(r => `${r.filename} · ${formatSize(r.bytes)} · downloaded in ${r.duration_s.toFixed(1)}s`);
          setDownloadResult(
            summaries.length > 0
              ? summaries.join('\n')
              : `Downloaded ${count} session${count !== 1 ? 's' : ''}`,
          );
          setIndexing(prev => ({
            ...prev,
            ...Object.fromEntries((result.results || []).map(r => [r.filename, r.index_status])),
          }));
          onDownloaded();
          // Mark downloaded ones
          setSessions(prev => prev.map(s =>
            result.downloaded?.includes(s.filename)
              ? { ...s, already_downloaded: true }
              : s
          ));
          setSelected(prev => {
            const next = new Set(prev);
            result.downloaded?.forEach(f => next.delete(f));
            return next;
          });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
      stopPullPoll();
    } finally {
      // Keep polling (if still running) so rows flip from "indexing" to "indexed".
      isPullingRef.current = false;
      setDownloading(false);
      setPullPercent({});
    }
  }, [selected, onDownloaded, stopPullPoll, pollPullProgress]);

  const newCount = sessions.filter(s => !s.already_downloaded).length;

  return (
    <Sheet
      title="AiM Device Sessions"
      onClose={onClose}
      width={640}
      footer={
        sessions.length > 0 ? (
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{sessions.length} on device</span>
              {newCount > 0 && <span>{newCount} new</span>}
              <span>{selected.size} selected</span>
              <button onClick={selectAll} className="text-primary hover:underline">Select all</button>
              <button onClick={selectNone} className="hover:underline">Deselect all</button>
            </div>
            <Button
              variant="primary"
              onClick={handleDownload}
              disabled={selected.size === 0 || downloading}
            >
              {downloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              {downloading ? 'Downloading...' : `Download ${selected.size}`}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="-mx-[18px] -mt-2.5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-5 h-5 text-primary animate-spin" />
              <p className="text-xs text-muted-foreground">Listing sessions on device...</p>
            </div>
          ) : sessions.length === 0 && !error ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 px-5 text-center">
              <HardDrive className="w-6 h-6 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No sessions found on device</p>
              <p className="text-xs text-muted-foreground/70">
                Connect to the AiM WiFi hotspot and verify the device IP in Settings (default 10.0.0.1).
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {sessions.map(session => {
                const isSelected = selected.has(session.filename);
                const isDownloaded = session.already_downloaded;
                const pullFill = pullPercent[session.filename];
                const indexStatus = indexing[session.filename];

                return (
                  <button
                    key={session.filename}
                    onClick={() => !isDownloaded && toggleSelect(session.filename)}
                    disabled={isDownloaded || downloading}
                    className={`relative w-full overflow-hidden text-left transition-colors
                      ${isDownloaded ? 'opacity-50' : 'hover:bg-muted/20'}
                      ${isSelected && !isDownloaded && pullFill === undefined ? 'bg-primary/5' : ''}
                    `}
                  >
                    {pullFill !== undefined && (
                      <div
                        className="absolute inset-y-0 left-0 bg-primary/25 dark:bg-primary/30 transition-[width] duration-200 ease-out pointer-events-none"
                        style={{ width: `${pullFill}%` }}
                        aria-hidden
                      />
                    )}
                    <div className="relative flex w-full items-center gap-3 px-[18px] py-2.5">
                    {/* Checkbox */}
                    <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors
                      ${isDownloaded
                        ? 'border-success/50 bg-success/20'
                        : isSelected
                          ? 'border-primary bg-primary'
                          : 'border-border'
                      }
                    `}>
                      {(isSelected || isDownloaded) && (
                        <CheckCircle className={`w-3 h-3 ${isDownloaded ? 'text-success' : 'text-primary-foreground'}`} />
                      )}
                    </div>

                    {/* Session info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {session.filename}
                        </span>
                        {isDownloaded && !indexStatus && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success flex-shrink-0">
                            downloaded
                          </span>
                        )}
                        {indexStatus && (
                          <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${INDEX_BADGE[indexStatus].className}`}>
                            {isIndexingInFlight(indexStatus) && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                            {INDEX_BADGE[indexStatus].label}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                        {session.date && <span>{formatAimDeviceListDate(session.date)}</span>}
                        {session.hour && <span>{session.hour}</span>}
                        {session.vehicle && <span>{session.vehicle}</span>}
                      </div>
                    </div>

                    {/* Meta */}
                    <div className="flex items-center gap-3 flex-shrink-0 text-xs text-muted-foreground tabular">
                      {session.lap_count > 0 && (
                        <span>{session.lap_count} laps</span>
                      )}
                      <span>{formatSize(session.size)}</span>
                    </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
      </div>

      {error && (
        <div className="mt-2 px-3 py-2 rounded-md text-xs bg-danger/10 text-danger border border-danger/20">
          {error}
        </div>
      )}
      {downloadResult && (
        <div className="mt-2 px-3 py-2 rounded-md text-xs bg-success/10 text-success border border-success/20 whitespace-pre-line">
          {downloadResult}
        </div>
      )}
    </Sheet>
  );
}
