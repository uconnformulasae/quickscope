// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionBrowser } from './SessionBrowser';
import type { LocalSession } from '../lib/api';

type Route = (init?: RequestInit) => unknown;

let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: '', json: async () => body } as Response;
}

function session(overrides: Partial<LocalSession>): LocalSession {
  return {
    id: 'id',
    aim_session_id: '',
    filename: 'run.xrk',
    local_path: null,
    track_name: '',
    driver_name: '',
    vehicle_name: '',
    recorded_at: null,
    duration_s: 0,
    lap_count: 0,
    source: 'manual_upload',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const sessions = [
  session({ id: 'old', filename: 'old.xrk', track_name: 'Lot', driver_name: 'Driver A', duration_s: 65, lap_count: 3, recorded_at: '2026-09-01T10:00:00Z' }),
  session({ id: 'new', filename: 'a_0042.xrk', aim_session_id: 'Endurance', vehicle_name: 'CT16', duration_s: 3725, source: 'aim_device', recorded_at: '2026-10-02T10:00:00Z' }),
];

beforeEach(() => {
  routes = {
    '/api/sessions': () => sessions,
    '/api/aim/status': () => ({ connected: false, device: null }),
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`);
    const result = await route(init);
    return typeof (result as Response)?.json === 'function' ? result : ok(result);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderBrowser() {
  const props = {
    onSessionLoaded: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenLive: vi.fn(),
    onToggleTheme: vi.fn(),
  };
  render(<SessionBrowser {...props} theme="dark" />);
  return props;
}

const rows = () => screen.getAllByRole('button').filter((b) => b.getAttribute('tabindex') !== null);

describe('SessionBrowser', () => {
  it('lists sessions newest first with duration, laps and count', async () => {
    renderBrowser();
    expect(screen.getByText('Loading sessions...')).toBeTruthy();

    expect(await screen.findByText('Endurance')).toBeTruthy();
    const [first, second] = rows();
    expect(within(first).getByText('Endurance')).toBeTruthy();
    expect(within(first).getByText('1:02:05')).toBeTruthy();
    expect(within(second).getByText('old.xrk')).toBeTruthy();
    expect(within(second).getByText('1:05')).toBeTruthy();
    expect(within(second).getByText('3 laps')).toBeTruthy();
    expect(within(second).getByText('Lot')).toBeTruthy();
    expect(screen.getByText('2 sessions')).toBeTruthy();
  });

  it('shows an empty state with no sessions', async () => {
    routes['/api/sessions'] = () => [];
    renderBrowser();
    expect(await screen.findByText('No sessions yet')).toBeTruthy();
    expect(screen.getByText('0 sessions')).toBeTruthy();
  });

  it('filters by filename, track, driver and vehicle', async () => {
    renderBrowser();
    await screen.findByText('Endurance');
    const search = screen.getByPlaceholderText('Search sessions...');

    fireEvent.change(search, { target: { value: 'driver a' } });
    expect(rows()).toHaveLength(1);
    expect(screen.getByText('old.xrk')).toBeTruthy();

    fireEvent.change(search, { target: { value: 'ct16' } });
    expect(screen.getByText('Endurance')).toBeTruthy();
    expect(screen.queryByText('old.xrk')).toBeNull();

    fireEvent.change(search, { target: { value: 'nothing' } });
    expect(screen.getByText('No sessions match your search')).toBeTruthy();
  });

  it('loads a session on click', async () => {
    const info = { durationMs: 1 };
    routes['/api/sessions/old/load'] = () => info;
    const props = renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.click(screen.getByText('old.xrk'));
    await waitFor(() => expect(props.onSessionLoaded).toHaveBeenCalledWith(info, 'old', 'old.xrk'));
  });

  it('loads a session with the keyboard', async () => {
    routes['/api/sessions/old/load'] = () => ({ durationMs: 1 });
    const props = renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.keyDown(rows()[1], { key: 'Enter' });
    await waitFor(() => expect(props.onSessionLoaded).toHaveBeenCalled());
  });

  it('shows and dismisses load errors', async () => {
    routes['/api/sessions/old/load'] = () => ({ ok: false, status: 500, statusText: '', json: async () => ({ detail: 'Failed to parse session file' }) });
    renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.click(screen.getByText('old.xrk'));
    expect(await screen.findByText('Failed to parse session file')).toBeTruthy();
    fireEvent.click(screen.getByText('dismiss'));
    expect(screen.queryByText('Failed to parse session file')).toBeNull();
  });

  it('deletes a session after confirmation', async () => {
    const deleted: string[] = [];
    routes['/api/sessions/old'] = (init) => { deleted.push(init?.method ?? ''); return null; };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.click(within(rows()[1]).getByTitle('Delete'));
    await waitFor(() => expect(deleted).toEqual(['DELETE']));
  });

  it('does not delete when the confirmation is cancelled', async () => {
    routes['/api/sessions/old'] = () => { throw new Error('should not delete'); };
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.click(within(rows()[1]).getByTitle('Delete'));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/sessions/old'))).toBe(false);
  });

  it('renames a session when the field loses focus', async () => {
    const bodies: unknown[] = [];
    routes['/api/sessions/old/rename'] = (init) => { bodies.push(JSON.parse(String(init?.body))); return {}; };
    renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.click(within(rows()[1]).getByTitle('Rename'));
    const input = screen.getByDisplayValue('old');
    fireEvent.change(input, { target: { value: 'Autocross 1' } });
    fireEvent.blur(input);

    await waitFor(() => expect(bodies).toEqual([{ filename: 'Autocross 1' }]));
  });

  it('cancels a rename with Escape and skips unchanged names', async () => {
    routes['/api/sessions/old/rename'] = () => { throw new Error('should not rename'); };
    renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.click(within(rows()[1]).getByTitle('Rename'));
    fireEvent.keyDown(screen.getByDisplayValue('old'), { key: 'Escape' });
    expect(screen.queryByDisplayValue('old')).toBeNull();

    fireEvent.click(within(rows()[1]).getByTitle('Rename'));
    fireEvent.blur(screen.getByDisplayValue('old'));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/rename'))).toBe(false);
  });

  it('shows AiM connection state and passes the device to Live', async () => {
    const device = { ip: '10.0.0.1', ssid: 'AiM', device_name: 'EVO5 Logger' };
    routes['/api/aim/status'] = () => ({ connected: true, device });
    const props = renderBrowser();

    expect(await screen.findByText('AiM (EVO5 Logger)')).toBeTruthy();
    fireEvent.click(screen.getByText('Live'));
    expect(props.onOpenLive).toHaveBeenCalledWith(device);
  });

  it('opens Live without a device when AiM is unreachable', async () => {
    const props = renderBrowser();
    await screen.findByText('old.xrk');
    fireEvent.click(screen.getByText('Live'));
    expect(props.onOpenLive).toHaveBeenCalledWith(null);
  });

  it('opens settings and toggles theme', async () => {
    const props = renderBrowser();
    await screen.findByText('old.xrk');
    fireEvent.click(screen.getByTitle('Settings'));
    fireEvent.click(screen.getByTitle('Switch to light mode'));
    expect(props.onOpenSettings).toHaveBeenCalled();
    expect(props.onToggleTheme).toHaveBeenCalled();
  });

  it('opens the AiM picker', async () => {
    routes['/api/aim/sessions'] = () => ({ ok: true, sessions: [] });
    renderBrowser();
    await screen.findByText('old.xrk');
    fireEvent.click(screen.getByText('Pull from AiM'));
    expect(screen.getByText('AiM Device Sessions')).toBeTruthy();
  });

  it('shows the activity log for uploads and AiM pulls', async () => {
    routes['/api/uploads/log'] = () => ({
      entries: [{ ts: new Date().toISOString(), filename: 'up.xrk', size: 2048, duration_s: 2, client_ip: '127.0.0.1', user_agent: '', status: 'ok' }],
    });
    routes['/api/aim/pull/log'] = () => ({
      entries: [{ ts: new Date().toISOString(), action: 'list', status: 'list_ok', device_ip: '10.0.0.1', size: 0, duration_s: 0.5, session_count: 7 }],
    });
    renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.click(screen.getByText('Activity'));
    expect(await screen.findByText('up.xrk')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('1.0 KB/s')).toBeTruthy();

    fireEvent.click(screen.getByText('AiM Pulls'));
    expect(screen.getByText('7 sessions')).toBeTruthy();
    expect(screen.getByText('list_ok')).toBeTruthy();
  });

  it('shows empty activity logs', async () => {
    routes['/api/uploads/log'] = () => ({ entries: [] });
    routes['/api/aim/pull/log'] = () => ({ entries: [] });
    renderBrowser();
    await screen.findByText('old.xrk');

    fireEvent.click(screen.getByText('Activity'));
    expect(await screen.findByText('No uploads recorded since the backend started.')).toBeTruthy();
    fireEvent.click(screen.getByText('AiM Pulls'));
    expect(screen.getByText('No AiM list/pull attempts recorded since the backend started.')).toBeTruthy();
  });

  it('ignores dropped files that are not .xrk/.xrz', async () => {
    renderBrowser();
    await screen.findByText('old.xrk');
    const root = screen.getByText('2 sessions').parentElement as HTMLElement;
    fireEvent.drop(root, { dataTransfer: { files: [new File(['x'], 'notes.txt')] } });
    expect(screen.queryByText(/Uploading/)).toBeNull();
  });

  it('uploads a picked file and opens the new session', async () => {
    class FakeXHR {
      static last: FakeXHR;
      upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = { onprogress: null };
      status = 0;
      statusText = '';
      responseText = '';
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      method = '';
      url = '';
      constructor() { FakeXHR.last = this; }
      open(method: string, url: string) { this.method = method; this.url = url; }
      send() {}
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const props = renderBrowser();
    await screen.findByText('old.xrk');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'.repeat(10)], 'fresh.xrk')] } });

    expect(await screen.findByText(/Uploading/)).toBeTruthy();
    expect(FakeXHR.last.method).toBe('POST');
    expect(FakeXHR.last.url).toContain('/api/upload');

    routes['/api/sessions'] = () => [...sessions, session({ id: 'fresh-id', filename: 'fresh.xrk' })];
    FakeXHR.last.status = 200;
    FakeXHR.last.responseText = JSON.stringify({ durationMs: 5, sessionId: 'fresh-id' });
    FakeXHR.last.onload?.();

    await waitFor(() =>
      expect(props.onSessionLoaded).toHaveBeenCalledWith({ durationMs: 5, sessionId: 'fresh-id' }, 'fresh-id', 'fresh.xrk'),
    );
    expect(screen.queryByText(/Uploading/)).toBeNull();
  });
});
