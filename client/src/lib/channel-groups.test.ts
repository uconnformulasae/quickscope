import { describe, expect, it } from 'vitest';
import { groupChannelsByPrefix } from './channel-groups';

const mk = (names: string[]) => names.map((shortName) => ({ shortName }));
const names = (g: { channels: { shortName: string }[] }) => g.channels.map((c) => c.shortName);

describe('groupChannelsByPrefix', () => {
  it('groups by prefix, sorts groups, and puts the rest under Other', () => {
    const g = groupChannelsByPrefix(mk(['BMS_A', 'BMS_B', 'APPS_X', 'APPS_Y', 'Speed', '_hidden', 'Cell_1']));
    expect(g.map((x) => x.name)).toEqual(['APPS', 'BMS', 'Other']);
    expect(names(g[0])).toEqual(['APPS_X', 'APPS_Y']);
    expect(names(g[1])).toEqual(['BMS_A', 'BMS_B']);
    expect(names(g[2])).toEqual(['Speed', '_hidden', 'Cell_1']);
  });
  it('compares case-insensitively and keeps first-seen casing', () => {
    const g = groupChannelsByPrefix(mk(['bms_a', 'BMS_b']));
    expect(g).toHaveLength(1);
    expect(g[0].name).toBe('bms');
  });
  it('returns [] for no channels', () => {
    expect(groupChannelsByPrefix([])).toEqual([]);
  });
});
