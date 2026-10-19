import { describe, expect, it } from 'vitest';
import {
  BOOL_CHANNELS,
  CHANNEL_META,
  IC_ENGINE_FLAGS,
  IC_ENGINE_STATS,
  IC_PANEL_OWNED_CHANNELS,
  IC_WHEEL_SPEEDS,
  PACK_V_MAX,
  PACK_V_NOMINAL,
  PANEL_OWNED_CHANNELS,
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

  it('marks every boolean channel as panel-owned so it is not duplicated under "Other"', () => {
    for (const b of BOOL_CHANNELS) expect(PANEL_OWNED_CHANNELS.has(b.name)).toBe(true);
  });

  it('marks the pack hero channels as panel-owned', () => {
    for (const name of ['Pack_Voltage', 'Pack_Current', 'State_of_Charge']) {
      expect(PANEL_OWNED_CHANNELS.has(name)).toBe(true);
    }
  });

  it('keeps nominal pack voltage below the maximum', () => {
    expect(PACK_V_NOMINAL).toBeLessThan(PACK_V_MAX);
  });

  it('marks every IC dashboard channel as IC panel-owned', () => {
    for (const s of IC_ENGINE_STATS) expect(IC_PANEL_OWNED_CHANNELS.has(s.name)).toBe(true);
    for (const f of IC_ENGINE_FLAGS) expect(IC_PANEL_OWNED_CHANNELS.has(f.name)).toBe(true);
    for (const w of IC_WHEEL_SPEEDS) expect(IC_PANEL_OWNED_CHANNELS.has(w)).toBe(true);
  });
});
