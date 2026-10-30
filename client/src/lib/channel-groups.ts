import { useCallback, useState } from 'react';

export interface ChannelGroup<T> {
  name: string;
  channels: T[];
}

/** Group channels by the text before the first `_`. Singletons go under a final "Other". */
export function groupChannelsByPrefix<T extends { shortName: string }>(channels: T[]): ChannelGroup<T>[] {
  const byKey = new Map<string, ChannelGroup<T>>();
  const loose: T[] = [];
  for (const ch of channels) {
    const i = ch.shortName.indexOf('_');
    const prefix = i > 0 ? ch.shortName.slice(0, i) : '';
    if (!prefix) {
      loose.push(ch);
      continue;
    }
    const key = prefix.toLowerCase();
    const g = byKey.get(key);
    if (g) g.channels.push(ch);
    else byKey.set(key, { name: prefix, channels: [ch] });
  }
  const groups: ChannelGroup<T>[] = [];
  const other: T[] = [...loose];
  for (const g of byKey.values()) {
    if (g.channels.length >= 2) groups.push(g);
    else other.push(...g.channels);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  if (other.length > 0) {
    // restore input order for the mixed Other bucket
    const order = new Map(channels.map((c, idx) => [c, idx]));
    other.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    groups.push({ name: 'Other', channels: other });
  }
  return groups;
}

const STORAGE_KEY = 'quickscope-channel-groups-open';

function readOpen(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Collapsed-by-default group state, persisted as the list of open group names. */
export function useCollapsedGroups(): { isCollapsed(name: string): boolean; toggle(name: string): void } {
  const [open, setOpen] = useState<string[]>(readOpen);
  const isCollapsed = useCallback((name: string) => !open.includes(name), [open]);
  const toggle = useCallback((name: string) => {
    setOpen((cur) => {
      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return { isCollapsed, toggle };
}
