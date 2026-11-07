// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession } from '../test-fixtures';

const api = vi.hoisted(() => ({ fetchGPS: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

import { AnalysisPanel } from './AnalysisPanel';

const baseProps = {
  activeChannels: [],
  viewRange: null,
  analysisTab: 'gps' as const,
  onTabChange: () => {},
  histogramChannelId: null,
  onHistogramChannelChange: () => {},
  xyXChannelId: null,
  xyYChannelId: null,
  onXYChannelChange: () => {},
};

beforeEach(() => {
  // null = "no GPS channels", so the panel never needs Leaflet in jsdom.
  api.fetchGPS.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GPS tab across session changes', () => {
  it('refetches the track when a different session is loaded while the tab stays open', async () => {
    const { rerender } = render(<AnalysisPanel {...baseProps} session={makeSession()} />);
    await screen.findByText('No GPS Data');
    expect(api.fetchGPS).toHaveBeenCalledTimes(1);

    rerender(<AnalysisPanel {...baseProps} session={makeSession()} />);

    await waitFor(() => expect(api.fetchGPS).toHaveBeenCalledTimes(2));
  });

  it('does not refetch when the same session only gains channel data', async () => {
    const first = makeSession();
    const { rerender } = render(<AnalysisPanel {...baseProps} session={first} />);
    await screen.findByText('No GPS Data');

    // Same shape as useXRKStore.setChannelSamples: new session object, same metadata.
    rerender(<AnalysisPanel {...baseProps} session={{ ...first, samples: new Map(first.samples) }} />);
    await screen.findByText('No GPS Data');

    expect(api.fetchGPS).toHaveBeenCalledTimes(1);
  });
});
