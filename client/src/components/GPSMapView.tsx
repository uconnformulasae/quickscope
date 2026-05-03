import { useEffect, useRef, useState, useCallback } from 'react';
import { MapPin, Loader2, Pencil, Check, Trash2, X } from 'lucide-react';
import { fetchGPS, getSetpoints, updateSetpoints } from '../lib/api';
import type { GPSData, LapSetpoint } from '../lib/api';

// Leaflet types loaded from CDN
declare const L: any;

interface GPSMapViewProps {
  cursorTime?: number | null; // seconds
  sessionId?: string | null;
  onSetpointsChanged?: () => void;
}

const DEFAULT_RADIUS_M = 15;
const RADIUS_MIN_M = 5;
const RADIUS_MAX_M = 50;

const SECTOR_COLORS = ['#4361ee', '#8b5cf6', '#06b6d4', '#84cc16', '#fb923c', '#f43f5e', '#a855f7', '#22d3ee'];

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const phi1 = (a[0] * Math.PI) / 180;
  const phi2 = (b[0] * Math.PI) / 180;
  const dphi = ((b[0] - a[0]) * Math.PI) / 180;
  const dlmb = ((b[1] - a[1]) * Math.PI) / 180;
  const x = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlmb / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function snapToTrack(click: [number, number], coords: [number, number][]): [number, number] {
  if (coords.length === 0) return click;
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineMeters(click, coords[i]);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return coords[bestI];
}

