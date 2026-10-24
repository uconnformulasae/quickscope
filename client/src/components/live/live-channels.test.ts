import { describe, expect, it } from 'vitest';
import {
  BOOL_CHANNELS,
  BUILTIN_CHANNELS,
  CHANNEL_META,
  IC_ENGINE_FLAGS,
  IC_ENGINE_STATS,
  IC_WHEEL_SPEEDS,
  vehicleKind,
} from './live-channels';

describe('vehicleKind', () => {
  it('detects IC cars by a standalone "IC" token', () => {
    expect(vehicleKind('UConn-IC')).toBe('ic');
    expect(vehicleKind('uconn ic')).toBe('ic');
    expect(vehicleKind('IC')).toBe('ic');
    expect(vehicleKind('CT16 IC 2026')).toBe('ic');
  });

  it('defaults to EV, including names that merely contain the letters "ic"', () => {
    expect(vehicleKind('UConn-EV')).toBe('ev');
    expect(vehicleKind('Electric')).toBe('ev');
    expect(vehicleKind('Picard')).toBe('ev');
    expect(vehicleKind('')).toBe('ev');
    expect(vehicleKind(undefined)).toBe('ev');
  });
});

describe('channel tables', () => {
  it('has unique channel names with non-negative precision', () => {
    const names = CHANNEL_META.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of CHANNEL_META) expect(c.precision).toBeGreaterThanOrEqual(0);
  });

  it('has unique boolean channels with a valid kind', () => {
    const names = BOOL_CHANNELS.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    for (const b of BOOL_CHANNELS) expect(['state', 'fault']).toContain(b.kind);
  });

  it('offers every boolean channel in the EV channel picker', () => {
    for (const b of BOOL_CHANNELS) expect(BUILTIN_CHANNELS.ev).toContain(b.name);
  });

  it('offers the pack hero channels in the EV channel picker', () => {
    for (const name of ['Pack_Voltage', 'Pack_Current', 'State_of_Charge']) {
      expect(BUILTIN_CHANNELS.ev).toContain(name);
    }
  });

  it('offers every IC dashboard channel in the IC channel picker', () => {
    for (const s of IC_ENGINE_STATS) expect(BUILTIN_CHANNELS.ic).toContain(s.name);
    for (const f of IC_ENGINE_FLAGS) expect(BUILTIN_CHANNELS.ic).toContain(f.name);
    for (const w of IC_WHEEL_SPEEDS) expect(BUILTIN_CHANNELS.ic).toContain(w);
  });

  it('only offers channels the backend can decode (no live GPS)', () => {
    expect(CHANNEL_META.filter((m) => m.name.startsWith('GPS_'))).toEqual([]);
    expect([...BUILTIN_CHANNELS.ev, ...BUILTIN_CHANNELS.ic].filter((n) => n.startsWith('GPS_'))).toEqual([]);
  });
});
