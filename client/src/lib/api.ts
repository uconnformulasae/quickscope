/**
 * QuickScope API Client
 * Communicates with the Python/libxrk backend
 */

// In packaged Electron builds, preload.js injects window.__QUICKSCOPE_BACKEND__.
// In browser dev (`npm run dev`), fall back to the current hostname on port 8000.
declare global {
  interface Window {
    __QUICKSCOPE_BACKEND__?: string;
  }
}

const API_BASE =
  (typeof window !== 'undefined' && window.__QUICKSCOPE_BACKEND__) ||
  `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:8000`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionInfo {
  metadata: {
    vehicle: string;
    driver: string;
    date: string;
    time: string;
    venue: string;
    championship: string;
    sessionType: string;
  };
  channels: {
    name: string;
    units: string;
    sampleCount: number;
    sampleRateHz: number;
    color: string;
    index: number;
  }[];
  durationMs: number;
  totalSamples: number;
  lapCount: number;
}

export interface ChannelDataResponse {
  [channelName: string]: {
    timestamps: number[];
    values: number[];
  };
}

export interface GPSData {
  timestamps: number[];
  lat: number[];
  lon: number[];
  speed: number[] | null;
}

export interface LapSetpoint {
  lat: number;
  lon: number;
  radius_m: number;
}

export interface LocalSession {
  id: string;
  remote_id: number | null;
  aim_session_id: string;
  filename: string;
  local_path: string | null;
  track_name: string;
  driver_name: string;
  vehicle_name: string;
  recorded_at: string | null;
  duration_s: number;
  lap_count: number;
  sync_status: 'local_only' | 'remote_only' | 'synced' | 'uploading' | 'downloading';
  source: 'manual_upload' | 'aim_device' | 'railway';
  created_at: string;
  updated_at: string;
  /** Per-session manual lap setpoints. Empty/null = use auto detection. */
  lap_setpoints?: LapSetpoint[] | null;
}

export interface AimStatus {
  connected: boolean;
  device: { ip: string; ssid: string; device_name: string } | null;
}

export interface AimSession {
  filename: string;
  size: number;
  date: string;
  hour: string;
  lap_count: number;
  vehicle: string;
  device_name: string;
  already_downloaded: boolean;
}

export interface Settings {
  railway_url: string;
  aim_wifi_ssid: string;
  aim_device_ip: string;
  aim_device_port: number;
}

export interface SyncResult {
  ok: boolean;
  pulled: number;
  pushed: number;
  errors: string[];
}

// ─── Session Management ─────────────────────────────────────────────────────

export async function listSessions(): Promise<LocalSession[]> {
  const res = await fetch(`${API_BASE}/api/sessions`);
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  return res.json();
}

export async function loadSession(sessionId: string): Promise<SessionInfo> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/load`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Load failed: ${res.status}`);
  }
  return res.json();
}

export async function syncSessions(): Promise<SyncResult> {
  const res = await fetch(`${API_BASE}/api/sessions/sync`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Sync failed: ${res.status}`);
  }
  return res.json();
}

export async function pullSession(sessionId: string): Promise<{ ok: boolean; local_path?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/pull`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Pull failed: ${res.status}`);
  }
  return res.json();
}

export async function renameSession(sessionId: string, filename: string): Promise<LocalSession> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Rename failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function getSetpoints(sessionId: string): Promise<LapSetpoint[]> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/setpoints`);
  if (!res.ok) throw new Error(`Failed to get setpoints: ${res.status}`);
  const data = await res.json();
  return data.setpoints || [];
}

export async function updateSetpoints(sessionId: string, setpoints: LapSetpoint[]): Promise<LocalSession> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/setpoints`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setpoints }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Update setpoints failed: ${res.status}`);
  }
  return res.json();
}

// ─── AiM Device ─────────────────────────────────────────────────────────────

export async function getAimStatus(): Promise<AimStatus> {
  const res = await fetch(`${API_BASE}/api/aim/status`);
  if (!res.ok) throw new Error(`Failed to get AiM status: ${res.status}`);
  return res.json();
}

export async function listAimSessions(): Promise<{ ok: boolean; sessions: AimSession[]; error?: string }> {
  const res = await fetch(`${API_BASE}/api/aim/sessions`);
  if (!res.ok) throw new Error(`Failed to list AiM sessions: ${res.status}`);
  return res.json();
}

