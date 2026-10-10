/** Download a GPS trail as a GPX track. */
export function downloadGpx(trail: { lat: number; lon: number }[]): void {
  if (trail.length === 0) return;
  const now = new Date().toISOString();
  const points = trail
    .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"></trkpt>`)
    .join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="QuickScope" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><time>${now}</time></metadata>
  <trk>
    <name>QuickScope Live</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `quickscope-live-${now.replace(/[:.]/g, '-')}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
