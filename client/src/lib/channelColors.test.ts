import { describe, expect, it } from 'vitest';
import { applyChannelColors, CHANNEL_PALETTE, effectiveChannelColor } from './channelColors';
import { makeChannel, makeSession } from '../test-fixtures';

const none = { dark: {}, light: {} };

describe('effectiveChannelColor', () => {
  it('uses the theme\'s custom colour when set, else the default for that theme', () => {
    const overrides = { dark: { RPM: '#123456' }, light: {} };
    expect(effectiveChannelColor('RPM', '#f77f00', 'dark', overrides)).toBe('#123456');
    expect(effectiveChannelColor('RPM', '#f77f00', 'light', overrides)).toBe('#c2410c'); // default light variant
    expect(effectiveChannelColor('Speed', '#f77f00', 'dark', overrides)).toBe('#f77f00');
  });
});

describe('applyChannelColors', () => {
  it('resolves active channel colours by channel name (session and derived)', () => {
    const session = makeSession({ channels: new Map([[1, makeChannel(1, 'RPM')], [2, makeChannel(2, 'Speed')]]) });
    const derived = [{ id: 10000, name: 'Power', units: 'kW', mode: 'formula' as const, expression: 'x', color: '#f43f5e' }];
    const active = [{ channelId: 1, color: '#f77f00' }, { channelId: 2, color: '#3de06a' }, { channelId: 10000, color: '#f43f5e' }];
    const out = applyChannelColors(active, session, derived, 'dark', { dark: { Speed: '#00ffff', Power: '#ffffff' }, light: {} });
    expect(out.map(a => a.color)).toEqual(['#f77f00', '#00ffff', '#ffffff']);
    expect(applyChannelColors(active, session, derived, 'dark', none)).toEqual(active);
  });
});

describe('CHANNEL_PALETTE', () => {
  it('offers a distinct palette per theme', () => {
    expect(CHANNEL_PALETTE.dark.length).toBeGreaterThanOrEqual(10);
    expect(CHANNEL_PALETTE.light.length).toBe(CHANNEL_PALETTE.dark.length);
    expect(new Set(CHANNEL_PALETTE.dark).size).toBe(CHANNEL_PALETTE.dark.length);
  });
});
