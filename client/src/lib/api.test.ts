import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteSession,
  exportCSV,
  exportSessionCSV,
  fetchSessionFile,
  fetchAimPullLog,
  fetchChannelData,
  fetchGPS,
  fetchGPSPreview,
  fetchUploadLog,
  getSettings,
  listSessions,
  liveWebSocketUrl,
  loadSession,
  pullFromAim,
  renameSession,
  updateSettings,
} from './api';

// No window in the node test environment → API_BASE falls back to localhost.
const BASE = 'http://localhost:8000';

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? '',
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
  } as Response;
}

function badJsonResponse(status: number, statusText: string) {
  return {
    ok: false,
    status,
    statusText,
    json: async () => { throw new SyntaxError('bad json'); },
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session endpoints', () => {
  it('lists sessions', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: 'a' }]));
    await expect(listSessions()).resolves.toEqual([{ id: 'a' }]);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/sessions`);
  });

  it('throws with the status code when listing fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    await expect(listSessions()).rejects.toThrow('Failed to list sessions: 500');
  });

  it('loads a session with POST', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ durationMs: 1 }));
    await expect(loadSession('abc')).resolves.toEqual({ durationMs: 1 });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/sessions/abc/load`, { method: 'POST' });
  });

  it('surfaces the backend detail when loading fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'Session file missing' }, { status: 404 }));
    await expect(loadSession('abc')).rejects.toThrow('Session file missing');
  });

  it('falls back to statusText when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(badJsonResponse(502, 'Bad Gateway'));
    await expect(loadSession('abc')).rejects.toThrow('Bad Gateway');
  });

  it('renames with a JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'abc', filename: 'new.xrk' }));
    await renameSession('abc', 'new.xrk');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/abc/rename`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ filename: 'new.xrk' });
  });

  it('surfaces rename errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'Invalid filename' }, { status: 400 }));
    await expect(renameSession('abc', '../x')).rejects.toThrow('Invalid filename');
  });

  it('deletes with DELETE and throws on failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    await deleteSession('abc');
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/sessions/abc`, { method: 'DELETE' });

    fetchMock.mockResolvedValueOnce(jsonResponse(null, { status: 404 }));
    await expect(deleteSession('abc')).rejects.toThrow('Delete failed: 404');
  });
});

describe('AiM endpoints', () => {
  it('posts filenames to pull', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, downloaded: ['a.xrz'] }));
    await expect(pullFromAim(['a.xrz'])).resolves.toEqual({ ok: true, downloaded: ['a.xrz'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/aim/pull`);
    expect(JSON.parse(init.body)).toEqual({ filenames: ['a.xrz'] });
  });

  it('surfaces pull errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'busy' }, { status: 409 }));
    await expect(pullFromAim(['a.xrz'])).rejects.toThrow('busy');
  });

  it('unwraps pull and upload log entries', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [{ ts: 't' }] }));
    await expect(fetchAimPullLog()).resolves.toEqual([{ ts: 't' }]);
    await expect(fetchUploadLog()).resolves.toEqual([{ ts: 't' }]);
  });
});

describe('settings endpoints', () => {
  it('gets and updates settings', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ aim_device_ip: '10.0.0.1' }));
    await expect(getSettings()).resolves.toEqual({ aim_device_ip: '10.0.0.1' });

    await updateSettings({ aim_device_ip: '10.0.0.2' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/api/settings`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ aim_device_ip: '10.0.0.2' });
  });

  it('throws when updating settings fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    await expect(updateSettings({})).rejects.toThrow('Failed to update settings: 500');
  });
});

describe('analysis endpoints', () => {
  it('returns an empty map without a request when no channels are asked for', async () => {
    const result = await fetchChannelData([]);
    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('url-encodes channel names and returns a map', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      'GPS Speed': { timestamps: [0], values: [1] },
      RPM: { timestamps: [0], values: [2] },
    }));
    const result = await fetchChannelData(['GPS Speed', 'RPM']);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/data?channels=GPS%20Speed%2CRPM`);
    expect([...result.keys()]).toEqual(['GPS Speed', 'RPM']);
    expect(result.get('RPM')).toEqual({ timestamps: [0], values: [2] });
  });

  it('throws when channel data fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 400 }));
    await expect(fetchChannelData(['x'])).rejects.toThrow('Failed to fetch channel data: 400');
  });

  it('returns GPS data or null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ gps: { lat: [1] } }));
    await expect(fetchGPS()).resolves.toEqual({ lat: [1] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ gps: null }));
    await expect(fetchGPS()).resolves.toBeNull();
  });

  it('returns null for a missing GPS preview but throws on other errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ preview: { pointCount: 3 } }));
    await expect(fetchGPSPreview('s1')).resolves.toEqual({ pointCount: 3 });
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}/api/sessions/s1/gps-preview`);

    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
    await expect(fetchGPSPreview('s1')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500 }));
    await expect(fetchGPSPreview('s1')).rejects.toThrow('Failed to fetch GPS preview: 500');
  });

  it('exports CSV as a blob', async () => {
    fetchMock.mockResolvedValue(jsonResponse('a,b'));
    const blob = await exportCSV(['RPM', 'Speed']);
    expect(blob).toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/export?channels=RPM%2CSpeed`);
  });

  it('throws when export fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 400 }));
    await expect(exportCSV(['RPM'])).rejects.toThrow('Export failed: 400');
  });

  it('exports a stored session CSV as a blob', async () => {
    fetchMock.mockResolvedValue(jsonResponse('a,b'));
    const blob = await exportSessionCSV('sid-1', ['RPM']);
    expect(blob).toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/sessions/sid-1/export?channels=RPM`);
  });

  it('downloads the session file as a blob with filename from Content-Disposition', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-disposition' ? 'attachment; filename="run.xrk"' : null) },
      blob: async () => new Blob(['xrk']),
    } as Response);
    const { blob, filename } = await fetchSessionFile('sid-2');
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe('run.xrk');
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/sessions/sid-2/file`);
  });
});

describe('liveWebSocketUrl', () => {
  it('swaps http for ws', () => {
    expect(liveWebSocketUrl()).toBe('ws://localhost:8000/api/live/ws');
  });
});
