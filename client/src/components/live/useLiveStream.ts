import { useCallback, useEffect, useRef, useState } from 'react';
import {
  liveWebSocketUrl,
  type LiveDeviceInfo,
  type LiveSnapshotMessage,
  type LiveWSMessage,
  type AimStatus,
} from '../../lib/api';
import { type Snapshot } from './live-channels';

export type Status = 'idle' | 'connecting' | 'streaming' | 'paused' | 'error';

// Backoff for re-opening the WebSocket after it drops mid-stream (WiFi switch,
// backend restart): 1 s, 2 s, 4 s ... capped.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

function aimStatusToLiveDevice(device: NonNullable<AimStatus['device']>): LiveDeviceInfo {
  return {
    ip: device.ip,
    model: device.model ?? '',
    serial: device.serial ?? '',
    vehicle: device.vehicle ?? device.device_name ?? '',
  };
}

/** Close the live WS; `send('stop')` only when OPEN (throws while CONNECTING). */
function closeLiveWebSocket(ws: WebSocket | null | undefined) {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send('stop');
  }
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
}

/** WebSocket connection and stream controls for the live view. */
export function useLiveStream(aimDevice: AimStatus['device'] = null) {
  const [status, setStatus] = useState<Status>('idle');
  const [device, setDevice] = useState<LiveDeviceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [totalReceived, setTotalReceived] = useState(0);
  /** Wall-clock ms of the last snapshot (for "last values · Ns ago" while offline). */
  const [receivedAt, setReceivedAt] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pausedRef = useRef(false);
  // True while re-opening a socket that dropped after streaming had started.
  const retryingRef = useRef(false);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The backend only sends units when they change, so carry the last set onto every snapshot.
  const unitsRef = useRef<Record<string, string>>({});

  const cancelRetry = () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryingRef.current = false;
    retryAttemptRef.current = 0;
  };

  const openSocket = useCallback(() => {
    if (wsRef.current) return;
    // An automatic re-open after a drop keeps the status, error and count
    // as they are; only a fresh connect starts them over.
    if (!retryingRef.current) {
      setStatus('connecting');
      setError(null);
      setTotalReceived(0);
    }
    const ws = new WebSocket(liveWebSocketUrl());
    wsRef.current = ws;
    let streamed = false;

    // Applies one logical message. `batch` (sent when the WS sender fell
    // behind the device pump) unpacks into a call of this per snapshot.
    const applySnapshot = (msg: LiveSnapshotMessage) => {
      if (msg.units) unitsRef.current = msg.units;
      if (pausedRef.current) return;
      const snap: Snapshot = {
        ts: msg.ts,
        subsystem: msg.subsystem,
        raw: msg.raw ?? '',
        channels: msg.channels,
        units: unitsRef.current,
      };
      setLatest(snap);
      setReceivedAt(Date.now());
      setTotalReceived((n) => n + 1);
    };

    const applyMessage = (msg: LiveWSMessage) => {
      if (msg.type === 'connected') {
        streamed = true;
        retryingRef.current = false;
        retryAttemptRef.current = 0;
        setReconnecting(false);
        setDevice(msg.device);
        setStatus(pausedRef.current ? 'paused' : 'streaming');
      } else if (msg.type === 'snapshot') {
        applySnapshot(msg);
      } else if (msg.type === 'batch') {
        for (const inner of msg.messages) applyMessage(inner);
      } else if (msg.type === 'status') {
        // Keep the last values on screen through a device drop; only flag it.
        setReconnecting(msg.state === 'reconnecting');
      } else if (msg.type === 'error') {
        // The backend explains why it stopped (device unreachable, already in
        // use, ...): show it and let the user retry rather than looping.
        retryingRef.current = false;
        setReconnecting(false);
        setStatus('error');
        setError(msg.message);
        closeLiveWebSocket(wsRef.current);
        wsRef.current = null;
      }
      // 'heartbeat' needs no handling: it only proves the WS is alive.
    };

    ws.onmessage = (event) => {
      try {
        applyMessage(JSON.parse(event.data) as LiveWSMessage);
      } catch {
        // ignore non-JSON
      }
    };

    ws.onerror = () => {
      // While re-opening a dropped stream a failed attempt just schedules the
      // next one (onclose follows); the error only shows on a fresh connect.
      if (retryingRef.current || streamed) return;
      setStatus('error');
      setError('WebSocket connection failed');
    };

    ws.onclose = () => {
      // Every close we ask for (disconnect, unmount, server error frame)
      // detaches the socket first, so a close from a socket that is no longer
      // current is expected -- and may land after a newer socket has opened.
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      if (streamed || retryingRef.current) {
        // Dropped mid-stream: keep the last values on screen, flag it, and
        // re-open with backoff.
        retryingRef.current = true;
        setReconnecting(true);
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** retryAttemptRef.current);
        retryAttemptRef.current += 1;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          openSocket();
        }, delay);
        return;
      }
      setReconnecting(false);
      setStatus(prev => (prev === 'error' ? 'error' : 'idle'));
    };
  }, []);

  const closeIntentionally = () => {
    cancelRetry();
    closeLiveWebSocket(wsRef.current);
    wsRef.current = null;
  };

  const connect = useCallback(() => {
    cancelRetry();
    openSocket();
  }, [openSocket]);

  const deviceKey = aimDevice ? `${aimDevice.ip}:${aimDevice.serial ?? ''}` : null;

  useEffect(() => {
    if (aimDevice) {
      setDevice(aimStatusToLiveDevice(aimDevice));
    }
    setStatus('connecting');
    connect();
    return closeIntentionally;
  }, [deviceKey, connect]);

  // Keeps `latest` so the dashboard can show the last values (dimmed) after
  // a disconnect; the next connect starts the counters over.
  const disconnect = () => {
    closeIntentionally();
    setReconnecting(false);
    pausedRef.current = false;
    setStatus('idle');
  };

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setStatus(pausedRef.current ? 'paused' : 'streaming');
  };

  return {
    status, device, error, reconnecting, latest, totalReceived, receivedAt,
    connect, disconnect, togglePause,
  };
}
