// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog } from './ExportDialog';
import { ChannelSidebar } from './ChannelSidebar';
import { makeChannel, makeSamples, makeSession } from '../test-fixtures';
import type { DerivedChannel } from '../lib/useXRKStore';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function session() {
  return makeSession({
    channels: new Map([
      [1, makeChannel(1, 'RPM', { units: 'rpm', longName: 'Engine Speed', fileSampleCount: 1500, sampleRateHz: 50 })],
      [2, makeChannel(2, 'Brake', { fileSampleCount: 300 })],
      [3, makeChannel(3, 'Unused', { fileSampleCount: 0 })],
    ]),
    samples: new Map([[1, makeSamples([1, 2])]]),
  });
}

describe('ExportDialog', () => {
  it('pre-selects channels with data, sorted, and hides empty ones', () => {
    render(<ExportDialog session={session()} fileName="run.xrk" onClose={() => {}} />);
    const names = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    const brakeIdx = names.findIndex((n) => n.startsWith('Brake'));
    const rpmIdx = names.findIndex((n) => n.startsWith('RPM'));
    expect(brakeIdx).toBeGreaterThan(-1);
    expect(brakeIdx).toBeLessThan(rpmIdx);
    expect(screen.queryByText('Unused')).toBeNull();
    expect(screen.getByText('2 / 2 selected')).toBeTruthy();
    expect(screen.getByText('~1,500 rows')).toBeTruthy();
    expect(screen.getByText('2K')).toBeTruthy(); // 1500 samples shown as 2K
  });

  it('toggles, filters and selects/deselects all', () => {
    render(<ExportDialog session={session()} fileName="run.xrk" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Deselect All'));
    expect(screen.getByText('0 / 2 selected')).toBeTruthy();
    expect(screen.getByText('Select channels to export')).toBeTruthy();
    expect((screen.getByText(/Export\s+channels/).closest('button') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('Brake'));
    expect(screen.getByText('1 / 2 selected')).toBeTruthy();
    expect(screen.getByText('~300 rows')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Filter channels...'), { target: { value: 'zzz' } });
    expect(screen.getByText('No channels match your filter')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Filter channels...'), { target: { value: 'rp' } });
    fireEvent.click(screen.getByText('Select All'));
    expect(screen.getByText('2 / 2 selected')).toBeTruthy();
  });

  it('exports the selected channels and closes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['csv']) });
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onClose = vi.fn();

    render(<ExportDialog session={session()} fileName="run.XRK" onClose={onClose} />);
    fireEvent.click(screen.getByText('Export 2 channels'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/export?channels=Brake%2CRPM');
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    click.mockRestore();
  });

  it('closes from Cancel and the backdrop but not from inside', () => {
    const onClose = vi.fn();
    const { container } = render(<ExportDialog session={session()} fileName={null} onClose={onClose} />);
    fireEvent.click(screen.getByText('Export CSV'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ChannelSidebar', () => {
  const derived: DerivedChannel = { id: 10000, name: 'Power', units: 'kW', mode: 'formula', expression: 'a', color: '#0f0' };

  function renderSidebar(overrides: Partial<Parameters<typeof ChannelSidebar>[0]> = {}) {
    const handlers = {
      onToggleChannel: vi.fn(),
      onRemoveDerived: vi.fn(),
      onEditDerived: vi.fn(),
      onCreateDerived: vi.fn(),
      onSearchChange: vi.fn(),
      onShowOnlyWithDataChange: vi.fn(),
      onChartModeChange: vi.fn(),
    };
    const utils = render(
      <ChannelSidebar
        session={session()}
        activeChannels={[]}
        derivedChannels={[derived]}
        derivedSamplesMap={new Map([[10000, makeSamples([1, 2, 3])]])}
        search=""
        showOnlyWithData={false}
        chartMode="separate"
        {...handlers}
        {...overrides}
      />,
    );
    return { ...utils, handlers };
  }

  it('lists session channels with sample counts, rates and no-data badges', () => {
    renderSidebar();
    expect(screen.getByText('3 channels')).toBeTruthy();
    expect(screen.getByText('Engine Speed')).toBeTruthy();
    expect(screen.getByText('2K pts')).toBeTruthy();
    expect(screen.getByText('50Hz')).toBeTruthy();
    expect(screen.getByTestId('channel-row-3').title).toBe('No data recorded for this channel in this session');
  });

  it('toggles channels and shows active chips', () => {
    const { handlers } = renderSidebar({
      activeChannels: [{ channelId: 1, color: '#f00', visible: true }, { channelId: 10000, color: '#0f0', visible: true }],
    });
    expect(screen.getByText('2 active')).toBeTruthy();
    expect(screen.getByText('Active channels')).toBeTruthy();

    fireEvent.click(screen.getByTestId('channel-row-2'));
    expect(handlers.onToggleChannel).toHaveBeenCalledWith(2, '#ff0000');
  });

  it('filters by search across short and long names', () => {
    renderSidebar({ search: 'engine' });
    expect(screen.getByText('1 channels')).toBeTruthy();
    expect(screen.queryByTestId('channel-row-2')).toBeNull();
    expect(screen.queryByText('Power')).toBeNull();
  });

  it('shows an empty state when nothing matches', () => {
    renderSidebar({ search: 'zzz' });
    expect(screen.getByText('No channels match your search')).toBeTruthy();
  });

  it('hides channels without file data when "Has data" is on', () => {
    renderSidebar({ showOnlyWithData: true });
    expect(screen.getByText('2 channels')).toBeTruthy();
    expect(screen.queryByTestId('channel-row-3')).toBeNull();
  });

  it('wires search, has-data, chart-mode and create controls', () => {
    const { handlers } = renderSidebar({ search: 'rp' });
    fireEvent.change(screen.getByTestId('input-channel-search'), { target: { value: 'rpm' } });
    expect(handlers.onSearchChange).toHaveBeenCalledWith('rpm');
    fireEvent.click(screen.getByTestId('btn-has-data-toggle'));
    expect(handlers.onShowOnlyWithDataChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText('Overlay'));
    expect(handlers.onChartModeChange).toHaveBeenCalledWith('overlay');
    fireEvent.click(screen.getByTestId('btn-create-derived-open'));
    expect(handlers.onCreateDerived).toHaveBeenCalled();
  });

  it('edits, removes and toggles derived channels', () => {
    const { handlers } = renderSidebar();
    expect(screen.getByText('3 pts')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Edit'));
    expect(handlers.onEditDerived).toHaveBeenCalledWith(derived);
    fireEvent.click(screen.getByTitle('Delete'));
    expect(handlers.onRemoveDerived).toHaveBeenCalledWith(10000);
    fireEvent.click(screen.getByText('Power'));
    expect(handlers.onToggleChannel).toHaveBeenCalledWith(10000, '#0f0');
  });
});
