import { useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { fetchGPS } from '../lib/api';
import type { GPSData } from '../lib/api';
// Bundled rather than loaded from a CDN so the track map works trackside with
// no internet (only the background tiles need a connection).
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { usePreferences } from '../lib/usePreferences';
import { getConverter, resolveDisplayUnit } from '../lib/units';
import { gradientStops, sampleGradient, speedToT } from '../lib/gradients';
import type { LapMarker } from '../lib/xrk-parser';
import { buildLapWindows, lapColor, segmentInLaps, selectedWindows, toSessionMs } from '../lib/lap-compare';

/** Min/max without spreading — large GPS traces exceed the argument stack limit. */
function rangeOf(values: number[]): [number, number] {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? [min, max] : [0, 0];
}

const NO_SPEED_COLOR = '#4361ee';

interface TrackData {
  coords: [number, number][];
  times: number[];
  speeds: number[] | null; // raw units
}

interface GPSMapViewProps {
  cursorTime?: number | null; // seconds (lap-relative in lap compare mode)
  lapMarkers?: LapMarker[];
  selectedLaps?: number[];
}

/** Nearest track index to time tMs (times sorted). */
function nearestIndex(times: number[], tMs: number): number {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < tMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - tMs) < Math.abs(times[lo] - tMs)) lo = lo - 1;
  return lo;
}

const NO_LAPS: LapMarker[] = [];
const NO_SELECTION: number[] = [];

