// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog } from './ExportDialog';
import { ChannelSidebar } from './ChannelSidebar';
import { makeChannel, makeSamples, makeSession } from '../test-fixtures';
import type { DerivedChannel } from '../lib/useXRKStore';
import { PreferencesProvider } from '../lib/usePreferences';
import { CHANNEL_PALETTE } from '../lib/channelColors';

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

  describe('reset button', () => {
    const active = [{ channelId: 1, color: '#f00' }, { channelId: 2, color: '#0f0' }];

    it('asks for confirmation and clears every selected channel when confirmed', () => {
      const confirm = vi.fn(() => true);
      vi.stubGlobal('confirm', confirm);
      const onClearChannels = vi.fn();
      renderSidebar({ activeChannels: active, onClearChannels });

      fireEvent.click(screen.getByRole('button', { name: /reset selected channels/i }));
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/2 selected channels/));
      expect(onClearChannels).toHaveBeenCalledTimes(1);
    });

    it('keeps the selection when the user cancels', () => {
      vi.stubGlobal('confirm', vi.fn(() => false));
      const onClearChannels = vi.fn();
      renderSidebar({ activeChannels: active, onClearChannels });

      fireEvent.click(screen.getByRole('button', { name: /reset selected channels/i }));
      expect(onClearChannels).not.toHaveBeenCalled();
    });

    it('sits in the Active channels section, not the crowded header', () => {
      renderSidebar({ activeChannels: active, onClearChannels: vi.fn() });
      const label = screen.getByText('Active channels');
      const button = screen.getByRole('button', { name: /reset selected channels/i });
      expect(label.parentElement?.contains(button)).toBe(true);
    });

    it('plays the reset choreography only after a confirmed reset', () => {
      vi.stubGlobal('confirm', vi.fn(() => true));
      renderSidebar({ activeChannels: active, onClearChannels: vi.fn() });
      const footer = screen.getByTestId('active-channels-footer');
      expect(footer.classList.contains('qs-resetting')).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: /reset selected channels/i }));
      expect(footer.classList.contains('qs-resetting')).toBe(true);
    });

    it('does not mark a cancelled reset or a manual chip removal as a reset', () => {
      vi.stubGlobal('confirm', vi.fn(() => false));
      const { handlers } = renderSidebar({ activeChannels: active, onClearChannels: vi.fn() });
      fireEvent.click(screen.getByRole('button', { name: /reset selected channels/i }));
      fireEvent.click(screen.getByTitle('Remove RPM'));
      expect(handlers.onToggleChannel).toHaveBeenCalledWith(1, '#f00');
      expect(screen.getByTestId('active-channels-footer').classList.contains('qs-resetting')).toBe(false);
    });

    it('staggers chips by position, capped so long lists finish quickly', () => {
      const many = Array.from({ length: 9 }, (_, k) => ({ channelId: k < 2 ? k + 1 : 100 + k, color: '#f00' }));
      const { container } = renderSidebar({ activeChannels: many, onClearChannels: vi.fn() });
      const steps = [...container.querySelectorAll<HTMLElement>('.qs-chip')].map(c => c.style.getPropertyValue('--i'));
      expect(steps).toEqual(['0', '1', '2', '3', '4', '5', '6', '6', '6']);
    });

    it('is hidden when nothing is selected', () => {
      renderSidebar({ activeChannels: [], onClearChannels: vi.fn() });
      expect(screen.queryByRole('button', { name: /reset selected channels/i })).toBeNull();
    });
  });

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

  it('lets a channel colour be customised per theme from its swatch, and reset', () => {
    localStorage.clear();
    const props = {
      session: session(), activeChannels: [{ channelId: 1, color: '#f77f00' }], derivedChannels: [], derivedSamplesMap: new Map(),
      search: '', showOnlyWithData: false, chartMode: 'separate' as const,
      onToggleChannel: vi.fn(), onRemoveDerived: vi.fn(), onEditDerived: vi.fn(), onCreateDerived: vi.fn(),
      onSearchChange: vi.fn(), onShowOnlyWithDataChange: vi.fn(), onChartModeChange: vi.fn(),
    };
    const { rerender } = render(<PreferencesProvider><ChannelSidebar {...props} theme="dark" /></PreferencesProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'RPM colour' }));
    expect(props.onToggleChannel).not.toHaveBeenCalled(); // swatch doesn't toggle the channel
    const picker = screen.getByRole('dialog', { name: 'RPM colour' });
    fireEvent.click(within(picker).getByRole('button', { name: CHANNEL_PALETTE.dark[3] }));
    const stored = () => JSON.parse(localStorage.getItem('quickscope-preferences')!).channelColors;
    expect(stored()).toEqual({ dark: { RPM: CHANNEL_PALETTE.dark[3] }, light: {} });

    // Light theme keeps its own colours
    rerender(<PreferencesProvider><ChannelSidebar {...props} theme="light" /></PreferencesProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'RPM colour' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'RPM colour' })).getByRole('button', { name: 'Reset to default' }));
    expect(stored()).toEqual({ dark: { RPM: CHANNEL_PALETTE.dark[3] }, light: {} });
  });
});
