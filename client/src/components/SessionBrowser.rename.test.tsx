// @vitest-environment jsdom
import '../test/dom-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { LocalSession } from '../lib/api';

const session: LocalSession = {
  id: 's1', aim_session_id: 'run1', filename: 'run1.xrk', local_path: '/x/run1.xrk',
  track_name: '', driver_name: '', vehicle_name: '', recorded_at: null, duration_s: 60,
  lap_count: 0, source: 'aim_device', created_at: '2026-10-01T00:00:00', updated_at: '2026-10-01T00:00:00',
};

const api = vi.hoisted(() => ({
  listSessions: vi.fn(),
  loadSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  getAimStatus: vi.fn(),
  uploadFile: vi.fn(),
  fetchUploadLog: vi.fn(),
  fetchAimPullLog: vi.fn(),
  fetchGpsPreview: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

import { SessionBrowser } from './SessionBrowser';

beforeEach(() => {
  api.listSessions.mockResolvedValue([session]);
  api.getAimStatus.mockResolvedValue({ connected: false, device: null });
  api.fetchUploadLog.mockResolvedValue([]);
  api.fetchAimPullLog.mockResolvedValue([]);
  api.renameSession.mockResolvedValue({ ...session, filename: 'Heat2.xrk' });
  api.loadSession.mockResolvedValue({ metadata: {}, channels: [] });
});

function renderBrowser(onSessionLoaded = vi.fn()) {
  render(
    <SessionBrowser
      onSessionLoaded={onSessionLoaded}
      onOpenSettings={() => {}}
      onOpenLive={() => {}}
      theme="dark"
      onToggleTheme={() => {}}
    />,
  );
  return onSessionLoaded;
}

describe('SessionBrowser rename', () => {
  it('renames once when Enter is followed by the input blurring', async () => {
    renderBrowser();
    fireEvent.click(await screen.findByTitle('Rename'));
    const input = screen.getByDisplayValue('run1');
    fireEvent.change(input, { target: { value: 'Heat2' } });
    // In Chrome, removing the focused input fires blur before React has
    // re-rendered, so both handlers run against the same render's state.
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
    });
    await vi.waitFor(() => expect(api.renameSession).toHaveBeenCalled());
    expect(api.renameSession).toHaveBeenCalledTimes(1);
    expect(api.renameSession).toHaveBeenCalledWith('s1', 'Heat2');
  });

  it('does not rename on Escape', async () => {
    renderBrowser();
    fireEvent.click(await screen.findByTitle('Rename'));
    const input = screen.getByDisplayValue('run1');
    fireEvent.change(input, { target: { value: 'Nope' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.blur(input);
    });
    expect(api.renameSession).not.toHaveBeenCalled();
  });
});

describe('SessionBrowser load', () => {
  it("passes the session's source through so the info modal can show it", async () => {
    const onSessionLoaded = renderBrowser();
    fireEvent.click(await screen.findByText('run1'));
    await vi.waitFor(() => expect(onSessionLoaded).toHaveBeenCalled());
    expect(onSessionLoaded.mock.lastCall?.slice(1)).toEqual(['s1', 'run1.xrk', 'aim_device', 'run1']);
  });
});
