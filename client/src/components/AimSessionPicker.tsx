import { useState, useEffect, useCallback } from 'react';
import { X, Download, Loader2, CheckCircle, HardDrive, Radio } from 'lucide-react';
import { listAimSessions, pullFromAim, type AimSession } from '../lib/api';

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

export function AimSessionPicker({ onClose, onDownloaded }: AimSessionPickerProps) {
  const [sessions, setSessions] = useState<AimSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [downloadResult, setDownloadResult] = useState<string | null>(null);

  // Dismiss on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

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

  const handleDownload = useCallback(async () => {
    if (selected.size === 0) return;
    setDownloading(true);
    setError(null);
    setDownloadResult(null);
    try {
      const result = await pullFromAim(Array.from(selected));
      if (result.error) {
        setError(result.error);
      } else {
        const count = result.downloaded?.length || 0;
        const errCount = result.errors?.length || 0;
        if (errCount > 0) {
          setError(`${errCount} download(s) failed: ${result.errors!.join('; ')}`);
        }
        if (count > 0) {
          setDownloadResult(`Downloaded ${count} session${count !== 1 ? 's' : ''}`);
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
    } finally {
      setDownloading(false);
    }
  }, [selected, onDownloaded]);

  const newCount = sessions.filter(s => !s.already_downloaded).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
            <h2 className="text-sm font-semibold text-foreground">AiM Device Sessions</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted/50 text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-5 h-5 text-primary animate-spin" />
              <p className="text-xs text-muted-foreground">Listing sessions on device...</p>
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <HardDrive className="w-6 h-6 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No sessions found on device</p>
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {sessions.map(session => {
                const isSelected = selected.has(session.filename);
                const isDownloaded = session.already_downloaded;

                return (
                  <button
                    key={session.filename}
                    onClick={() => !isDownloaded && toggleSelect(session.filename)}
                    disabled={isDownloaded || downloading}
                    className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors
                      ${isDownloaded ? 'opacity-50' : 'hover:bg-muted/20'}
                      ${isSelected && !isDownloaded ? 'bg-primary/5' : ''}
                    `}
                  >
                    {/* Checkbox */}
                    <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors
                      ${isDownloaded
                        ? 'border-emerald-500/50 bg-emerald-500/20'
                        : isSelected
                          ? 'border-primary bg-primary'
                          : 'border-border'
                      }
                    `}>
                      {(isSelected || isDownloaded) && (
                        <CheckCircle className={`w-3 h-3 ${isDownloaded ? 'text-emerald-500 dark:text-emerald-400' : 'text-primary-foreground'}`} />
                      )}
                    </div>

                    {/* Session info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {session.filename}
                        </span>
                        {isDownloaded && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 flex-shrink-0">
                            downloaded
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                        {session.date && <span>{session.date}</span>}
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
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Error / Success */}
        {error && (
          <div className="mx-5 mb-2 px-3 py-2 rounded-md text-xs bg-red-500/10 text-red-500 dark:text-red-400 border border-red-500/20">
            {error}
          </div>
        )}
        {downloadResult && (
          <div className="mx-5 mb-2 px-3 py-2 rounded-md text-xs bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/20">
            {downloadResult}
          </div>
        )}

        {/* Footer */}
        {sessions.length > 0 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border flex-shrink-0">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{sessions.length} on device</span>
              {newCount > 0 && <span>{newCount} new</span>}
              <span>{selected.size} selected</span>
              <button onClick={selectAll} className="text-primary hover:underline">Select all</button>
              <button onClick={selectNone} className="hover:underline">Deselect all</button>
            </div>
            <button
              onClick={handleDownload}
              disabled={selected.size === 0 || downloading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {downloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              {downloading ? 'Downloading...' : `Download ${selected.size}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
