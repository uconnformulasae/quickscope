/**
 * Display-unit view of channel samples. Converted arrays are cached per
 * (channel, target unit) and reused until the raw array or prefs change, so
 * re-renders and redraws don't re-convert. Identity conversions return the
 * raw array itself.
 */
import { useMemo } from 'react';
import type { ChannelSample } from './xrk-parser';
import { usePreferences } from './usePreferences';
import { getConverter, resolveDisplayUnit } from './units';

export type DisplaySamplesFn = ((
  channelId: number, shortName: string, rawUnit: string, raw: ChannelSample[],
) => { unit: string; samples: ChannelSample[] }) & {
  /** Display unit label for a channel, without touching samples. */
  unitOf: (shortName: string, rawUnit: string) => string;
};

export function useDisplaySamples(): DisplaySamplesFn {
  const { prefs } = usePreferences();
  const { unitSystem, unitOverrides } = prefs;
  // New cache whenever the unit prefs change.
  const cache = useMemo(
    () => new Map<string, { raw: ChannelSample[]; samples: ChannelSample[] }>(),
    [unitSystem, unitOverrides],
  );

  return useMemo(() => {
    const unitOf = (shortName: string, rawUnit: string) =>
      getConverter(rawUnit, resolveDisplayUnit(shortName, rawUnit, { unitSystem, unitOverrides })).unit;
    const fn = (channelId: number, shortName: string, rawUnit: string, raw: ChannelSample[]) => {
    const target = resolveDisplayUnit(shortName, rawUnit, { unitSystem, unitOverrides });
    const conv = getConverter(rawUnit, target);
    if (conv.identity) return { unit: rawUnit, samples: raw };
    const key = `${channelId}|${conv.unit}`;
    const hit = cache.get(key);
    if (hit && hit.raw === raw) return { unit: conv.unit, samples: hit.samples };
    const samples = raw.map(s => ({ ...s, value: conv.fn(s.value) }));
    cache.set(key, { raw, samples });
    return { unit: conv.unit, samples };
    };
    return Object.assign(fn, { unitOf });
  }, [cache, unitSystem, unitOverrides]);
}
