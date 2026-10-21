// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppState } from './useXRKStore';
import type { ChannelDef, ChannelSample, XRKSession } from './xrk-parser';

function chan(index: number, shortName: string, fileSampleCount = 3): ChannelDef {
  return {
    index, shortName, longName: shortName, sampleRateRaw: 1_000_000, sampleRateHz: 1, units: '', color: '#fff', fileSampleCount,
  };
}

const samples = (values: number[]): ChannelSample[] => values.map((v, i) => ({ timestamp: i * 1000, value: v }));

function makeSession(overrides: Partial<XRKSession> = {}): XRKSession {
  return {
    metadata: { vehicle: 'CT16', driver: '', date: '', time: '', venue: '', championship: '', sessionType: '' },
    channels: new Map([
      [1, chan(1, 'A')],
      [2, chan(2, 'B')],
      [3, chan(3, 'Lazy')],
      [4, chan(4, 'Empty', 0)],
    ]),
    samples: new Map([
      [1, samples([1, 2, 3])],
      [2, samples([10, 20, 30])],
    ]),
    lapMarkers: [],
    lapSource: 'none',
    durationMs: 2000,
    totalSamples: 6,
    logStartMs: null,
    ...overrides,
  };
}

function setup() {
  return renderHook(() => useAppState());
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('basic state', () => {
  it('starts empty with chart defaults', () => {
    const { result } = setup();
    expect(result.current.state).toMatchObject({
      session: null,
      isLoading: false,
      activeChannels: [],
      derivedChannels: [],
      analysisTab: 'stats',
      chartMode: 'separate',
      viewMode: 'chart',
      leftSidebarOpen: true,
      rightSidebarOpen: true,
    });
  });

  it('toggles a channel on and off', () => {
    const { result } = setup();
    act(() => result.current.toggleChannel(1, '#f00'));
    expect(result.current.state.activeChannels).toEqual([{ channelId: 1, color: '#f00' }]);
    act(() => result.current.toggleChannel(1, '#f00'));
    expect(result.current.state.activeChannels).toEqual([]);
  });

  it('setSession resets channels, derived channels and viewport', () => {
    const { result } = setup();
    act(() => result.current.toggleChannel(1, '#f00'));
    act(() => result.current.setViewRange({ startMs: 0, endMs: 10 }));
    act(() => result.current.setLoading(true, { stage: 'parse', percent: 50 }));
    const session = makeSession();
    act(() => result.current.setSession(session, 'run.xrk'));

    expect(result.current.state).toMatchObject({
      session,
      fileName: 'run.xrk',
      isLoading: false,
      parseProgress: null,
      activeChannels: [],
      derivedChannels: [],
      viewRange: null,
    });
  });

  it('tracks loading, progress and errors', () => {
    const { result } = setup();
    act(() => result.current.setLoading(true, { stage: 'upload', percent: 10 }));
    expect(result.current.state.parseProgress).toEqual({ stage: 'upload', percent: 10 });
    act(() => result.current.setProgress({ stage: 'parse', percent: 60 }));
    expect(result.current.state.parseProgress).toEqual({ stage: 'parse', percent: 60 });
    act(() => result.current.setError('boom'));
    expect(result.current.state).toMatchObject({ isLoading: false, loadError: 'boom', parseProgress: null });
    act(() => result.current.setLoading(true));
    expect(result.current.state.loadError).toBeNull();
  });

  it('updates simple UI fields', () => {
    const { result } = setup();
    act(() => {
      result.current.setCursorTime(1.5);
      result.current.setAnalysisTab('histogram');
      result.current.setChannelSearch('rpm');
      result.current.setShowOnlyWithData(true);
      result.current.setChartMode('overlay');
      result.current.setViewMode('table');
      result.current.setHistogramChannel(2);
      result.current.setXYChannels(1, 2);
      result.current.toggleLeftSidebar();
      result.current.toggleRightSidebar();
    });
    expect(result.current.state).toMatchObject({
      cursorTime: 1.5,
      analysisTab: 'histogram',
      channelSearch: 'rpm',
      showOnlyWithData: true,
      chartMode: 'overlay',
      viewMode: 'table',
      histogramChannelId: 2,
      xyXChannelId: 1,
      xyYChannelId: 2,
      leftSidebarOpen: false,
      rightSidebarOpen: false,
    });
  });

  it('setChannelSamples stores samples on the session and is a no-op without one', () => {
    const { result } = setup();
    act(() => result.current.setChannelSamples(3, samples([5])));
    expect(result.current.state.session).toBeNull();

    act(() => result.current.setSession(makeSession(), 'run.xrk'));
    act(() => result.current.setChannelSamples(3, samples([5])));
    expect(result.current.state.session?.samples.get(3)).toEqual(samples([5]));
  });

  it('clearSession drops the session and channels', () => {
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));
    act(() => result.current.toggleChannel(1, '#f00'));
    act(() => result.current.clearSession());
    expect(result.current.state).toMatchObject({
      session: null,
      fileName: null,
      activeChannels: [],
      derivedChannels: [],
      viewRange: null,
    });
  });
});

