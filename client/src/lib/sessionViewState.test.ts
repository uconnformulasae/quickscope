// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeChannel, makeSession } from '../test-fixtures';
import {
  captureSessionView, loadSessionView, resolveSavedChannels, saveSessionView, MAX_SAVED_SESSIONS,
} from './sessionViewState';

const session = makeSession({
  channels: new Map([[1, makeChannel(1, 'RPM')], [2, makeChannel(2, 'Speed')], [3, makeChannel(3, 'Throttle')]]),
});

const view = {
  activeChannels: [{ channelId: 2, color: '#0f0' }, { channelId: 10000, color: '#f43f5e' }, { channelId: 1, color: '#f00' }],
  derivedChannels: [{ id: 10000, name: 'Power', units: 'kW', mode: 'formula' as const, expression: 'RPM*2', color: '#f43f5e' }],
  chartMode: 'overlay' as const,
  viewMode: 'chart' as const,
  analysisTab: 'lapanalysis' as const,
  viewRange: { startMs: 1000, endMs: 5000 },
  selectedLaps: [1, 2],
};

beforeEach(() => localStorage.clear());

describe('captureSessionView', () => {
  it('stores session channels by name (in order) and derived channel definitions', () => {
    const saved = captureSessionView(view, session);
    expect(saved.channels).toEqual([{ name: 'Speed', color: '#0f0' }, { name: 'RPM', color: '#f00' }]);
    expect(saved.derived).toEqual([{ name: 'Power', units: 'kW', mode: 'formula', expression: 'RPM*2' }]);
    expect(saved.chartMode).toBe('overlay');
    expect(saved.analysisTab).toBe('lapanalysis');
    expect(saved.viewRange).toEqual({ startMs: 1000, endMs: 5000 });
    expect(saved.selectedLaps).toEqual([1, 2]);
  });
});

describe('resolveSavedChannels', () => {
  it('maps names back to channel ids and drops channels the session lacks', () => {
    const saved = { ...captureSessionView(view, session), channels: [{ name: 'Speed', color: '#0f0' }, { name: 'Gone', color: '#000' }] };
    expect(resolveSavedChannels(saved, session)).toEqual([{ channelId: 2, color: '#0f0' }]);
  });
});

describe('save/load', () => {
  it('round-trips per session key', () => {
    const saved = captureSessionView(view, session);
    saveSessionView('abc', saved);
    expect(loadSessionView('abc')).toEqual(saved);
    expect(loadSessionView('other')).toBeNull();
  });

  it('returns null for corrupt data or blocked storage', () => {
    localStorage.setItem('quickscope-session-view:abc', '{nope');
    expect(loadSessionView('abc')).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadSessionView('abc')).toBeNull();
  });

  it('keeps only the most recent sessions', () => {
    const saved = captureSessionView(view, session);
    for (let i = 0; i <= MAX_SAVED_SESSIONS; i++) saveSessionView(`s${i}`, saved);
    expect(loadSessionView('s0')).toBeNull(); // oldest evicted
    expect(loadSessionView(`s${MAX_SAVED_SESSIONS}`)).toEqual(saved);
  });
});
