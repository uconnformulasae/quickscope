import { useEffect, useState } from 'react';
import { fetchGPSPreview, type GPSPreview } from '../lib/api';
import { MapPin } from 'lucide-react';

// Module-level cache so re-rendering the SessionBrowser (which happens on
// every status update from sync) doesn't re-fetch every thumbnail. Also
// shares state across multiple browser instances.
const cache = new Map<string, GPSPreview | null>();
const inflight = new Map<string, Promise<GPSPreview | null>>();

async function getPreview(sessionId: string): Promise<GPSPreview | null> {
  if (cache.has(sessionId)) return cache.get(sessionId) ?? null;
  const existing = inflight.get(sessionId);
  if (existing) return existing;
  const p = fetchGPSPreview(sessionId)
    .then(preview => {
      cache.set(sessionId, preview);
      inflight.delete(sessionId);
      return preview;
    })
    .catch(() => {
      cache.set(sessionId, null);
      inflight.delete(sessionId);
      return null;
    });
  inflight.set(sessionId, p);
  return p;
}

interface Props {
  sessionId: string;
  size?: number;
  className?: string;
}

export function GPSThumbnail({ sessionId, size = 32, className = '' }: Props) {
  const [preview, setPreview] = useState<GPSPreview | null | undefined>(
    cache.has(sessionId) ? cache.get(sessionId) : undefined,
  );

  useEffect(() => {
    if (cache.has(sessionId)) {
      setPreview(cache.get(sessionId) ?? null);
      return;
    }
    let alive = true;
    getPreview(sessionId).then(p => {
      if (alive) setPreview(p);
    });
    return () => { alive = false; };
  }, [sessionId]);

  if (preview === undefined) {
    // Loading — render a transparent box so layout doesn't shift when the
    // preview lands.
    return (
      <div
        className={`flex-shrink-0 rounded bg-muted/30 ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  if (!preview || preview.points.length < 2) {
    return (
      <div
        className={`flex-shrink-0 rounded bg-muted/30 flex items-center justify-center ${className}`}
        style={{ width: size, height: size }}
        title="No GPS data"
      >
        <MapPin className="w-3 h-3 text-muted-foreground/50" />
      </div>
    );
  }

  const path = preview.points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${(x * size).toFixed(1)} ${(y * size).toFixed(1)}`)
    .join(' ');

  // Mark the start point with a small dot for orientation
  const [sx, sy] = preview.points[0];

  return (
    <div
      className={`flex-shrink-0 rounded bg-muted/30 overflow-hidden ${className}`}
      style={{ width: size, height: size }}
      title={`GPS track (${preview.pointCount} points)`}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-primary"
        />
        <circle
          cx={sx * size}
          cy={sy * size}
          r={1.5}
          className="fill-emerald-500"
        />
      </svg>
    </div>
  );
}
