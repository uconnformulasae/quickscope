import { formatTime } from './xrk-parser';

const known = (s: string) => !!s && s !== 'Unknown';

export function sessionSubtitle(
  meta: { vehicle: string; date: string; time: string; venue: string },
  durationMs: number,
  lapCount: number,
): string {
  const when = known(meta.date) ? (known(meta.time) ? `${meta.date} at ${meta.time}` : meta.date) : '';
  return [
    known(meta.vehicle) ? meta.vehicle : '',
    when,
    formatTime(durationMs),
    lapCount > 0 ? `${lapCount} laps` : '',
    known(meta.venue) ? meta.venue : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
