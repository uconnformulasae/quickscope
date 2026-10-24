// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableView } from './TableView';
import { AnalysisPanel } from './AnalysisPanel';
import { makeChannel, makeSamples, makeSession } from '../test-fixtures';

beforeEach(() => {
  // jsdom has no layout; give the scroll container a size so the virtualizer renders rows.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600, toJSON: () => ({}),
  } as DOMRect);
  HTMLElement.prototype.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function session() {
  return makeSession({
    channels: new Map([
      [1, makeChannel(1, 'RPM', { units: 'rpm' })],
      [2, makeChannel(2, 'Gear')],
    ]),
    samples: new Map([
      [1, makeSamples([1000, 2000, 3000, 4000], 500)], // 0, 500, 1000, 1500 ms
      [2, makeSamples([1, 2], 1000)], // 0, 1000 ms
    ]),
  });
}

describe('TableView', () => {
  it('prompts to select channels when none are active', () => {
    render(<TableView session={session()} activeChannels={[]} />);
    expect(screen.getByText('Select channels in the sidebar to view data')).toBeTruthy();
  });

  it('renders column headers with units and the row count', () => {
    render(
      <TableView
        session={session()}
        activeChannels={[{ channelId: 1, color: '#f00', visible: true }, { channelId: 2, color: '#0f0', visible: true }]}
      />,
    );
    expect(screen.getByText('Time (s)')).toBeTruthy();
    expect(screen.getByText('RPM (rpm)')).toBeTruthy();
    expect(screen.getByText('Gear')).toBeTruthy();
    expect(screen.getByText('4 rows')).toBeTruthy();
  });

  it('renders rows on the fastest channel timeline with held values', () => {
    render(
      <TableView
        session={session()}
        activeChannels={[{ channelId: 1, color: '#f00', visible: true }, { channelId: 2, color: '#0f0', visible: true }]}
      />,
    );
    expect(screen.getByText('0.000')).toBeTruthy();
    expect(screen.getByText('0.500')).toBeTruthy();
    expect(screen.getByText('1.500')).toBeTruthy();
    expect(screen.getByText('4000.0')).toBeTruthy();
  });

  it('names derived channel columns', () => {
    render(
      <TableView
        session={session()}
        activeChannels={[{ channelId: 10000, color: '#00f', visible: true }]}
        derivedChannels={[{ id: 10000, name: 'Power', units: 'kW', mode: 'formula', expression: 'x', color: '#00f' }]}
        derivedSamplesMap={new Map([[10000, makeSamples([5])]])}
      />,
    );
    expect(screen.getByText('Power (kW)')).toBeTruthy();
    expect(screen.getByText('1 rows')).toBeTruthy();
  });

  it('highlights the row nearest a searched time', () => {
    render(
      <TableView session={session()} activeChannels={[{ channelId: 1, color: '#f00', visible: true }]} />,
    );
    const search = screen.getByPlaceholderText('Go to time (s)...');
    fireEvent.change(search, { target: { value: '1' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByText('1.000').className).toContain('text-primary');
  });

  it('ignores a non-numeric search', () => {
    render(
      <TableView session={session()} activeChannels={[{ channelId: 1, color: '#f00', visible: true }]} />,
    );
    const search = screen.getByPlaceholderText('Go to time (s)...');
    fireEvent.change(search, { target: { value: 'abc' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByText('1.000').className).not.toContain('text-primary');
  });

  it('focuses the time search on Ctrl+G', () => {
    render(
      <TableView session={session()} activeChannels={[{ channelId: 1, color: '#f00', visible: true }]} />,
    );
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Go to time (s)...'));
  });
});

describe('AnalysisPanel', () => {
  const baseProps = {
    activeChannels: [{ channelId: 1, color: '#f00', visible: true }],
    viewRange: null,
    histogramChannelId: null,
    onHistogramChannelChange: () => {},
    xyXChannelId: null,
    xyYChannelId: null,
    onXYChannelChange: () => {},
  };

  it('renders the stats tab and switches tabs', () => {
    const onTabChange = vi.fn();
    render(<AnalysisPanel {...baseProps} session={session()} analysisTab="stats" onTabChange={onTabChange} />);
    expect(screen.getByText('4 pts')).toBeTruthy();

    fireEvent.click(screen.getByText('Laps'));
    fireEvent.click(screen.getByText('Histogram'));
    fireEvent.click(screen.getByText('XY Plot'));
    fireEvent.click(screen.getByText('GPS'));
    expect(onTabChange.mock.calls.map((c) => c[0])).toEqual(['lapanalysis', 'histogram', 'xyplot', 'gps']);
  });

  it('renders the laps tab', () => {
    render(<AnalysisPanel {...baseProps} session={session()} analysisTab="lapanalysis" onTabChange={() => {}} />);
    expect(screen.getByText('No lap markers found in session')).toBeTruthy();
  });
});
