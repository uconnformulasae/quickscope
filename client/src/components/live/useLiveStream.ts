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
  // The backend only sends units when they change, so carry the last set onto every snapshot.
  const unitsRef = useRef<Record<string, string>>({});

  const connect = useCallback(() => {
    if (wsRef.current) return;
    setStatus('connecting');
    setError(null);
    setTotalReceived(0);
    const ws = new WebSocket(liveWebSocketUrl());
    wsRef.current = ws;

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
        setDevice(msg.device);
        setStatus('streaming');
      } else if (msg.type === 'snapshot') {
        applySnapshot(msg);
      } else if (msg.type === 'batch') {
        for (const inner of msg.messages) applyMessage(inner);
      } else if (msg.type === 'status') {
        // Keep the last values on screen through a device drop; only flag it.
        setReconnecting(msg.state === 'reconnecting');
      } else if (msg.type === 'error') {
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
      setStatus('error');
      setError('WebSocket connection failed');
    };

    ws.onclose = () => {
      wsRef.current = null;
      setReconnecting(false);
      setStatus(prev => (prev === 'error' ? 'error' : 'idle'));
    };
  }, []);

  const deviceKey = aimDevice ? `${aimDevice.ip}:${aimDevice.serial ?? ''}` : null;

  useEffect(() => {
    if (aimDevice) {
      setDevice(aimStatusToLiveDevice(aimDevice));
    }
    setStatus('connecting');
    connect();
    return () => {
      closeLiveWebSocket(wsRef.current);
      wsRef.current = null;
    };
  }, [deviceKey, connect]);

  // Keeps `latest` so the dashboard can show the last values (dimmed) after
  // a disconnect; the next connect starts the counters over.
  const disconnect = () => {
    closeLiveWebSocket(wsRef.current);
    wsRef.current = null;
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
