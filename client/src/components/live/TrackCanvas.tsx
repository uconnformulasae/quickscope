import type { Snapshot } from './live-channels';

export function TrackCanvas({
  trail,
  latest,
}: {
  trail: { lat: number; lon: number; speed: number }[];
  latest: Snapshot | null;
}) {
  // Empty state — no GPS points yet.
  if (trail.length < 2) {
    return (
      <div
        className="rounded-md bg-muted/30 dark:bg-background/40 border border-border/40 flex items-center justify-center text-[11px] text-muted-foreground"
        style={{ aspectRatio: '1 / 1', minHeight: 160 }}
      >
        Waiting for GPS fix…
      </div>
    );
  }

  // Bounds + aspect-correction (lon shrinks as lat moves away from equator).
  const minLat = Math.min(...trail.map((p) => p.lat));
  const maxLat = Math.max(...trail.map((p) => p.lat));
  const minLon = Math.min(...trail.map((p) => p.lon));
  const maxLon = Math.max(...trail.map((p) => p.lon));
  const midLat = (minLat + maxLat) / 2;
  const lonM = (maxLon - minLon) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const latM = (maxLat - minLat) * 111_320;
  const span = Math.max(lonM, latM) || 1;

  const VB = 200;  // viewBox size — coords scale into [0..VB]
  const project = (lat: number, lon: number) => {
    const xM = (lon - minLon) * 111_320 * Math.cos((midLat * Math.PI) / 180);
    const yM = (lat - minLat) * 111_320;
    const cx = (span - lonM) / 2;
    const cy = (span - latM) / 2;
    const x = ((xM + cx) / span) * VB;
    const y = VB - ((yM + cy) / span) * VB;  // SVG y grows downward
    return [x, y] as const;
  };

  const path = trail
    .map((p, i) => {
      const [x, y] = project(p.lat, p.lon);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  const [sx, sy] = project(trail[0].lat, trail[0].lon);
  const [cx, cy] = project(trail[trail.length - 1].lat, trail[trail.length - 1].lon);
  const heading = latest?.channels?.['GPS_Heading'] ?? 0;

  return (
    <div
      className="rounded-md bg-muted/30 dark:bg-background/40 border border-border/40 overflow-hidden"
      style={{ aspectRatio: '1 / 1', minHeight: 160 }}
    >
      <svg viewBox={`0 0 ${VB} ${VB}`} width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-primary"
        />
        {/* Start marker */}
        <circle cx={sx} cy={sy} r={2.5} className="fill-emerald-500" />
        {/* Current position with heading triangle */}
        <g transform={`translate(${cx}, ${cy}) rotate(${heading})`}>
          <polygon points="0,-5 4,4 0,2 -4,4" className="fill-amber-500 stroke-amber-700" strokeWidth={0.5} />
        </g>
      </svg>
    </div>
  );
}