export function GPSMapView({ cursorTime, lapMarkers = NO_LAPS, selectedLaps = NO_SELECTION }: GPSMapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const trailRef = useRef<L.LayerGroup | null>(null);
  // Filtered track points and their times, for placing the cursor marker
  const trackRef = useRef<TrackData | null>(null);
  const [track, setTrack] = useState<TrackData | null>(null);
  const { prefs } = usePreferences();
  const lapMarkersRef = useRef<L.CircleMarker[]>([]);
  const lapSel = useMemo(
    () => selectedWindows(buildLapWindows(lapMarkers), selectedLaps),
    [lapMarkers, selectedLaps],
  );
  const comparing = lapSel.length >= 2;
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

  // Initialize map when data is ready
  useEffect(() => {
    if (!gpsData || !mapContainerRef.current) return;

    const container = mapContainerRef.current;
    const buildMap = () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      const { lat, lon, speed, timestamps } = gpsData;
      if (lat.length === 0) return;

      // Filter out zero/invalid coordinates, keeping timestamps in sync
      const coords: [number, number][] = [];
      const speeds: number[] = [];
      const filteredTimes: number[] = [];
      for (let i = 0; i < lat.length; i++) {
        if (lat[i] !== 0 && lon[i] !== 0 && Math.abs(lat[i]) < 90 && Math.abs(lon[i]) < 180) {
          coords.push([lat[i], lon[i]]);
          speeds.push(speed ? speed[i] ?? 0 : NaN);
          filteredTimes.push(timestamps[i] ?? 0);
        }
      }

      if (coords.length < 2) return;

      // Create map
      const map = L.map(container, {
        zoomControl: true,
        attributionControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);

      const trail = L.layerGroup().addTo(map);

      // Fit bounds
      const bounds = L.latLngBounds(coords);
      map.fitBounds(bounds, { padding: [20, 20] });
      // Tab panel may mount before layout settles; tiles stay blank without this.
      requestAnimationFrame(() => {
        map.invalidateSize();
        map.fitBounds(bounds, { padding: [20, 20] });
      });

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
      trailRef.current = trail;
      const t: TrackData = { coords, times: filteredTimes, speeds: speed ? speeds : null };
      trackRef.current = t;
      setTrack(t);
    };

    buildMap();

    return () => {
      trackRef.current = null;
      markerRef.current = null;
      trailRef.current = null;
      setTrack(null);
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [gpsData]);

  // Speed-coloured trail. Rebuilt when colours/units change without
  // re-creating the map (keeps the user's zoom and pan).
  const speedUnits = gpsData?.speedUnits ?? '';
  const legend = useMemo(() => {
    if (!track?.speeds) return null;
    const target = resolveDisplayUnit('GPS Speed', speedUnits, prefs);
    const conv = getConverter(speedUnits, target);
    const speeds = conv.identity ? track.speeds : track.speeds.map(conv.fn);
    const g = prefs.gpsGradient;
    const [lo, hi] = g.rangeMode === 'fixed' ? [g.fixedMin, g.fixedMax] : rangeOf(speeds);
    return { speeds, lo, hi, unit: conv.unit, stops: gradientStops(g) };
  }, [track, speedUnits, prefs]);

  useEffect(() => {
    const trail = trailRef.current;
    if (!trail || !track) return;
    trail.clearLayers();
    const { coords } = track;
    const stride = Math.max(3, Math.ceil(coords.length / 3000));
    for (let i = 0; i < coords.length - 1; i += stride) {
      const end = Math.min(i + stride + 1, coords.length);
      let color = NO_SPEED_COLOR;
      if (legend) {
        let sum = 0, n = 0;
        for (let k = i; k < end; k++) {
          const v = legend.speeds[k];
          if (Number.isFinite(v)) { sum += v; n++; }
        }
        if (n > 0) color = sampleGradient(legend.stops, speedToT(sum / n, legend.lo, legend.hi));
      }
      // Selected laps stay bright; the rest of the session fades back.
      const midT = track.times[(i + end - 1) >> 1];
      const opacity = segmentInLaps(midT, lapSel) ? 0.9 : 0.2;
      L.polyline(coords.slice(i, end), { color, weight: 3, opacity }).addTo(trail);
    }
  }, [track, legend, lapSel]);

  // Update cursor position on map. In lap compare mode the cursor time is
  // lap-relative: show one marker per compared lap (in its lap colour).
  useEffect(() => {
    const map = mapRef.current;
    const track = trackRef.current;
    for (const m of lapMarkersRef.current) m.remove();
    lapMarkersRef.current = [];
    if (!map || !markerRef.current || !track || track.coords.length === 0) return;
    const { coords, times } = track;

    if (comparing) {
      markerRef.current.setStyle({ opacity: 0, fillOpacity: 0 });
      if (cursorTime == null) return;
      lapMarkersRef.current = lapSel.map((lap, i) => L.circleMarker(
        coords[Math.min(nearestIndex(times, toSessionMs(cursorTime, lap)), coords.length - 1)],
        { radius: 6, fillColor: lapColor(i), fillOpacity: 1, color: '#ffffff', weight: 2 },
      ).addTo(map));
      return;
    }

    markerRef.current.setStyle({ opacity: 1, fillOpacity: 1 });
    if (cursorTime == null) return;
    markerRef.current.setLatLng(coords[Math.min(nearestIndex(times, cursorTime * 1000), coords.length - 1)]);
  }, [cursorTime, comparing, lapSel, track]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
        <Loader2 className="w-5 h-5 text-primary-text animate-spin" />
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
          <MapPin className="w-5 h-5 text-primary-text/60" />
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
    <div className="flex flex-col h-full relative">
      <div
        ref={mapContainerRef}
        className="flex-1 min-h-0"
        style={{ minHeight: '200px' }}
        data-testid="gps-map"
      />
      {track && (
        <div
          className="absolute bottom-6 left-2 z-[400] rounded-md border border-border bg-card/90 px-2 py-1.5 text-xs shadow-sm pointer-events-none"
          data-testid="gps-speed-legend"
        >
          {legend ? (
            <>
              <div
                className="h-2 w-28 rounded-sm"
                style={{ background: `linear-gradient(to right, ${legend.stops.join(', ')})` }}
              />
              <div className="mt-0.5 tabular text-muted-foreground">
                {legend.lo.toFixed(0)} – {legend.hi.toFixed(0)}{legend.unit ? ` ${legend.unit}` : ''}
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">No speed data</span>
          )}
        </div>
      )}
    </div>
  );
}
