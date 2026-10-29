/** Shared builders for client tests (not shipped; only imported by *.test.* files). */
import type { ChannelDef, ChannelSample, XRKSession } from './lib/xrk-parser';

export function makeChannel(index: number, shortName: string, overrides: Partial<ChannelDef> = {}): ChannelDef {
  return {
    index,
    shortName,
    longName: shortName,
    sampleRateRaw: 1_000_000,
    sampleRateHz: 1,
    units: '',
    color: '#ff0000',
    fileSampleCount: 3,
    ...overrides,
  };
}

/** Samples at 0, 1000, 2000 ... ms. */
export function makeSamples(values: number[], stepMs = 1000): ChannelSample[] {
  return values.map((value, i) => ({ timestamp: i * stepMs, value }));
}

export function makeSession(overrides: Partial<XRKSession> = {}): XRKSession {
  return {
    metadata: {
      vehicle: 'CT16-EV',
      driver: 'Driver A',
      date: '19/10/2026',
      time: '14:05:00',
      venue: 'Lot',
      championship: 'FSAE',
      sessionType: 'Test',
    },
    channels: new Map(),
    samples: new Map(),
    lapMarkers: [],
    lapSource: 'none',
    durationMs: 2000,
    totalSamples: 0,
    logStartMs: null,
    ...overrides,
  };
}
