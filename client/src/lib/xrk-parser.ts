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
  dataType: number;      // source type: 1=internal, 5=GPS, 9=CAN
  dataSize: number;      // bytes per sample
  decoderType: number;   // raw decoder byte from CHS[20]
  scale: number;         // cal_value_1
  offset: number;        // cal_value_2
  units: string;
  color: string;
}

export interface ChannelSample {
  timestamp: number; // milliseconds
  value: number;
}

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
  durationMs: number;
  totalSamples: number;
}

export interface ParseProgress {
  stage: string;
  percent: number;
}

/**
 * Largest-Triangle-Three-Buckets downsampling
 */
export function lttbDownsample(data: ChannelSample[], targetPoints: number): ChannelSample[] {
  const n = data.length;
  if (n <= targetPoints || targetPoints <= 2) return data;

  const sampled: ChannelSample[] = [data[0]];
  const bucketSize = (n - 2) / (targetPoints - 2);
  let a = 0;

  for (let i = 0; i < targetPoints - 2; i++) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n - 1);

    let avgX = 0, avgY = 0, avgCount = 0;
    for (let j = rangeStart; j < rangeEnd; j++) {
      avgX += data[j].timestamp;
      avgY += data[j].value;
      avgCount++;
    }
    if (avgCount > 0) { avgX /= avgCount; avgY /= avgCount; }

    const curBucketStart = Math.floor(i * bucketSize) + 1;
    const curBucketEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, n - 1);
    const ax = data[a].timestamp;
    const ay = data[a].value;

    let maxArea = -1, maxIdx = curBucketStart;
    for (let j = curBucketStart; j < curBucketEnd; j++) {
      const area = Math.abs(
        (ax - avgX) * (data[j].value - ay) - (ax - data[j].timestamp) * (avgY - ay)
      ) * 0.5;
      if (area > maxArea) { maxArea = area; maxIdx = j; }
    }

    sampled.push(data[maxIdx]);
    a = maxIdx;
  }

  sampled.push(data[n - 1]);
  return sampled;
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
  let min = Infinity, max = -Infinity, sum = 0;
  let minTimestamp = 0, maxTimestamp = 0;
  for (const s of samples) {
    if (s.value < min) { min = s.value; minTimestamp = s.timestamp; }
    if (s.value > max) { max = s.value; maxTimestamp = s.timestamp; }
    sum += s.value;
  }
  const mean = sum / samples.length;
  let variance = 0;
  for (const s of samples) variance += (s.value - mean) ** 2;
  return { min, max, mean, stdDev: Math.sqrt(variance / samples.length), count: samples.length, minTimestamp, maxTimestamp };
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
