import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchUploadLog, fetchAimPullLog, type UploadLogEntry, type AimPullLogEntry } from '../../lib/api';
import { IconButton } from '../ui/Button';
import { Sheet } from '../ui/Sheet';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRate(bytesPerSec: number): string {
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

export function ActivitySheet({ onClose }: { onClose: () => void }) {
  const [uploadLog, setUploadLog] = useState<UploadLogEntry[]>([]);
  const [aimPullLog, setAimPullLog] = useState<AimPullLogEntry[]>([]);
  const [activityTab, setActivityTab] = useState<'uploads' | 'aim'>('uploads');

  const refresh = useCallback(async () => {
    try {
      const [uploads, aimPulls] = await Promise.all([fetchUploadLog(), fetchAimPullLog()]);
      setUploadLog(uploads);
      setAimPullLog(aimPulls);
    } catch {
      setUploadLog([]);
      setAimPullLog([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Sheet title="Activity" subtitle="Recent uploads and AiM pulls (server-side log)" onClose={onClose} width={760}>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border/50">
          <button
            onClick={() => setActivityTab('uploads')}
            className={`px-2.5 py-1 text-[11px] ${activityTab === 'uploads' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-muted/50'}`}
          >
            Uploads
          </button>
          <button
            onClick={() => setActivityTab('aim')}
            className={`px-2.5 py-1 text-[11px] ${activityTab === 'aim' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-muted/50'}`}
          >
            AiM Pulls
          </button>
        </div>
        <div className="flex-1" />
        <IconButton label="Refresh" onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="overflow-x-auto">
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
    </Sheet>
  );
}
