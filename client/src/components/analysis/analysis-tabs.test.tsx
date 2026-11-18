// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatsTab } from './StatsTab';
import { LapAnalysisTab } from './LapAnalysisTab';
import { makeChannel, makeSamples, makeSession } from '../../test-fixtures';

afterEach(cleanup);

function session() {
  return makeSession({
    channels: new Map([
      [1, makeChannel(1, 'RPM', { units: 'rpm' })],
      [2, makeChannel(2, 'Empty', { fileSampleCount: 0 })],
    ]),
    samples: new Map([[1, makeSamples([1000, 3000, 2000])]]),
  });
}

describe('StatsTab', () => {
  it('prompts to activate channels when none are active', () => {
    render(<StatsTab session={session()} activeChannels={[]} viewRange={null} />);
    expect(screen.getByText('Activate channels to see statistics')).toBeTruthy();
  });

  it('shows min/max with timestamps, mean and std dev for the whole session', () => {
    render(
      <StatsTab session={session()} activeChannels={[{ channelId: 1, color: '#f00' }]} viewRange={null} />,
    );
    expect(screen.getByText('RPM')).toBeTruthy();
    expect(screen.getByText('(rpm)')).toBeTruthy();
    expect(screen.getByText('3 pts')).toBeTruthy();
    expect(screen.getAllByText('1000.0')).toHaveLength(2); // min, and std dev of [1000, 3000, 2000]
    expect(screen.getByText('@ 00:00.000')).toBeTruthy();
    expect(screen.getByText('3000.0')).toBeTruthy(); // max
    expect(screen.getByText('@ 00:01.000')).toBeTruthy();
    expect(screen.getByText('2000.0')).toBeTruthy(); // mean
  });

  it('restricts stats to the zoomed range', () => {
    render(
      <StatsTab
        session={session()}
        activeChannels={[{ channelId: 1, color: '#f00' }]}
        viewRange={{ startMs: 1000, endMs: 2000 }}
      />,
    );
    expect(screen.getByText('Showing statistics for selected zoom range')).toBeTruthy();
    expect(screen.getByText('2 pts')).toBeTruthy();
    expect(screen.getByText('@ 00:02.000')).toBeTruthy(); // min 2000 at t=2s
  });

  it('jumps to the min/max timestamp when navigation is available', () => {
    const onNavigateToTime = vi.fn();
    render(
      <StatsTab
        session={session()}
        activeChannels={[{ channelId: 1, color: '#f00' }]}
        viewRange={null}
        onNavigateToTime={onNavigateToTime}
      />,
    );
    fireEvent.click(screen.getByTitle('Jump to max @ 00:01.000'));
    fireEvent.click(screen.getByTitle('Jump to min @ 00:00.000'));
    expect(onNavigateToTime.mock.calls).toEqual([[1000], [0]]);
  });

  it('labels channels without data', () => {
    render(
      <StatsTab session={session()} activeChannels={[{ channelId: 2, color: '#0f0' }]} viewRange={null} />,
    );
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.getByText('No data recorded for this channel in this session')).toBeTruthy();
  });

  it('includes derived channels', () => {
    render(
      <StatsTab
        session={session()}
        activeChannels={[{ channelId: 10000, color: '#00f' }]}
        viewRange={null}
        derivedChannels={[{ id: 10000, name: 'Power', units: 'kW', mode: 'formula', expression: 'x', color: '#00f' }]}
        derivedSamplesMap={new Map([[10000, makeSamples([5, 7])]])}
      />,
    );
    expect(screen.getByText('Power')).toBeTruthy();
    expect(screen.getByText('2 pts')).toBeTruthy();
    expect(screen.getByText('6.00')).toBeTruthy();
  });
});

