import { useEffect, useRef, useState, useMemo } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { fetchGPS } from '../lib/api';
import type { GPSData } from '../lib/api';

// Leaflet types loaded from CDN
declare const L: any;

interface GPSMapViewProps {
  cursorTime?: number | null; // seconds
}

export function GPSMapView({ cursorTime }: GPSMapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const [gpsData, setGpsData] = useState<GPSData | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Load Leaflet CSS + JS from CDN
  useEffect(() => {
    if (typeof L !== 'undefined') return; // Already loaded

    // CSS
    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }

    // JS
    if (!document.querySelector('script[src*="leaflet"]')) {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      document.head.appendChild(script);
    }
  }, []);

  // Initialize map when data is ready
  useEffect(() => {
    if (!gpsData || !mapContainerRef.current) return;

    // Wait for Leaflet to load
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

      // Filter out zero/invalid coordinates
      const coords: [number, number][] = [];
      const speeds: number[] = [];
      for (let i = 0; i < lat.length; i++) {
        if (lat[i] !== 0 && lon[i] !== 0 && Math.abs(lat[i]) < 90 && Math.abs(lon[i]) < 180) {
          coords.push([lat[i], lon[i]]);
          speeds.push(speed ? speed[i] ?? 0 : 0);
        }
      }

      if (coords.length < 2) return;

      // Create map
      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
        attributionControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);

      // Speed color scale
      const maxSpeed = Math.max(...speeds, 1);
      const getColor = (spd: number): string => {
        const ratio = Math.min(spd / maxSpeed, 1);
        // Green (slow) → Yellow → Red (fast)
        if (ratio < 0.5) {
          const r = Math.round(255 * ratio * 2);
          return `rgb(${r}, 200, 50)`;
        }
        const g = Math.round(200 * (1 - (ratio - 0.5) * 2));
        return `rgb(255, ${g}, 50)`;
      };

      // Draw polyline segments color-coded by speed
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

      // Fit bounds
      const bounds = L.latLngBounds(coords);
      map.fitBounds(bounds, { padding: [20, 20] });

      // Cursor position marker
      const marker = L.circleMarker(coords[0], {
        radius: 6,
        fillColor: '#ffffff',
        fillOpacity: 1,
        color: '#4361ee',
        weight: 2,
      }).addTo(map);

      mapRef.current = map;
      markerRef.current = marker;

      // Store coords for cursor updates
      (mapRef.current as any)._gpsCoords = coords;
      (mapRef.current as any)._gpsTimes = timestamps;
    };

    waitForLeaflet();

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [gpsData]);

  // Update cursor position on map
  useEffect(() => {
    if (!mapRef.current || !markerRef.current || cursorTime == null) return;

    const coords: [number, number][] = (mapRef.current as any)._gpsCoords;
    const times: number[] = (mapRef.current as any)._gpsTimes;
    if (!coords || !times || coords.length === 0) return;

    const tMs = cursorTime * 1000;

    // Binary search for nearest timestamp
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

  return (
    <div className="flex flex-col h-full">
      <div
        ref={mapContainerRef}
        className="flex-1 min-h-0"
        style={{ minHeight: '200px' }}
        data-testid="gps-map"
      />
    </div>
  );
}
