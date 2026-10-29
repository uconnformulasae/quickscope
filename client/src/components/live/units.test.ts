import { describe, expect, it } from 'vitest';
import { compatibleUnits, convertUnit, nextUnit, unitCycle } from './units';

describe('convertUnit', () => {
  it('converts temperature both ways', () => {
    expect(convertUnit(100, '°C', '°F')).toBeCloseTo(212);
    expect(convertUnit(32, '°F', '°C')).toBeCloseTo(0);
    expect(convertUnit(-40, '°C', '°F')).toBeCloseTo(-40);
  });

  it('converts pressure, speed, voltage and the rest', () => {
    expect(convertUnit(1, 'bar', 'psi')).toBeCloseTo(14.5038, 3);
    expect(convertUnit(1, 'bar', 'kPa')).toBeCloseTo(100);
    expect(convertUnit(14.5038, 'psi', 'kPa')).toBeCloseTo(100, 2);
    expect(convertUnit(100, 'km/h', 'mph')).toBeCloseTo(62.137, 2);
    expect(convertUnit(12.5, 'V', 'mV')).toBeCloseTo(12500);
    expect(convertUnit(1, 'g', 'm/s²')).toBeCloseTo(9.80665);
    expect(convertUnit(180, '°', 'rad')).toBeCloseTo(Math.PI);
    expect(convertUnit(Math.PI, 'rad/s', '°/s')).toBeCloseTo(180);
    expect(convertUnit(100, 'Nm', 'lb·ft')).toBeCloseTo(73.756, 2);
    expect(convertUnit(1500, 'ms', 's')).toBeCloseTo(1.5);
  });

  it('is the identity for the same unit and refuses mismatched kinds', () => {
    expect(convertUnit(42, '°C', '°C')).toBe(42);
    expect(convertUnit(42, '°C', 'psi')).toBeUndefined();
    expect(convertUnit(42, 'rpm', 'rpm')).toBe(42);
    expect(convertUnit(42, 'rpm', 'mph')).toBeUndefined();
  });
});

describe('compatibleUnits', () => {
  it('lists the units a channel can be shown in, its own first', () => {
    expect(compatibleUnits('°C')).toEqual(['°C', '°F']);
    expect(compatibleUnits('psi')).toEqual(['psi', 'bar', 'kPa']);
  });

  it('offers nothing for units with no alternatives', () => {
    expect(compatibleUnits('rpm')).toEqual([]);
    expect(compatibleUnits('%')).toEqual([]);
    expect(compatibleUnits('')).toEqual([]);
  });
});

describe('unitCycle', () => {
  it('starts at the layout unit and covers the whole family', () => {
    expect(unitCycle('°C', '°C')).toEqual(['°C', '°F']);
    expect(unitCycle('bar', 'psi')).toEqual(['psi', 'kPa', 'bar']);
  });

  it('keeps a label-only layout unit reachable', () => {
    expect(unitCycle('km/h', 'kph')).toEqual(['kph', 'km/h', 'mph']);
  });

  it('is empty when there is nothing to switch to', () => {
    expect(unitCycle('rpm', 'rpm')).toEqual([]);
    expect(unitCycle(undefined, 'kV')).toEqual([]);
  });
});

describe('nextUnit', () => {
  it('steps forward and wraps back to the layout unit', () => {
    const cycle = unitCycle('bar', 'bar');
    expect(nextUnit(cycle, 'bar')).toBe('psi');
    expect(nextUnit(cycle, 'psi')).toBe('kPa');
    expect(nextUnit(cycle, 'kPa')).toBe('bar');
  });

  it('treats a unit outside the cycle as the layout unit, so nothing is stuck', () => {
    expect(nextUnit(['°C', '°F'], 'psi')).toBe('°F');
  });
});
