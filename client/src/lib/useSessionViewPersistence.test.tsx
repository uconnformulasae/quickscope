// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeChannel, makeSession } from '../test-fixtures';
import { useAppState } from './useXRKStore';
import { useSessionViewPersistence } from './useSessionViewPersistence';

const session = () => makeSession({
  channels: new Map([[1, makeChannel(1, 'RPM')], [2, makeChannel(2, 'Speed')]]),
  samples: new Map(), // channels load lazily
});

function setup() {
  const fetchData = vi.fn(async (names: string[]) =>
    new Map(names.map(n => [n, { timestamps: [0, 1000], values: [1, 2] }])));
  const hook = renderHook(() => {
    const app = useAppState();
    const persist = useSessionViewPersistence(app, fetchData);
    return { app, persist };
  });
  return { ...hook, fetchData };
}

beforeEach(() => localStorage.clear());

describe('useSessionViewPersistence', () => {
  it('restores the channels and view of a session when it is reopened', async () => {
    const { result, fetchData } = setup();
    act(() => { result.current.persist.beginSession('sess-1'); result.current.app.setSession(session(), 'a.xrk'); });
    act(() => result.current.app.toggleChannel(2, '#0f0'));
    act(() => result.current.app.setChartMode('overlay'));
    act(() => result.current.app.setAnalysisTab('gps'));

    // Back to the browser, then reopen the same session
    act(() => { result.current.app.clearSession(); result.current.persist.endSession(); });
    expect(result.current.app.state.activeChannels).toEqual([]);
    act(() => { result.current.persist.beginSession('sess-1'); result.current.app.setSession(session(), 'a.xrk'); });

    await waitFor(() => expect(result.current.app.state.activeChannels).toEqual([{ channelId: 2, color: '#0f0' }]));
    expect(result.current.app.state.chartMode).toBe('overlay');
    expect(result.current.app.state.analysisTab).toBe('gps');
    expect(fetchData).toHaveBeenCalledWith(['Speed']); // restored channel's data was loaded
    expect(result.current.app.state.session!.samples.get(2)).toHaveLength(2);
  });

  it('keeps sessions separate and does not overwrite a saved view while restoring', async () => {
    const { result } = setup();
    act(() => { result.current.persist.beginSession('A'); result.current.app.setSession(session(), 'a.xrk'); });
    act(() => result.current.app.toggleChannel(1, '#f00'));
    act(() => { result.current.app.clearSession(); result.current.persist.endSession(); });

    act(() => { result.current.persist.beginSession('B'); result.current.app.setSession(session(), 'b.xrk'); });
    expect(result.current.app.state.activeChannels).toEqual([]); // B has nothing saved
    act(() => { result.current.app.clearSession(); result.current.persist.endSession(); });

    act(() => { result.current.persist.beginSession('A'); result.current.app.setSession(session(), 'a.xrk'); });
    await waitFor(() => expect(result.current.app.state.activeChannels).toEqual([{ channelId: 1, color: '#f00' }]));
  });
});
