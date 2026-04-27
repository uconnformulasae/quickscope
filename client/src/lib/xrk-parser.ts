/**
 * QuickScope — XRK Types & Client-Side Helpers
 *
 * Type interfaces for the XRK session data model.
 * Binary parsing has been moved to the Python/libxrk backend.
 * This file retains only the shared types, downsampling, and formatting helpers
 * that run client-side.
 */

export interface ChannelDef {
  index: number;
  shortName: string;
  longName: string;
  sampleRateRaw: number; // period in microseconds (e.g. 20000 = 50Hz)
  sampleRateHz: number;  // actual Hz
  units: string;
  color: string;
  fileSampleCount?: number; // total samples in file (from backend), used to distinguish "not loaded" from "no data"
}

export interface ChannelSample {
  timestamp: number; // milliseconds
  value: number;
}

export type LapSource = 'device' | 'gps_auto' | 'beacon_auto' | 'none';

export interface LapMarker {
  timestamp: number;
  lapNumber: number;
}

export interface SessionMetadata {
  vehicle: string;
  driver: string;
  date: string;
  time: string;
  venue: string;
  championship: string;
  sessionType: string;
}

export interface XRKSession {
  metadata: SessionMetadata;
  channels: Map<number, ChannelDef>;
  samples: Map<number, ChannelSample[]>;
  lapMarkers: LapMarker[];
  lapSource: LapSource;
  durationMs: number;
  totalSamples: number;
}

export interface ParseProgress {
  stage: string;
  percent: number;
}


export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  count: number;
  minTimestamp: number; // ms — timestamp of the minimum value sample
  maxTimestamp: number; // ms — timestamp of the maximum value sample
}

export function computeStats(samples: ChannelSample[]): ChannelStats {
  if (samples.length === 0) return { min: 0, max: 0, mean: 0, stdDev: 0, count: 0, minTimestamp: 0, maxTimestamp: 0 };
  let min = Infinity, max = -Infinity, sum = 0, count = 0;
  let minTimestamp = 0, maxTimestamp = 0;
  for (const s of samples) {
    if (!isFinite(s.value)) continue;
    if (s.value < min) { min = s.value; minTimestamp = s.timestamp; }
    if (s.value > max) { max = s.value; maxTimestamp = s.timestamp; }
    sum += s.value;
    count++;
  }
  if (count === 0) return { min: 0, max: 0, mean: 0, stdDev: 0, count: 0, minTimestamp: 0, maxTimestamp: 0 };
  const mean = sum / count;
  let variance = 0;
  for (const s of samples) {
    if (!isFinite(s.value)) continue;
    variance += (s.value - mean) ** 2;
  }
  return { min, max, mean, stdDev: Math.sqrt(variance / count), count, minTimestamp, maxTimestamp };
}

export function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(milliseconds % 1000);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

export function formatLapTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, '0')}`;
}