export function GPSMapView({ cursorTime, sessionId, onSetpointsChanged }: GPSMapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const [gpsData, setGpsData] = useState<GPSData | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Setpoint editing state
  const [setpoints, setSetpoints] = useState<LapSetpoint[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [savedSetpoints, setSavedSetpoints] = useState<LapSetpoint[]>([]);
  const [saving, setSaving] = useState(false);

  // Refs for the setpoint Leaflet layers (markers + circles) so we can clear and redraw.
  const setpointLayersRef = useRef<any[]>([]);
  // Cached track coordinates for snap-to-track and click handler.
  const trackCoordsRef = useRef<[number, number][]>([]);
  // Stable click handler ref so the Leaflet 'click' subscription can read fresh values.
  const editStateRef = useRef<{ editMode: boolean; setpoints: LapSetpoint[] }>({ editMode: false, setpoints: [] });
  editStateRef.current = { editMode, setpoints };

  // Fetch GPS data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchGPS()
      .then(data => {
        if (!cancelled) {
          setGpsData(data);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err.message || 'Failed to fetch GPS data');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, []);

  // Fetch existing setpoints for this session
  useEffect(() => {
    if (!sessionId) {
      setSetpoints([]);
      setSavedSetpoints([]);
      return;
    }
    let cancelled = false;
    getSetpoints(sessionId)
      .then(sps => {
        if (cancelled) return;
        setSetpoints(sps);
        setSavedSetpoints(sps);
      })
      .catch(() => { /* non-fatal — leave empty */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Load Leaflet CSS + JS from CDN
  useEffect(() => {
    if (typeof L !== 'undefined') return; // Already loaded

    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }

    if (!document.querySelector('script[src*="leaflet"]')) {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      document.head.appendChild(script);
    }
  }, []);

  // Initialize map when data is ready
  useEffect(() => {
    if (!gpsData || !mapContainerRef.current) return;

    const waitForLeaflet = () => {
      if (typeof L === 'undefined') {
        setTimeout(waitForLeaflet, 100);
        return;
      }

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      const { lat, lon, speed, timestamps } = gpsData;
      if (lat.length === 0) return;

      const coords: [number, number][] = [];
      const speeds: number[] = [];
      const filteredTimes: number[] = [];
      for (let i = 0; i < lat.length; i++) {
        if (lat[i] !== 0 && lon[i] !== 0 && Math.abs(lat[i]) < 90 && Math.abs(lon[i]) < 180) {
          coords.push([lat[i], lon[i]]);
          speeds.push(speed ? speed[i] ?? 0 : 0);
          filteredTimes.push(timestamps[i] ?? 0);
        }
      }

      if (coords.length < 2) return;
      trackCoordsRef.current = coords;

      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
        attributionControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);

      const maxSpeed = Math.max(...speeds, 1);
      const getColor = (spd: number): string => {
        const ratio = Math.min(spd / maxSpeed, 1);
        if (ratio < 0.5) {
          const r = Math.round(255 * ratio * 2);
          return `rgb(${r}, 200, 50)`;
        }
        const g = Math.round(200 * (1 - (ratio - 0.5) * 2));
        return `rgb(255, ${g}, 50)`;
      };

      const segmentSize = Math.max(1, Math.floor(coords.length / 500));
      for (let i = 0; i < coords.length - segmentSize; i += segmentSize) {
        const end = Math.min(i + segmentSize + 1, coords.length);
        const segment = coords.slice(i, end);
        const avgSpeed = speeds.slice(i, end).reduce((a, b) => a + b, 0) / (end - i);
        L.polyline(segment, {
          color: getColor(avgSpeed),
          weight: 3,
          opacity: 0.8,
        }).addTo(map);
      }

      const bounds = L.latLngBounds(coords);
      map.fitBounds(bounds, { padding: [20, 20] });

      const marker = L.circleMarker(coords[0], {
        radius: 6,
        fillColor: '#ffffff',
        fillOpacity: 1,
        color: '#4361ee',
        weight: 2,
      }).addTo(map);

      // Click-to-add-pin handler. Reads edit state from a ref so we can
      // subscribe once without re-subscribing on every re-render.
      map.on('click', (e: any) => {
        const { editMode: em, setpoints: sps } = editStateRef.current;
        if (!em) return;
        const click: [number, number] = [e.latlng.lat, e.latlng.lng];
        const snapped = snapToTrack(click, trackCoordsRef.current);
        const newPin: LapSetpoint = { lat: snapped[0], lon: snapped[1], radius_m: DEFAULT_RADIUS_M };
        setSetpoints([...sps, newPin]);
      });

      mapRef.current = map;
      markerRef.current = marker;

      (mapRef.current as any)._gpsCoords = coords;
      (mapRef.current as any)._gpsTimes = filteredTimes;
    };

    waitForLeaflet();

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      setpointLayersRef.current = [];
    };
  }, [gpsData]);

  // Update cursor position on map
  useEffect(() => {
    if (!mapRef.current || !markerRef.current || cursorTime == null) return;

    const coords: [number, number][] = (mapRef.current as any)._gpsCoords;
    const times: number[] = (mapRef.current as any)._gpsTimes;
    if (!coords || !times || coords.length === 0) return;

    const tMs = cursorTime * 1000;

    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < tMs) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(times[lo - 1] - tMs) < Math.abs(times[lo] - tMs)) {
      lo = lo - 1;
    }

    const idx = Math.min(lo, coords.length - 1);
    markerRef.current.setLatLng(coords[idx]);
  }, [cursorTime]);

  // Render setpoint markers and radius circles. Re-runs when setpoints
  // or editMode change, redrawing only the setpoint layers (not the map).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || typeof L === 'undefined') return;

    // Clear existing layers
    for (const layer of setpointLayersRef.current) {
      map.removeLayer(layer);
    }
    setpointLayersRef.current = [];

    setpoints.forEach((sp, idx) => {
      const isStartFinish = idx === 0;
      const color = isStartFinish ? '#10b981' : SECTOR_COLORS[(idx - 1) % SECTOR_COLORS.length];
      const labelHtml = isStartFinish
        ? '<div style="background:' + color + ';color:white;border-radius:9999px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4)">SF</div>'
        : '<div style="background:' + color + ';color:white;border-radius:9999px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4)">' + idx + '</div>';
      const icon = L.divIcon({
        className: 'setpoint-icon',
        html: labelHtml,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const marker = L.marker([sp.lat, sp.lon], {
        icon,
        draggable: editMode,
      }).addTo(map);

      if (editMode) {
        marker.on('dragend', (e: any) => {
          const ll = e.target.getLatLng();
          const snapped = snapToTrack([ll.lat, ll.lng], trackCoordsRef.current);
          setSetpoints(prev => prev.map((p, i) => i === idx ? { ...p, lat: snapped[0], lon: snapped[1] } : p));
        });
      }

      const circle = L.circle([sp.lat, sp.lon], {
        radius: sp.radius_m,
        color,
        fillColor: color,
        fillOpacity: 0.1,
        weight: 1.5,
      }).addTo(map);

      setpointLayersRef.current.push(marker, circle);
    });
  }, [setpoints, editMode]);

  const dirty =
    setpoints.length !== savedSetpoints.length ||
    setpoints.some((p, i) => {
      const s = savedSetpoints[i];
      return !s || p.lat !== s.lat || p.lon !== s.lon || p.radius_m !== s.radius_m;
    });

  const handleToggleEdit = useCallback(async () => {
    if (!editMode) {
      setEditMode(true);
      return;
    }
    // Exiting edit mode → save if dirty.
    if (sessionId && dirty) {
      setSaving(true);
      try {
        await updateSetpoints(sessionId, setpoints);
        setSavedSetpoints(setpoints);
        if (onSetpointsChanged) onSetpointsChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    }
    setEditMode(false);
  }, [editMode, sessionId, dirty, setpoints, onSetpointsChanged]);

  const handleCancelEdit = useCallback(() => {
    setSetpoints(savedSetpoints);
    setEditMode(false);
  }, [savedSetpoints]);

  const handleClearAll = useCallback(() => {
    setSetpoints([]);
  }, []);

  const handleDeletePin = useCallback((idx: number) => {
    setSetpoints(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const handleRadiusChange = useCallback((idx: number, radius_m: number) => {
    const clamped = Math.max(RADIUS_MIN_M, Math.min(RADIUS_MAX_M, radius_m));
    setSetpoints(prev => prev.map((p, i) => i === idx ? { ...p, radius_m: clamped } : p));
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
        <Loader2 className="w-5 h-5 text-primary animate-spin" />
        <p className="text-xs text-muted-foreground">Loading GPS data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
        <MapPin className="w-5 h-5 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!gpsData) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
          <MapPin className="w-5 h-5 text-primary/60" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground mb-1">No GPS Data</p>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-[220px]">
            This session does not contain GPS coordinate channels (latitude/longitude).
          </p>
        </div>
      </div>
    );
  }

  const canEdit = !!sessionId;

  return (
    <div className="flex flex-col h-full relative">
      <div
        ref={mapContainerRef}
        className="flex-1 min-h-0"
        style={{ minHeight: '200px' }}
        data-testid="gps-map"
      />

      {canEdit && (
        <div className="absolute top-2 right-2 z-[1000] flex flex-col gap-1.5">
          <button
            type="button"
            onClick={handleToggleEdit}
            disabled={saving}
            className={`px-2.5 py-1.5 rounded-md text-xs font-medium border shadow-md transition-colors flex items-center gap-1.5 ${
              editMode
                ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90'
                : 'bg-card text-foreground border-border hover:bg-muted'
            } disabled:opacity-50`}
            title={editMode ? 'Save and exit edit mode' : 'Edit lap setpoints'}
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : editMode ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
            {editMode ? 'Done' : 'Edit setpoints'}
          </button>
          {editMode && dirty && (
            <button
              type="button"
              onClick={handleCancelEdit}
              disabled={saving}
              className="px-2.5 py-1.5 rounded-md text-xs font-medium border shadow-md bg-card text-foreground border-border hover:bg-muted disabled:opacity-50 flex items-center gap-1.5"
              title="Discard changes"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          )}
        </div>
      )}

      {editMode && setpoints.length === 0 && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[1000] bg-card/95 border border-border rounded-md px-3 py-1.5 shadow-md">
          <p className="text-xs text-foreground">Click the track to place start/finish</p>
        </div>
      )}

      {editMode && setpoints.length > 0 && (
        <div className="absolute top-2 left-2 z-[1000] w-56 max-h-[calc(100%-1rem)] overflow-y-auto bg-card/95 border border-border rounded-md shadow-md">
          <div className="p-2 border-b border-border">
            <p className="text-xs font-semibold text-foreground">Lap Setpoints</p>
            <p className="text-[10px] text-muted-foreground">First pin = start/finish; rest are sectors in click order.</p>
          </div>
          <ul className="p-1 space-y-1">
            {setpoints.map((sp, idx) => {
              const isSF = idx === 0;
              const color = isSF ? '#10b981' : SECTOR_COLORS[(idx - 1) % SECTOR_COLORS.length];
              return (
                <li key={idx} className="rounded p-1.5 border border-border/60 bg-background/50">
                  <div className="flex items-center justify-between mb-1 gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="rounded-full text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center flex-shrink-0"
                        style={{ background: color }}
                      >
                        {isSF ? 'SF' : idx}
                      </span>
                      <span className="text-xs font-medium text-foreground truncate">
                        {isSF ? 'Start/Finish' : `Sector ${idx}`}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeletePin(idx)}
                      className="text-muted-foreground hover:text-red-500 transition-colors"
                      title="Delete pin"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground tabular leading-tight">
                    {sp.lat.toFixed(5)}, {sp.lon.toFixed(5)}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <input
                      type="range"
                      min={RADIUS_MIN_M}
                      max={RADIUS_MAX_M}
                      step={1}
                      value={sp.radius_m}
                      onChange={e => handleRadiusChange(idx, parseFloat(e.target.value))}
                      className="flex-1 h-1 accent-primary"
                    />
                    <span className="text-[10px] tabular text-foreground w-9 text-right">{sp.radius_m.toFixed(0)} m</span>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="p-1.5 border-t border-border">
            <button
              type="button"
              onClick={handleClearAll}
              className="w-full text-xs text-red-500 hover:bg-red-500/10 rounded px-2 py-1 transition-colors"
            >
              Clear all setpoints
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
