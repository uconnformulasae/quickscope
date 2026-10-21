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

describe('readValue with a chosen unit', () => {
  const ch = { S8_ect1: 100, S8_map1: 1, Pack_Voltage: 400 };
  const units = { S8_ect1: '°C', S8_map1: 'bar' };

  it('converts from the logger unit into the tile unit', () => {
    expect(readValue({ name: 'S8_ect1', unit: '°F' }, ch, units)).toBeCloseTo(212);
    expect(readValue({ name: 'S8_map1', unit: 'kPa' }, ch, units)).toBeCloseTo(100);
  });

  it('leaves the value alone without a choice, or when the unit is only a label', () => {
    expect(readValue({ name: 'S8_ect1' }, ch, units)).toBe(100);
    expect(readValue({ name: 'S8_ect1', unit: 'degrees' }, ch, units)).toBe(100);
    expect(readValue({ name: '', expr: 'Pack_Voltage / 1000', unit: 'kV' }, ch, units)).toBeCloseTo(0.4);
  });

  it('applies the no-data floor in the tile unit', () => {
    expect(readValue({ name: 'S8_ect1', unit: '°F', invalidBelow: 200 }, ch, units)).toBeCloseTo(212);
    expect(readValue({ name: 'S8_ect1', unit: '°F', invalidBelow: 220 }, ch, units)).toBeUndefined();
  });
});
