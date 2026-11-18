/**
 * User-chosen channel colours, per theme (a colour that reads on dark may not
 * on light), keyed by channel name so they follow the channel across sessions.
 */
import type { ActiveChannel, DerivedChannel } from './useXRKStore';
import type { XRKSession } from './xrk-parser';
import { resolveChartColor } from './chart-utils';

export type Theme = 'dark' | 'light';
export type ChannelColorOverrides = Record<Theme, Record<string, string>>;

/** Distinct, theme-appropriate choices (light = deeper shades of the same hues). */
export const CHANNEL_PALETTE: Record<Theme, string[]> = {
  dark: ['#f77f00', '#4361ee', '#3de06a', '#f43f5e', '#22d3ee', '#facc15', '#a855f7', '#ec4899', '#84cc16', '#fb923c', '#ffffff', '#94a3b8'],
  light: ['#c2410c', '#1d4ed8', '#15803d', '#be123c', '#0e7490', '#a16207', '#7c3aed', '#be185d', '#4d7c0f', '#b45309', '#111827', '#475569'],
};

export function effectiveChannelColor(name: string, baseHex: string, theme: Theme, overrides: ChannelColorOverrides): string {
  return overrides[theme][name] ?? resolveChartColor(baseHex, theme);
}

/** Active channels with their colour for the current theme (custom or default). */
export function applyChannelColors(
  active: ActiveChannel[], session: XRKSession, derived: DerivedChannel[], theme: Theme, overrides: ChannelColorOverrides,
): ActiveChannel[] {
  return active.map(ac => {
    const name = session.channels.get(ac.channelId)?.shortName ?? derived.find(d => d.id === ac.channelId)?.name;
    const color = name !== undefined ? effectiveChannelColor(name, ac.color, theme, overrides) : resolveChartColor(ac.color, theme);
    return color === ac.color ? ac : { ...ac, color };
  });
}
