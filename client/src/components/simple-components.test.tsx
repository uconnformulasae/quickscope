// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { SettingsDialog } from './SettingsDialog';
import { SessionInfoModal } from './SessionInfoModal';
import { SessionHeader } from './SessionHeader';
import { GaugeGlyph, QuickScopeLogo } from './QuickScopeLogo';
import { sessionSubtitle } from '../lib/session-subtitle';
import { useTheme } from '../lib/useTheme';
import { makeSession } from '../test-fixtures';

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: '', json: async () => body } as Response;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('ThemeToggle', () => {
  it('offers the opposite theme and calls onToggle', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ThemeToggle theme="dark" onToggle={onToggle} />);
    fireEvent.click(screen.getByTitle('Switch to light mode'));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<ThemeToggle theme="light" onToggle={onToggle} />);
    expect(screen.getByTitle('Switch to dark mode')).toBeTruthy();
  });
});

describe('useTheme', () => {
  it('defaults to dark and applies the class to <html>', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('restores a saved theme and persists toggles', () => {
    localStorage.setItem('quickscope-theme', 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('dark');
    expect(localStorage.getItem('quickscope-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('ignores an invalid saved value', () => {
    localStorage.setItem('quickscope-theme', 'purple');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
  });
});

describe('SettingsDialog', () => {
  const stored = { aim_wifi_ssid: 'AiM-EVO5', aim_device_ip: '10.0.0.5', aim_device_port: 2001 };

  it('loads settings into the form', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stored));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByDisplayValue('10.0.0.5')).toBeTruthy();
    expect(screen.getByDisplayValue('AiM-EVO5')).toBeTruthy();
    expect(screen.getByDisplayValue('2001')).toBeTruthy();
  });

  it('shows a load error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText('Failed to get settings: 500')).toBeTruthy();
  });

  it('saves edits and defaults an empty port to 2000', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(stored));
    render(<SettingsDialog onClose={() => {}} />);
    const ip = await screen.findByDisplayValue('10.0.0.5');
    fireEvent.change(ip, { target: { value: '192.168.4.1' } });
    fireEvent.change(screen.getByDisplayValue('2001'), { target: { value: '' } });

    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('/api/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ aim_wifi_ssid: 'AiM-EVO5', aim_device_ip: '192.168.4.1', aim_device_port: 2000 });
  });

  it('shows a save error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(stored));
    render(<SettingsDialog onClose={() => {}} />);
    await screen.findByDisplayValue('10.0.0.5');
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Failed to update settings: 500')).toBeTruthy();
  });

  it('closes on Escape, Cancel and backdrop click but not on a click inside', async () => {
    fetchMock.mockResolvedValue(jsonResponse(stored));
    const onClose = vi.fn();
    const { container } = render(<SettingsDialog onClose={onClose} />);
    await screen.findByDisplayValue('10.0.0.5');

    fireEvent.click(screen.getByText('Settings'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.mouseDown(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('SessionInfoModal', () => {
  const props = {
    sessionId: 's1',
    metadata: {
      driver: 'Driver A', vehicle: 'CT16', venue: 'Unknown', date: '19/10/2026', time: '', championship: '', sessionType: '',
    },
    durationMs: 65_500,
    lapCount: 0,
    totalSamples: 1000,
    fileName: 'run.xrk',
  };

  it('shows metadata, formatted duration and placeholders for empty fields', () => {
    render(<SessionInfoModal {...props} onClose={() => {}} />);
    expect(screen.getByText('run.xrk')).toBeTruthy();
    expect(screen.getByText('Driver A')).toBeTruthy();
    expect(screen.getByText('1:05.50')).toBeTruthy();
    // Unknown venue, empty championship and zero laps all render as an em dash
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('shows the sample count', () => {
    render(<SessionInfoModal {...props} totalSamples={6141017} onClose={() => {}} />);
    expect(screen.getByText('6,141,017')).toBeTruthy();
  });

  it('renames the session file', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 's1', filename: 'new.xrk' }));
    const onFileRenamed = vi.fn();
    render(<SessionInfoModal {...props} onClose={() => {}} onFileRenamed={onFileRenamed} />);

    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(screen.getByDisplayValue('run.xrk'), { target: { value: 'new.xrk' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onFileRenamed).toHaveBeenCalledWith('new.xrk'));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/sessions/s1/rename');
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('skips the request when the name is unchanged', () => {
    render(<SessionInfoModal {...props} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.click(screen.getByText('Save'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Rename')).toBeTruthy();
  });

  it('shows a rename error and keeps editing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'Invalid filename' }, 400));
    render(<SessionInfoModal {...props} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(screen.getByDisplayValue('run.xrk'), { target: { value: '../x' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Invalid filename')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('cancel restores the original name', () => {
    render(<SessionInfoModal {...props} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(screen.getByDisplayValue('run.xrk'), { target: { value: 'other.xrk' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByText('run.xrk')).toBeTruthy();
  });

  it('closes on Escape and backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(<SessionInfoModal {...props} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(container.firstChild as Element);
    fireEvent.click(screen.getByText('Session Info'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('SessionHeader', () => {
  function renderHeader(overrides: Partial<Parameters<typeof SessionHeader>[0]> = {}) {
    const handlers = {
      onToggleLeft: vi.fn(),
      onToggleRight: vi.fn(),
      onFileSelected: vi.fn(),
      onExportOpen: vi.fn(),
      onBack: vi.fn(),
      onToggleTheme: vi.fn(),
      onViewModeChange: vi.fn(),
      onSessionInfoOpen: vi.fn(),
    };
    const utils = render(
      <SessionHeader
        session={makeSession({
          durationMs: 61_234,
          lapMarkers: [{ timestamp: 0, lapNumber: 0 }, { timestamp: 30_000, lapNumber: 1 }, { timestamp: 60_000, lapNumber: 2 }],
        })}
        fileName="run.xrk"
        leftOpen
        rightOpen={false}
        theme="dark"
        viewMode="chart"
        {...handlers}
        {...overrides}
      />,
    );
    return { ...utils, handlers };
  }

  it('shows file name and subtitle, no sample count', () => {
    const session = makeSession({
      durationMs: 61_234,
      lapMarkers: [{ timestamp: 0, lapNumber: 0 }, { timestamp: 30_000, lapNumber: 1 }, { timestamp: 60_000, lapNumber: 2 }],
    });
    renderHeader({ session });
    expect(screen.getByText('run.xrk')).toBeTruthy();
    const m = session.metadata;
    expect(screen.getByText(sessionSubtitle(m, session.durationMs, 2))).toBeTruthy();
    expect(screen.queryByText(/samples/)).toBeNull();
  });

  it('opens session info from the title', () => {
    const { handlers } = renderHeader();
    fireEvent.click(screen.getByText('run.xrk'));
    expect(handlers.onSessionInfoOpen).toHaveBeenCalled();
  });

  it('wires navigation, sidebar and view-mode buttons', () => {
    const { handlers } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide channels' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show analysis' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    fireEvent.click(screen.getByTitle('Switch to light mode'));
    expect(handlers.onBack).toHaveBeenCalled();
    expect(handlers.onToggleLeft).toHaveBeenCalled();
    expect(handlers.onToggleRight).toHaveBeenCalled();
    expect(handlers.onViewModeChange).toHaveBeenCalledWith('table');
    expect(handlers.onToggleTheme).toHaveBeenCalled();
  });

  it('opens the menu for export and session info', () => {
    const { handlers } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export CSV…' }));
    expect(handlers.onExportOpen).toHaveBeenCalled();
    expect(screen.queryByRole('menuitem', { name: 'Get Info' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Get Info' }));
    expect(handlers.onSessionInfoOpen).toHaveBeenCalledTimes(1);
  });

  it('Open… triggers the hidden file input', () => {
    renderHeader();
    const input = screen.getByTestId('input-file-hidden') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }));
    expect(click).toHaveBeenCalled();
  });

  it('passes a picked file to onFileSelected', () => {
    const { handlers } = renderHeader();
    const file = new File(['x'], 'new.xrk');
    fireEvent.change(screen.getByTestId('input-file-hidden'), { target: { files: [file] } });
    expect(handlers.onFileSelected).toHaveBeenCalledWith(file);
  });

  it('hides session-only controls without a session', () => {
    renderHeader({ session: null, fileName: null });
    expect(screen.queryByRole('radio', { name: 'Chart' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('menuitem', { name: 'Open…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Export CSV…' })).toBeNull();
  });
});

describe('QuickScopeLogo', () => {
  it('renders the gauge mark with an accessible name and the wordmark', () => {
    const { container, rerender } = render(<QuickScopeLogo />);
    const img = screen.getByRole('img', { name: 'QuickScope' });
    expect(img.querySelector('circle[fill="#f77f00"]')).not.toBeNull();
    expect(container.textContent).toContain('QuickScope');

    rerender(<QuickScopeLogo showWordmark={false} />);
    expect(screen.getByRole('img', { name: 'QuickScope' })).toBeTruthy();
    expect(container.textContent).not.toContain('QuickScope');
  });

  it('uses unique gradient ids per instance', () => {
    const { container } = render(<><QuickScopeLogo /><QuickScopeLogo /></>);
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('mono renders no orange fill', () => {
    const { container } = render(<GaugeGlyph size={20} mono />);
    expect(container.querySelector('[fill="#f77f00"]')).toBeNull();
  });
});
