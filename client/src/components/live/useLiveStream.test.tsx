// @vitest-environment jsdom
import '../../test/dom-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLiveStream } from './useLiveStream';

/** Scriptable stand-in for the browser WebSocket. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  // Like the browser, closing only queues the close event; tests fire it.
  close() { this.readyState = FakeSocket.CLOSING; }

  open() { this.readyState = FakeSocket.OPEN; }
  message(msg: object) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  fireClose() { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
  fail() { this.onerror?.(); this.fireClose(); }
}

const device = { ip: '10.0.0.1', model: 'EVO5', serial: '1', vehicle: 'CT' };
const latestSocket = () => FakeSocket.all[FakeSocket.all.length - 1];

function streaming() {
  const hook = renderHook(() => useLiveStream());
  const ws = latestSocket();
  act(() => {
    ws.open();
    ws.message({ type: 'connected', device });
    ws.message({ type: 'snapshot', ts: 1, subsystem: 'Syst', channels: { RPM: 1000 } });
  });
  return { hook, ws };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveStream', () => {
  it('reports a failed first connect instead of retrying', () => {
    const { result } = renderHook(() => useLiveStream());
    act(() => latestSocket().fail());
    expect(result.current.status).toBe('error');
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('reopens a socket that drops mid-stream, keeping the last values', () => {
    const { hook, ws } = streaming();
    act(() => ws.fireClose());
    expect(hook.result.current.reconnecting).toBe(true);
    expect(hook.result.current.latest?.channels?.RPM).toBe(1000);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeSocket.all).toHaveLength(2);
    act(() => {
      latestSocket().open();
      latestSocket().message({ type: 'connected', device });
    });
    expect(hook.result.current.status).toBe('streaming');
    expect(hook.result.current.reconnecting).toBe(false);
    // An automatic re-open is not a fresh connect: the count carries on.
    expect(hook.result.current.totalReceived).toBe(1);
  });

  it('backs off between failed reconnect attempts', () => {
    const { ws } = streaming();
    act(() => ws.fireClose());
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => latestSocket().fail());
    act(() => { vi.advanceTimersByTime(1999); });
    expect(FakeSocket.all).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('does not reconnect after the backend sends an error frame', () => {
    const { hook, ws } = streaming();
    act(() => {
      ws.message({ type: 'error', message: 'Live view is already open in another window.' });
      ws.fireClose();
    });
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(FakeSocket.all).toHaveLength(1);
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toMatch(/already open/);
  });

  it('does not reconnect after the user disconnects', () => {
    const { hook, ws } = streaming();
    act(() => hook.result.current.disconnect());
    act(() => ws.fireClose());
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(FakeSocket.all).toHaveLength(1);
    expect(hook.result.current.status).toBe('idle');
    expect(hook.result.current.reconnecting).toBe(false);
  });

  it('ignores the old socket closing after disconnect + immediate connect', () => {
    const { hook, ws } = streaming();
    act(() => {
      hook.result.current.disconnect();
      hook.result.current.connect();
    });
    // The old socket's close event lands after the new socket opened.
    act(() => ws.fireClose());
    expect(hook.result.current.reconnecting).toBe(false);
    expect(hook.result.current.status).toBe('connecting');
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(FakeSocket.all).toHaveLength(2);
  });
});
