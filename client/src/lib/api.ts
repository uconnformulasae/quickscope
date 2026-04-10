/**
 * QuickScope API Client
 * Communicates with the Python/libxrk backend
 */

const API_BASE = 'http://localhost:8000';

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

export interface LapData {
  lapNumber: number;
  timestamp: number;
  duration: number;
}

export interface GPSData {
  timestamps: number[];
  lat: number[];
  lon: number[];
  speed: number[] | null;
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

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
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

export async function uploadFile(file: File): Promise<SessionInfo> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/api/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Upload failed: ${res.status}`);
  }

  return res.json();
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

export async function fetchLaps(): Promise<LapData[]> {
  const res = await fetch(`${API_BASE}/api/laps`);
  if (!res.ok) {
    throw new Error(`Failed to fetch laps: ${res.status}`);
  }
  const data = await res.json();
  return data.laps || [];
}

export async function fetchGPS(): Promise<GPSData | null> {
  const res = await fetch(`${API_BASE}/api/gps`);
  if (!res.ok) {
    throw new Error(`Failed to fetch GPS: ${res.status}`);
  }
  const data = await res.json();
  return data.gps || null;
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
