// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveView } from './LiveView';

const stream = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('./live/useLiveStream', () => ({
  useLiveStream: () => stream.value,
}));

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchLiveLayouts: vi.fn(async () => ({ layouts: [], selection: {} })),
  saveLiveLayout: vi.fn(async () => undefined),
  saveLiveLayoutSelection: vi.fn(async () => undefined),
  deleteLiveLayout: vi.fn(async () => undefined),
  fetchLiveChannels: vi.fn(async () => ({ vehicle: 'ev', channels: [], units: {} })),
}));

function setStream(status: string, error: string | null = null) {
  stream.value = {
    status,
    latest: null,
    error,
    device: null,
    reconnecting: false,
    receivedAt: null,
    totalReceived: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    togglePause: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LiveView header', () => {
  it('shows Not connected with a Retry button on error', () => {
    setStream('error', 'device refused');
    render(<LiveView onBack={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps the layout name, Done and Retry together while editing offline', () => {
    setStream('error', 'device refused');
    render(<LiveView onBack={() => {}} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Layout name')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Widget' })).toBeTruthy();
  });

  it('offers Network Settings from the idle notice', () => {
    setStream('idle');
    const onOpenSettings = vi.fn();
    render(<LiveView onBack={() => {}} onOpenSettings={onOpenSettings} />);
    expect(screen.getByText(/You can still edit this layout\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Network Settings…' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('lists Export to File in the layout actions menu', () => {
    setStream('idle');
    render(<LiveView onBack={() => {}} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'More layout actions' }));
    expect(screen.getByRole('menuitem', { name: 'Export to File' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Pin Layout' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('adds the Local Network hint to the error banner on macOS only', () => {
    setStream('error', 'device refused');
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const { unmount } = render(<LiveView onBack={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByText(/Local Network for QuickScope/)).toBeTruthy();
    unmount();
    vi.stubGlobal('navigator', { platform: 'Win32' });
    render(<LiveView onBack={() => {}} onOpenSettings={() => {}} />);
    expect(screen.queryByText(/Local Network for QuickScope/)).toBeNull();
  });

  it('puts Received N in the status title', () => {
    setStream('streaming');
    (stream.value as { totalReceived: number }).totalReceived = 7;
    render(<LiveView onBack={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByTitle('Received 7')).toBeTruthy();
  });
});
