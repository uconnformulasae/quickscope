export interface SessionGroup<T> {
  label: string;
  sessions: T[];
}

function parseTime(s: string | null): number {
  if (!s) return NaN;
  return new Date(s).getTime();
}

/** recorded_at if it parses, else created_at, else NaN. */
function sessionTime(s: { recorded_at: string | null; created_at: string }): number {
  const rec = parseTime(s.recorded_at);
  return Number.isNaN(rec) ? parseTime(s.created_at) : rec;
}

/**
 * Buckets sessions as Today, This Week (the previous 6 local days), one group
 * per month (newest first), then Earlier for undated ones. Local time throughout.
 */
export function groupSessionsByDate<T extends { recorded_at: string | null; created_at: string }>(
  sessions: T[],
  now: Date,
): SessionGroup<T>[] {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();

  const dated = sessions.map((s) => ({ s, t: sessionTime(s) }));
  const byNewest = (a: { t: number }, b: { t: number }) => b.t - a.t;

  const today: typeof dated = [];
  const week: typeof dated = [];
  const months = new Map<number, { label: string; items: typeof dated }>();
  const earlier: typeof dated = [];

  for (const item of dated) {
    if (Number.isNaN(item.t)) {
      earlier.push(item);
      continue;
    }
    const d = new Date(item.t);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (dayStart === todayStart) today.push(item);
    else if (dayStart >= weekStart && dayStart < todayStart) week.push(item);
    else {
      const key = d.getFullYear() * 12 + d.getMonth();
      let m = months.get(key);
      if (!m) {
        m = { label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }), items: [] };
        months.set(key, m);
      }
      m.items.push(item);
    }
  }

  const out: SessionGroup<T>[] = [];
  const push = (label: string, items: typeof dated) => {
    if (items.length) out.push({ label, sessions: [...items].sort(byNewest).map((i) => i.s) });
  };
  push('Today', today);
  push('This Week', week);
  [...months.entries()].sort((a, b) => b[0] - a[0]).forEach(([, m]) => push(m.label, m.items));
  push('Earlier', earlier);
  return out;
}
