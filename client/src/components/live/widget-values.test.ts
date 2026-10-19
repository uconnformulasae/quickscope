import { describe, expect, it } from 'vitest';
import { readValue } from './WidgetRenderer';

describe('readValue', () => {
  const ch = { Pack_Voltage: 400, Pack_Current: 50, '0TC01': -1000, '0TC02': 31.5 };

  it('reads a channel and treats a missing one as no data', () => {
    expect(readValue({ name: 'Pack_Voltage' }, ch)).toBe(400);
    expect(readValue({ name: 'Nope' }, ch)).toBeUndefined();
  });

  it('evaluates a formula against the snapshot', () => {
    expect(readValue({ name: '', expr: 'Pack_Voltage * Pack_Current / 1000' }, ch)).toBe(20);
    // Formula referencing a channel the car isn't sending → no data, not 0.
    expect(readValue({ name: '', expr: 'Pack_Voltage * Missing' }, ch)).toBeUndefined();
    expect(readValue({ name: '', expr: 'Pack_Voltage *' }, ch)).toBeUndefined();
  });

  it('applies the no-data floor (disconnected thermocouple)', () => {
    expect(readValue({ name: '0TC01', invalidBelow: -1000 }, ch)).toBeUndefined();
    expect(readValue({ name: '0TC02', invalidBelow: -1000 }, ch)).toBe(31.5);
  });
});
