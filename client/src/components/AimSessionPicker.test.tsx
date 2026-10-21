// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AimSessionPicker } from './AimSessionPicker';

type Route = (init?: RequestInit) => unknown | Promise<unknown>;

let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: '', json: async () => body } as Response;
}

beforeEach(() => {
  routes = {};
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch ${path}`);
    const result = await route(init);
    return typeof (result as Response)?.json === 'function' ? result : ok(result);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const deviceSessions = [
  { filename: 'a_0001.xrk', size: 2_500_000, date: '', hour: '10:00:00', lap_count: 4, vehicle: 'CT16', device_name: 'EVO5', already_downloaded: false },
  { filename: 'a_0002.xrk', size: 800, date: '', hour: '11:00:00', lap_count: 0, vehicle: 'CT16', device_name: 'EVO5', already_downloaded: false },
  { filename: 'a_0000.xrk', size: 0, date: '', hour: '', lap_count: 0, vehicle: '', device_name: 'EVO5', already_downloaded: true },
];

function renderPicker() {
  const props = { onClose: vi.fn(), onDownloaded: vi.fn() };
  render(<AimSessionPicker {...props} />);
  return props;
}

describe('AimSessionPicker', () => {
  it('lists device sessions with sizes, laps and downloaded state', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: true, sessions: deviceSessions });
    renderPicker();
    expect(screen.getByText('Listing sessions on device...')).toBeTruthy();

    expect(await screen.findByText('a_0001.xrk')).toBeTruthy();
    expect(screen.getByText('2.5 MB')).toBeTruthy();
    expect(screen.getByText('800 B')).toBeTruthy();
    expect(screen.getByText('--')).toBeTruthy();
    expect(screen.getByText('4 laps')).toBeTruthy();
    expect(screen.getByText('downloaded')).toBeTruthy();
    expect(screen.getByText('3 on device')).toBeTruthy();
    expect(screen.getByText('2 new')).toBeTruthy();
    expect((screen.getByText('a_0000.xrk').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the device error from the listing', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: false, sessions: [], error: 'Device not reachable' });
    renderPicker();
    expect(await screen.findByText('Device not reachable')).toBeTruthy();
  });

  it('shows a hint when the device has no sessions', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: true, sessions: [] });
    renderPicker();
    expect(await screen.findByText('No sessions found on device')).toBeTruthy();
  });

  it('selects sessions individually, all new ones, or none', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: true, sessions: deviceSessions });
    renderPicker();
    await screen.findByText('a_0001.xrk');

    fireEvent.click(screen.getByText('a_0001.xrk'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByText('Download 1')).toBeTruthy();
    fireEvent.click(screen.getByText('a_0001.xrk'));
    expect(screen.getByText('0 selected')).toBeTruthy();

    fireEvent.click(screen.getByText('Select all'));
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByText('Deselect all'));
    expect(screen.getByText('0 selected')).toBeTruthy();
  });

  it('pulls selected sessions, polls progress and marks them downloaded', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: true, sessions: deviceSessions });
    let finishPull: (v: unknown) => void = () => {};
    routes['/api/aim/pull'] = () => new Promise((resolve) => { finishPull = resolve; });
    routes['/api/aim/pull/progress'] = () => ({
      active: true, filenames: ['a_0001.xrk'], file_index: 1, file_count: 1, filename: 'a_0001.xrk',
      bytes_received: 1_250_000, bytes_total: 2_500_000, phase: 'download',
    });
    const props = renderPicker();
    await screen.findByText('a_0001.xrk');

    fireEvent.click(screen.getByText('a_0001.xrk'));
    fireEvent.click(screen.getByText('Download 1'));
    expect(screen.getByText('Downloading...')).toBeTruthy();

    const row = screen.getByText('a_0001.xrk').closest('button') as HTMLElement;
    await waitFor(() => expect((row.querySelector('[aria-hidden]') as HTMLElement).style.width).toBe('50%'));
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/aim/pull'))!;
    expect(JSON.parse(init.body)).toEqual({ filenames: ['a_0001.xrk'] });

    finishPull(ok({
      ok: true,
      downloaded: ['a_0001.xrk'],
      results: [{ filename: 'a_0001.xrk', bytes: 2_500_000, duration_s: 3, session_id: 's1', parse_ok: true, local_path: '' }],
    }));

    expect(await screen.findByText(/a_0001\.xrk · 2\.5 MB · downloaded in/)).toBeTruthy();
    expect(props.onDownloaded).toHaveBeenCalled();
    expect(screen.getAllByText('downloaded')).toHaveLength(2);
    expect(screen.getByText('0 selected')).toBeTruthy();
  });

  it('reports per-file failures from the pull', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: true, sessions: deviceSessions });
    routes['/api/aim/pull'] = () => ({ ok: false, downloaded: [], errors: ['a_0002.xrk: timeout'] });
    routes['/api/aim/pull/progress'] = () => ({ active: false });
    const props = renderPicker();
    await screen.findByText('a_0002.xrk');

    fireEvent.click(screen.getByText('a_0002.xrk'));
    fireEvent.click(screen.getByText('Download 1'));

    expect(await screen.findByText('1 download(s) failed: a_0002.xrk: timeout')).toBeTruthy();
    expect(props.onDownloaded).not.toHaveBeenCalled();
  });

  it('reports a top-level pull error', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: true, sessions: deviceSessions });
    routes['/api/aim/pull'] = () => ({ ok: false, error: 'Close live view before downloading logs from the AiM device.', downloaded: [] });
    routes['/api/aim/pull/progress'] = () => ({ active: false });
    renderPicker();
    await screen.findByText('a_0002.xrk');

    fireEvent.click(screen.getByText('a_0002.xrk'));
    fireEvent.click(screen.getByText('Download 1'));

    expect(await screen.findByText('Close live view before downloading logs from the AiM device.')).toBeTruthy();
  });

  it('closes on Escape and backdrop click', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: true, sessions: [] });
    const props = renderPicker();
    await screen.findByText('No sessions found on device');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByText('AiM Device Sessions'));
    fireEvent.click(document.querySelector('.fixed') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