describe('LapAnalysisTab', () => {
  function lapSession(lapSource: 'device' | 'gps_auto' | 'beacon_auto' | 'none' = 'device') {
    // Laps of 60 s, 55 s and 58 s — all comfortably long.
    return makeSession({
      channels: new Map([[1, makeChannel(1, 'Speed')]]),
      samples: new Map([[1, [
        { timestamp: 10_000, value: 50 },
        { timestamp: 70_000, value: 70 },
        { timestamp: 100_000, value: 90 },
        { timestamp: 183_000, value: 30 },
      ]]]),
      lapMarkers: [
        { timestamp: 0, lapNumber: 1 },
        { timestamp: 60_000, lapNumber: 2 },
        { timestamp: 115_000, lapNumber: 3 },
        { timestamp: 173_000, lapNumber: 4 },
      ],
      lapSource,
    });
  }

  it('explains when there are no laps', () => {
    render(<LapAnalysisTab session={makeSession()} activeChannels={[]} />);
    expect(screen.getByText('No lap markers found in session')).toBeTruthy();
  });

  it('lists each lap time and highlights the best lap', () => {
    render(<LapAnalysisTab session={lapSession()} activeChannels={[]} />);
    expect(screen.getByText('Device markers')).toBeTruthy();
    expect(screen.getByText('Lap 1')).toBeTruthy();
    expect(screen.getByText('Lap 2')).toBeTruthy();
    expect(screen.getByText('Lap 3')).toBeTruthy();
    expect(screen.getByText('1:00.000')).toBeTruthy();
    expect(screen.getByText('0:58.000')).toBeTruthy();
    // Best lap appears in the summary card and in its row
    expect(screen.getAllByText('0:55.000')).toHaveLength(2);
    expect(screen.getByText('Best')).toBeTruthy();
  });

  it('leaves the gap blank on the first lap (out lap) but shows it on later laps', () => {
    render(<LapAnalysisTab session={lapSession()} activeChannels={[]} />);
    expect(screen.queryByText('+5.000')).toBeNull(); // lap 1: 60 s vs best 55 s
    expect(screen.getByText('+3.000')).toBeTruthy(); // lap 3: 58 s vs best 55 s
  });

  it('labels auto-detected laps', () => {
    const { rerender } = render(<LapAnalysisTab session={lapSession('gps_auto')} activeChannels={[]} />);
    expect(screen.getByText('Auto-detected (GPS)')).toBeTruthy();
    rerender(<LapAnalysisTab session={lapSession('beacon_auto')} activeChannels={[]} />);
    expect(screen.getByText('Auto-detected (beacon)')).toBeTruthy();
  });

  it('shows the per-lap mean of active channels', () => {
    render(
      <LapAnalysisTab session={lapSession()} activeChannels={[{ channelId: 1, color: '#f00' }]} />,
    );
    // Lap 1 (0-60 s): one sample, 50. Lap 2 (60-115 s): 70 and 90 → 80.
    expect(screen.getByText('50.00')).toBeTruthy();
    expect(screen.getByText('80.00')).toBeTruthy();
    expect(screen.getAllByText('Speed').length).toBeGreaterThan(0);
  });

  it('selects laps with checkboxes, best and clear', () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { rerender } = render(
      <LapAnalysisTab session={lapSession()} activeChannels={[]} selectedLaps={[]}
        onToggleLap={onToggle} onSetSelectedLaps={onSelect} />,
    );
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    fireEvent.click(boxes[2]);
    expect(onToggle).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Select best' }));
    expect(onSelect).toHaveBeenCalledWith([1]); // lap 2 (55 s) is best
    rerender(
      <LapAnalysisTab session={lapSession()} activeChannels={[]} selectedLaps={[0, 2]}
        onToggleLap={onToggle} onSetSelectedLaps={onSelect} />,
    );
    expect(screen.getByText('2 selected — comparing')).toBeTruthy();
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSelect).toHaveBeenCalledWith([]);
  });

  it('truncates long channel names with the full name on hover', () => {
    const long = 'LF_BRKTempCH1_VeryLongName';
    const sess = lapSession();
    sess.channels.set(1, { ...sess.channels.get(1)!, shortName: long });
    render(<LapAnalysisTab session={sess} activeChannels={[{ channelId: 1, color: '#f00' }]} />);
    const names = screen.getAllByTitle(long);
    expect(names.length).toBeGreaterThan(0);
    expect(names[0].className).toContain('truncate');
  });

  it('shows each lap\'s gap to the best lap and flags much slower laps', () => {
    const sess = lapSession();
    // Add a 3-minute lap 4 (173 s → 353 s): far slower than the ~58 s median.
    sess.lapMarkers = [...sess.lapMarkers, { timestamp: 353_000, lapNumber: 5 }];
    render(<LapAnalysisTab session={sess} activeChannels={[]} />);
    expect(screen.queryByText('+5.000')).toBeNull(); // lap 1: out lap, gap left blank
    expect(screen.getByText('+3.000')).toBeTruthy(); // lap 3: 58 s
    expect(screen.getByText('+125.000')).toBeTruthy(); // lap 4: 180 s
    expect(screen.getAllByText('slow')).toHaveLength(1);
  });
});
