// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession } from '../test-fixtures';

const api = vi.hoisted(() => ({ fetchGPS: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

import { AnalysisPanel } from './AnalysisPanel';
import { GPSMapView } from './GPSMapView';

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

describe('GPS cursor marker', () => {
  const track = {
    lat: [41.8, 41.8005, 41.801, 41.8015, 41.802],
    lon: [-72.2, -72.2005, -72.201, -72.2015, -72.202],
    speed: [10, 20, 30, 20, 10],
    timestamps: [0, 1000, 2000, 3000, 4000],
    speedUnits: 'km/h',
  };

  /** Leaflet pane (the stacking layer) that holds the path drawn with this fill colour. */
  function paneOfFill(fill: string): HTMLElement | null {
    const path = document.querySelector(`path[fill="${fill}"]`);
    return path?.closest<HTMLElement>('.leaflet-pane:not(.leaflet-map-pane)') ?? null;
  }

  it('draws the cursor above the speed trail, even after the trail is redrawn', async () => {
    api.fetchGPS.mockResolvedValue(track);
    const sessionKey = {};
    const { rerender } = render(<GPSMapView sessionKey={sessionKey} cursorTime={2} selectedLaps={[]} />);
    await waitFor(() => expect(document.querySelector('path[fill="#ffffff"]')).not.toBeNull());

    // A new lap selection rebuilds every trail polyline after the cursor exists.
    rerender(<GPSMapView sessionKey={sessionKey} cursorTime={3} selectedLaps={[0]} />);

    const cursorPane = paneOfFill('#ffffff');
    const trailPane = document.querySelector<HTMLElement>('.leaflet-overlay-pane');
    expect(cursorPane).not.toBeNull();
    expect(cursorPane).not.toBe(trailPane);
    // overlayPane (the trail) sits at z-index 400 in Leaflet's stylesheet.
    expect(Number(cursorPane!.style.zIndex)).toBeGreaterThan(400);
  });
});
