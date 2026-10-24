// @vitest-environment jsdom
import { makeSession, ramp } from '../../test/dom-setup';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const pending = vi.hoisted(() => ({ callbacks: [] as (() => void)[] }));
vi.mock('./analysis-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Plotly "still loading": hold the callback until the test releases it.
  ensurePlotly: (onReady: () => void) => { pending.callbacks.push(onReady); },
}));

import { HistogramTab } from './HistogramTab';

describe('HistogramTab', () => {
  const session = makeSession({
    1: { name: 'RPM', samples: ramp(100) },
    2: { name: 'Speed', samples: ramp(100) },
  });
  const active = [{ channelId: 1, color: '#f00' }, { channelId: 2, color: '#0f0' }];
  const setPlotly = (p: unknown) => { (window as unknown as { Plotly?: unknown }).Plotly = p; };

  it('renders only the current channel when the selection changed while Plotly was loading', () => {
    const plotly = { react: vi.fn(), purge: vi.fn() };
    const { rerender, unmount } = render(
      <HistogramTab session={session} activeChannels={active} channelId={1} onChannelChange={() => {}} />,
    );
    rerender(<HistogramTab session={session} activeChannels={active} channelId={2} onChannelChange={() => {}} />);

    setPlotly(plotly);
    pending.callbacks.splice(0).forEach(cb => cb()); // both queued renders resolve
    expect(plotly.react).toHaveBeenCalledTimes(1);
    expect(plotly.react.mock.lastCall?.[1][0].name).toBe('Speed');
    unmount();
    expect(plotly.purge).toHaveBeenCalledTimes(1);
    setPlotly(undefined);
  });

  it('does not render after unmounting before Plotly loads', () => {
    const plotly = { react: vi.fn(), purge: vi.fn() };
    const { unmount } = render(
      <HistogramTab session={session} activeChannels={active} channelId={1} onChannelChange={() => {}} />,
    );
    unmount();
    setPlotly(plotly);
    pending.callbacks.splice(0).forEach(cb => cb());
    expect(plotly.react).not.toHaveBeenCalled();
    setPlotly(undefined);
  });
});
