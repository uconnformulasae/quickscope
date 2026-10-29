// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveStream } from './useLiveStream';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // ── test helpers ──
  open() {
    this.readyState = FakeWebSocket.OPEN;
  }

  receive(msg: unknown) {
    act(() => this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }));
  }
}

const latestWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

const device = { ip: '10.0.0.1', model: 'EVO5', serial: '740', vehicle: 'CT16' };

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useLiveStream', () => {
  it('connects to the live endpoint on mount', () => {
    const { result } = renderHook(() => useLiveStream());
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latestWs().url).toMatch(/^ws:\/\/.*\/api\/live\/ws$/);
    expect(result.current.status).toBe('connecting');
  });

  it('prefills the device from the AiM status before the WS answers', () => {
    const { result } = renderHook(() =>
      useLiveStream({ ip: '10.0.0.9', ssid: 'AiM', device_name: 'Logger' }),
    );
    expect(result.current.device).toEqual({ ip: '10.0.0.9', model: '', serial: '', vehicle: 'Logger' });
  });

  it('switches to streaming on "connected" and records snapshots', () => {
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    ws.open();
    ws.receive({ type: 'connected', device });
    expect(result.current.status).toBe('streaming');
    expect(result.current.device).toEqual(device);

    ws.receive({ type: 'snapshot', ts: 5, subsystem: 'Syst', channels: { RPM: 1000 } });
    expect(result.current.latest).toEqual({ ts: 5, subsystem: 'Syst', raw: '', channels: { RPM: 1000 }, units: {} });
    expect(result.current.totalReceived).toBe(1);
  });

  it('applies every message in a batch in order', () => {
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    ws.receive({ type: 'connected', device });
    ws.receive({
      type: 'batch',
      messages: [
        { type: 'snapshot', ts: 1, subsystem: 'Syst', channels: { RPM: 1 } },
        { type: 'heartbeat' },
        { type: 'snapshot', ts: 2, subsystem: 'Syst', raw: 'AAAA', channels: { RPM: 2 } },
      ],
    });
    expect(result.current.totalReceived).toBe(2);
    expect(result.current.latest).toEqual({ ts: 2, subsystem: 'Syst', raw: 'AAAA', channels: { RPM: 2 }, units: {} });
  });

  it('carries the last units onto snapshots that arrive without them', () => {
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    ws.receive({ type: 'connected', device });
    ws.receive({ type: 'snapshot', ts: 1, subsystem: 'Syst', channels: { RPM: 1 }, units: { RPM: 'rpm' } });
    ws.receive({ type: 'snapshot', ts: 2, subsystem: 'Syst', channels: { RPM: 2 } });
    expect(result.current.latest?.units).toEqual({ RPM: 'rpm' });
  });

  it('flags device reconnects without clearing the last values', () => {
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    ws.receive({ type: 'connected', device });
    ws.receive({ type: 'snapshot', ts: 1, subsystem: 'Syst', channels: { RPM: 1 } });
    ws.receive({ type: 'status', state: 'reconnecting', attempt: 1 });
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.latest?.ts).toBe(1);

    ws.receive({ type: 'status', state: 'live', gap_ms: 900 });
    expect(result.current.reconnecting).toBe(false);
  });

  it('ignores non-JSON frames', () => {
    const { result } = renderHook(() => useLiveStream());
    latestWs().receive('not json');
    expect(result.current.status).toBe('connecting');
  });

  it('shows backend errors and closes the socket', () => {
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    ws.open();
    ws.receive({ type: 'error', message: 'device refused' });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('device refused');
    expect(ws.sent).toEqual(['stop']);
    expect(ws.closed).toBe(true);
  });

  it('reports a WebSocket transport error', () => {
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    act(() => ws.onerror?.());
    act(() => ws.onclose?.());
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('WebSocket connection failed');
  });

  it('returns to idle when the socket closes cleanly before the device connects', () => {
    // A close after 'connected' reconnects instead (see useLiveStream.test.tsx).
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    ws.receive({ type: 'status', state: 'reconnecting' });
    act(() => ws.onclose?.());
    expect(result.current.status).toBe('idle');
    expect(result.current.reconnecting).toBe(false);
  });

  it('drops snapshots while paused and resumes afterwards', () => {
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    ws.receive({ type: 'connected', device });
    act(() => result.current.togglePause());
    expect(result.current.status).toBe('paused');
    ws.receive({ type: 'snapshot', ts: 1, subsystem: 'Syst', channels: {} });
    expect(result.current.totalReceived).toBe(0);

    act(() => result.current.togglePause());
    expect(result.current.status).toBe('streaming');
    ws.receive({ type: 'snapshot', ts: 2, subsystem: 'Syst', channels: {} });
    expect(result.current.totalReceived).toBe(1);
  });

  it('disconnect sends stop and closes, keeping the last values until the next connect', () => {
    const { result } = renderHook(() => useLiveStream());
    const ws = latestWs();
    ws.open();
    ws.receive({ type: 'connected', device });
    ws.receive({ type: 'snapshot', ts: 1, subsystem: 'Syst', channels: {} });
    act(() => result.current.disconnect());
    expect(ws.sent).toEqual(['stop']);
    expect(ws.closed).toBe(true);
    // The dashboard shows the last values dimmed after a disconnect.
    expect(result.current).toMatchObject({ status: 'idle', totalReceived: 1 });
    expect(result.current.latest?.ts).toBe(1);

    act(() => result.current.connect());
    expect(result.current.totalReceived).toBe(0);
  });

  it('connect is a no-op while a socket is already open, and reconnects after disconnect', () => {
    const { result } = renderHook(() => useLiveStream());
    act(() => result.current.connect());
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => result.current.disconnect());
    act(() => result.current.connect());
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('closes a still-connecting socket on unmount without sending stop', () => {
    const { unmount } = renderHook(() => useLiveStream());
    const ws = latestWs();
    unmount();
    expect(ws.sent).toEqual([]);
    expect(ws.closed).toBe(true);
  });
});