describe('derived channels (formula mode)', () => {
  const sumDef = { name: 'Sum', units: '', mode: 'formula' as const, expression: 'A + B' };

  it('returns an error without a session', async () => {
    const { result } = setup();
    let out: unknown;
    await act(async () => { out = await result.current.addDerivedChannel(sumDef); });
    expect(out).toEqual({ error: 'No session loaded' });
    await act(async () => { out = await result.current.previewDerivedChannel(sumDef); });
    expect(out).toBe('No session loaded');
  });

  it('adds a derived channel, activates it and stores its samples', async () => {
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));

    let out = { error: '' } as { id: number } | { error: string };
    await act(async () => { out = await result.current.addDerivedChannel(sumDef); });

    expect('id' in out).toBe(true);
    const id = (out as { id: number }).id;
    expect(result.current.state.derivedChannels).toEqual([
      expect.objectContaining({ id, name: 'Sum', expression: 'A + B' }),
    ]);
    expect(result.current.state.activeChannels.map((c) => c.channelId)).toContain(id);
    expect(result.current.derivedSamplesMap.get(id)).toEqual(samples([11, 22, 33]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the evaluator error for a bad formula without changing state', async () => {
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));

    let out: unknown;
    await act(async () => { out = await result.current.addDerivedChannel({ ...sumDef, expression: 'Nope + 1' }); });

    expect(out).toEqual({ error: expect.any(String) });
    expect(result.current.state.derivedChannels).toEqual([]);
  });

  it('previews without committing', async () => {
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));

    let out: unknown;
    await act(async () => { out = await result.current.previewDerivedChannel(sumDef); });

    expect(out).toEqual({ timestamps: [0, 1000, 2000], values: [11, 22, 33] });
    expect(result.current.state.derivedChannels).toEqual([]);
  });

  it('updates and removes a derived channel', async () => {
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));
    let added = { error: '' } as { id: number } | { error: string };
    await act(async () => { added = await result.current.addDerivedChannel(sumDef); });
    const id = (added as { id: number }).id;

    let updated: unknown;
    await act(async () => {
      updated = await result.current.updateDerivedChannel(id, { ...sumDef, name: 'Diff', expression: 'B - A' });
    });
    expect(updated).toEqual({ id });
    expect(result.current.state.derivedChannels[0]).toMatchObject({ id, name: 'Diff', expression: 'B - A' });
    expect(result.current.derivedSamplesMap.get(id)).toEqual(samples([9, 18, 27]));

    act(() => result.current.removeDerivedChannel(id));
    expect(result.current.state.derivedChannels).toEqual([]);
    expect(result.current.state.activeChannels).toEqual([]);
    expect(result.current.derivedSamplesMap.has(id)).toBe(false);
  });

  it('update reports a missing channel id', async () => {
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));
    let out: unknown;
    await act(async () => { out = await result.current.updateDerivedChannel(424242, sumDef); });
    expect(out).toEqual({ error: 'Channel not found' });
  });

  it('lazily fetches referenced channels that have file data but are not loaded', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ Lazy: { timestamps: [0, 1000, 2000], values: [100, 200, 300] } }),
    });
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));

    let out: unknown;
    await act(async () => {
      out = await result.current.previewDerivedChannel({ ...sumDef, expression: 'A + Lazy' });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/data?channels=Lazy');
    expect(out).toEqual({ timestamps: [0, 1000, 2000], values: [101, 202, 303] });
    // Fetched samples are persisted on the session so later evaluations skip the fetch.
    expect(result.current.state.session?.samples.get(3)).toEqual(samples([100, 200, 300]));
  });

  it('does not fetch channels the device recorded no data for', async () => {
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));

    await act(async () => {
      await result.current.previewDerivedChannel({ ...sumDef, expression: 'A + Empty' });
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('derived channels (python mode)', () => {
  const pyDef = { name: 'Py', units: '', mode: 'python' as const, expression: 'A * 2' };

  it('returns backend samples on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ timestamps: [0, 1000], values: [2, 4] }),
    });
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));

    let out: unknown;
    await act(async () => { out = await result.current.previewDerivedChannel(pyDef); });

    expect(out).toEqual({ timestamps: [0, 1000], values: [2, 4] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/derived/evaluate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).expression).toBe('A * 2');
  });

  it('surfaces the backend detail on error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ detail: 'Name not allowed: os' }),
    });
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));

    let out: unknown;
    await act(async () => { out = await result.current.addDerivedChannel(pyDef); });

    expect(out).toEqual({ error: 'Name not allowed: os' });
  });

  it('surfaces network failures as an error message', async () => {
    fetchMock.mockRejectedValue(new Error('Failed to fetch'));
    const { result } = setup();
    act(() => result.current.setSession(makeSession(), 'run.xrk'));

    let out: unknown;
    await act(async () => { out = await result.current.previewDerivedChannel(pyDef); });

    expect(out).toBe('Failed to fetch');
  });
});
