// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';
import { PreferencesProvider } from '../lib/usePreferences';

const STORED = { aim_wifi_ssid: 'AiM-Net', aim_device_ip: '10.0.0.1', aim_device_port: 2000 };

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return jsonResponse(JSON.parse(String(init.body)));
    return jsonResponse(STORED);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderDialog() {
  render(
    <PreferencesProvider>
      <SettingsDialog onClose={() => {}} />
    </PreferencesProvider>,
  );
  return screen.findByDisplayValue('10.0.0.1');
}

const putCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');

describe('SettingsDialog input validation', () => {
  it('blocks saving an invalid device IP and explains why', async () => {
    const ip = await renderDialog();
    fireEvent.change(ip, { target: { value: 'evil.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/must be an IP address/)).toBeTruthy();
    expect(putCalls()).toHaveLength(0);
  });

  it('blocks an out-of-range port', async () => {
    await renderDialog();
    fireEvent.change(screen.getByDisplayValue('2000'), { target: { value: '70000' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/between 1 and 65535/)).toBeTruthy();
    expect(putCalls()).toHaveLength(0);
  });

  it('sends trimmed, cleaned values when everything is valid', async () => {
    const ip = await renderDialog();
    fireEvent.change(ip, { target: { value: ' 192.168.4.1 ' } });
    fireEvent.change(screen.getByDisplayValue('AiM-Net'), { target: { value: ' Car\u200bNet ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(JSON.parse(String((putCalls()[0][1] as RequestInit).body))).toEqual({
      aim_wifi_ssid: 'CarNet', aim_device_ip: '192.168.4.1', aim_device_port: 2000,
    });
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
  });

  it('shows the backend rejection message', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? jsonResponse({ detail: 'Device IP must be an IP address like 10.0.0.1' }, 400) : jsonResponse(STORED),
    );
    await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText('Device IP must be an IP address like 10.0.0.1')).toBeTruthy();
  });
});
