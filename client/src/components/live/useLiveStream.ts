import { useCallback, useEffect, useRef, useState } from 'react';
import {
  liveWebSocketUrl,
  type LiveDeviceInfo,
  type LiveSnapshotMessage,
  type LiveWSMessage,
  type AimStatus,
} from '../../lib/api';
import { type Snapshot } from './live-channels';
import { downloadGpx } from './live-gpx';

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

/** WebSocket connection, GPS trail and stream controls for the live view. */
export function useLiveStream(aimDevice: AimStatus['device'] = null) {
  const [status, setStatus] = useState<Status>('idle');
  const [device, setDevice] = useState<LiveDeviceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [totalReceived, setTotalReceived] = useState(0);
  const [gpsTrail, setGpsTrail] = useState<{ lat: number; lon: number; speed: number }[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const gpsTrailRef = useRef<{ lat: number; lon: number; speed: number }[]>([]);
  const snapshotTickRef = useRef(0);
  const pausedRef = useRef(false);

  const connect = useCallback(() => {
    if (wsRef.current) return;
    setStatus('connecting');
    setError(null);
    const ws = new WebSocket(liveWebSocketUrl());
    wsRef.current = ws;

    // Applies one logical message. `batch` (sent when the WS sender fell
    // behind the device pump) unpacks into a call of this per snapshot, so
    // the GPS trail updates exactly as if each had arrived on its own --
    // only the wire framing changed.
    const applySnapshot = (msg: LiveSnapshotMessage) => {
      if (pausedRef.current) return;
      const snap: Snapshot = {
        ts: msg.ts,
        subsystem: msg.subsystem,
        raw: msg.raw ?? '',
        channels: msg.channels,
      };
      const lat = snap.channels?.['GPS_Lat'];
      const lon = snap.channels?.['GPS_Lon'];
      if (lat !== undefined && lon !== undefined && Math.abs(lat) > 0.1 && Math.abs(lon) > 0.1) {
        gpsTrailRef.current.push({ lat, lon, speed: snap.channels?.['GPS_Speed'] ?? 0 });
        if (gpsTrailRef.current.length > 2000) {
          gpsTrailRef.current.shift();
        }
      }
      setLatest(snap);
      setTotalReceived((n) => n + 1);
      snapshotTickRef.current += 1;
      if (snapshotTickRef.current % 8 === 0) {
        setGpsTrail([...gpsTrailRef.current]);
      }
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
  }, [aimDevice, connect]);

  const disconnect = () => {
    closeLiveWebSocket(wsRef.current);
    wsRef.current = null;
    gpsTrailRef.current = [];
    snapshotTickRef.current = 0;
    setTotalReceived(0);
    setLatest(null);
    setGpsTrail([]);
    setStatus('idle');
  };

  const exportGpx = () => downloadGpx(gpsTrailRef.current);

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setStatus(pausedRef.current ? 'paused' : 'streaming');
  };

  return {
    status, device, error, reconnecting, latest, totalReceived, gpsTrail,
    connect, disconnect, togglePause, exportGpx,
  };
}