export async function pullFromAim(filenames: string[]): Promise<{ ok: boolean; downloaded: string[]; errors?: string[]; error?: string; message?: string }> {
  const res = await fetch(`${API_BASE}/api/aim/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `AiM pull failed: ${res.status}`);
  }
  return res.json();
}

// ─── Settings ───────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  const res = await fetch(`${API_BASE}/api/settings`);
  if (!res.ok) throw new Error(`Failed to get settings: ${res.status}`);
  return res.json();
}

export async function updateSettings(settings: Partial<Settings>): Promise<Settings> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`Failed to update settings: ${res.status}`);
  return res.json();
}

// ─── Analysis (existing — operate on loaded session) ────────────────────────

export interface UploadProgress {
  loaded: number;
  total: number;
  /** Bytes per second over the last sample window. */
  ratePerSec: number;
  /** Estimated seconds remaining at the current rate. -1 if unknown. */
  etaSec: number;
}

/**
 * Upload an .xrk/.xrz file with progress reporting.
 *
 * Uses XMLHttpRequest because the standard `fetch` API has no upload-progress
 * event in browsers. This is critical for diagnosing the "phone uploads were
 * slow and never showed up" report — we now show byte progress + rate +
 * ETA in the UI, and a stalled connection becomes obvious instead of
 * looking like a hung tab.
 */
export async function uploadFile(
  file: File,
  onProgress?: (p: UploadProgress) => void,
): Promise<SessionInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/upload`, true);

    let lastSampleTime = performance.now();
    let lastSampleBytes = 0;
    let smoothedRate = 0;

    xhr.upload.onprogress = (event) => {
      if (!onProgress) return;
      const now = performance.now();
      const dtSec = (now - lastSampleTime) / 1000;
      if (dtSec > 0.25) {
        const dB = event.loaded - lastSampleBytes;
        const instant = dB / dtSec;
        // EMA smoothing so the displayed rate doesn't jitter wildly.
        smoothedRate = smoothedRate === 0 ? instant : smoothedRate * 0.7 + instant * 0.3;
        lastSampleTime = now;
        lastSampleBytes = event.loaded;
      }
      const remaining = (event.total || 0) - event.loaded;
      const etaSec = smoothedRate > 0 && event.total ? remaining / smoothedRate : -1;
      onProgress({
        loaded: event.loaded,
        total: event.total || file.size,
        ratePerSec: smoothedRate,
        etaSec,
      });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error('Server returned invalid JSON'));
        }
      } else {
        let detail = xhr.statusText;
        try {
          detail = JSON.parse(xhr.responseText).detail || detail;
        } catch {
          // ignore
        }
        reject(new Error(detail || `Upload failed: ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.onabort = () => reject(new Error('Upload aborted'));

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

export interface UploadLogEntry {
  ts: string;             // ISO8601
  filename: string;
  size: number;
  duration_s: number;
  client_ip: string;
  user_agent: string;
  status: 'ok' | 'parse_failed' | 'upload_failed';
  error?: string;
}

export async function fetchUploadLog(): Promise<UploadLogEntry[]> {
  const res = await fetch(`${API_BASE}/api/uploads/log`);
  if (!res.ok) throw new Error(`Failed to fetch upload log: ${res.status}`);
  const data = await res.json();
  return data.entries;
}

export async function fetchChannelData(
  channels: string[],
): Promise<Map<string, { timestamps: number[]; values: number[] }>> {
  if (channels.length === 0) return new Map();

  const res = await fetch(
    `${API_BASE}/api/data?channels=${encodeURIComponent(channels.join(','))}`,
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch channel data: ${res.status}`);
  }

  const data: ChannelDataResponse = await res.json();
  const map = new Map<string, { timestamps: number[]; values: number[] }>();
  for (const [name, channelData] of Object.entries(data)) {
    map.set(name, channelData);
  }
  return map;
}

export async function fetchGPS(): Promise<GPSData | null> {
  const res = await fetch(`${API_BASE}/api/gps`);
  if (!res.ok) {
    throw new Error(`Failed to fetch GPS: ${res.status}`);
  }
  const data = await res.json();
  return data.gps || null;
}

export type LapSource = 'device' | 'gps_auto' | 'beacon_auto' | 'gps_manual' | 'none';

export interface LapsResponse {
  laps: {
    lapNumber: number;
    startTime: number;
    endTime: number;
    source: LapSource;
    /** Sector split timestamps in ms (same timebase as startTime/endTime).
     *  null = sector not crossed in this lap. Absent or empty = no sectors. */
    sectorTimes?: (number | null)[];
  }[];
  source: LapSource;
  /** Number of sector splits (= setpoints.length - 1 when manual; 0 otherwise). */
  sectorCount?: number;
}

export async function fetchLaps(): Promise<LapsResponse> {
  const res = await fetch(`${API_BASE}/api/laps`);
  if (!res.ok) {
    throw new Error(`Failed to fetch laps: ${res.status}`);
  }
  return res.json();
}

export interface GPSPreview {
  points: [number, number][];
  bounds: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
  pointCount: number;
}

export async function fetchGPSPreview(sessionId: string): Promise<GPSPreview | null> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/gps-preview`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Failed to fetch GPS preview: ${res.status}`);
  }
  const data = await res.json();
  return data.preview;
}

// ─── Live streaming ─────────────────────────────────────────────────────────

export interface LiveDeviceInfo {
  ip: string;
  model: string;
  serial: string;
  vehicle: string;
}

export interface LiveStatus {
  reachable: boolean;
  host: string;
  device?: LiveDeviceInfo;
}

export async function fetchLiveStatus(): Promise<LiveStatus> {
  const res = await fetch(`${API_BASE}/api/live/status`);
  if (!res.ok) throw new Error(`Live status failed: ${res.status}`);
  return res.json();
}

export type LiveWSMessage =
  | { type: 'connected'; device: LiveDeviceInfo }
  | { type: 'snapshot'; ts: number; subsystem: string; raw: string }
  | { type: 'error'; message: string };

export function liveWebSocketUrl(): string {
  // Replace http(s) with ws(s) for the live endpoint.
  const wsBase = API_BASE.replace(/^http/, 'ws');
  return `${wsBase}/api/live/ws`;
}

export async function exportCSV(channels: string[]): Promise<Blob> {
  const res = await fetch(
    `${API_BASE}/api/export?channels=${encodeURIComponent(channels.join(','))}`,
  );
  if (!res.ok) {
    throw new Error(`Export failed: ${res.status}`);
  }
  return res.blob();
}
