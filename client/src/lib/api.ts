/**
 * QuickScope API Client
 * Communicates with the Python/libxrk backend
 */

const API_BASE = 'http://localhost:8000';

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
