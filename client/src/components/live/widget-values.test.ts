import { describe, expect, it } from 'vitest';
import { readValue, withDisplayUnit } from './WidgetRenderer';

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

describe('withDisplayUnit', () => {
  it('converts thresholds and the bar range into the new unit', () => {
    const ref = withDisplayUnit({ name: 'S8_ect1', warn: 100, crit: 110, invalidBelow: -40 }, '°F', '°C');
    expect(ref.unit).toBe('°F');
    expect(ref.warn).toBeCloseTo(212);
    expect(ref.crit).toBeCloseTo(230);
    expect(ref.invalidBelow).toBeCloseTo(-40);
    const bar = withDisplayUnit({ name: 'S8_eop', unit: 'bar', min: 0, max: 10 }, 'psi', 'bar');
    expect(bar.min).toBeCloseTo(0);
    expect(bar.max).toBeCloseTo(145.038, 2);
  });

  it('converts from the layout unit, not the logger unit', () => {
    expect(withDisplayUnit({ name: 'x', unit: 'psi', crit: 14.5038 }, 'kPa', 'bar').crit).toBeCloseTo(100, 2);
  });

  it('treats a label-only layout unit as the logger unit', () => {
    expect(withDisplayUnit({ name: 'x', unit: 'kph', crit: 100 }, 'mph', 'km/h').crit).toBeCloseTo(62.137, 2);
  });

  it('leaves unset fields unset', () => {
    const ref = withDisplayUnit({ name: 'x' }, '°F', '°C');
    expect('warn' in ref || 'crit' in ref || 'min' in ref).toBe(false);
  });
});
