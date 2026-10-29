import { describe, expect, it } from 'vitest';
import { formatNum, resolveChannel, resolveSamples } from './analysis-helpers';
import type { ChannelDef, XRKSession } from '../../lib/xrk-parser';
import type { DerivedChannel } from '../../lib/useXRKStore';

const rpm: ChannelDef = {
  index: 1, shortName: 'RPM', longName: 'Engine RPM', sampleRateRaw: 20000, sampleRateHz: 50, units: 'rpm', color: '#f00',
};

function makeSession(): XRKSession {
  return {
    metadata: { vehicle: '', driver: '', date: '', time: '', venue: '', championship: '', sessionType: '' },
    channels: new Map([[1, rpm]]),
    samples: new Map([[1, [{ timestamp: 0, value: 1000 }]]]),
    lapMarkers: [],
    lapSource: 'none',
    durationMs: 1000,
    totalSamples: 1,
    logStartMs: null,
  };
}

const derived: DerivedChannel = {
  id: 10000, name: 'Power', units: 'kW', mode: 'formula', expression: 'a*b', color: '#0f0',
};

describe('resolveChannel', () => {
  it('returns the session channel when present', () => {
    expect(resolveChannel(1, makeSession(), [derived])).toBe(rpm);
  });

  it('builds a channel def for a derived channel', () => {
    expect(resolveChannel(10000, makeSession(), [derived])).toEqual({
      index: 10000, shortName: 'Power', longName: 'Power', units: 'kW', color: '#0f0', sampleRateHz: 0, sampleRateRaw: 0,
    });
  });

  it('returns null for unknown ids', () => {
    expect(resolveChannel(99, makeSession(), [derived])).toBeNull();
    expect(resolveChannel(99, makeSession())).toBeNull();
  });
});

describe('resolveSamples', () => {
  it('prefers session samples, then derived samples, then empty', () => {
    const derivedSamples = new Map([[10000, [{ timestamp: 5, value: 2 }]]]);
    expect(resolveSamples(1, makeSession(), derivedSamples)).toEqual([{ timestamp: 0, value: 1000 }]);
    expect(resolveSamples(10000, makeSession(), derivedSamples)).toEqual([{ timestamp: 5, value: 2 }]);
    expect(resolveSamples(99, makeSession(), derivedSamples)).toEqual([]);
    expect(resolveSamples(99, makeSession())).toEqual([]);
  });
});

describe('formatNum', () => {
  it('scales decimals by magnitude', () => {
    expect(formatNum(12345.6)).toBe('12346');
    expect(formatNum(123.45)).toBe('123.5');
    expect(formatNum(1.234)).toBe('1.23');
    expect(formatNum(0.12345)).toBe('0.123');
  });

  it('uses magnitude for negatives', () => {
    expect(formatNum(-12345.6)).toBe('-12346');
    expect(formatNum(-0.5)).toBe('-0.500');
  });
});
