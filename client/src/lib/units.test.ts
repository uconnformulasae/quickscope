import { describe, expect, it } from 'vitest';
import { convertibleUnits, getConverter, linearCoefficients, normalizeUnit, resolveDisplayUnit } from './units';

const imperial = { unitSystem: 'imperial' as const, unitOverrides: {} };

describe('normalizeUnit', () => {
  it('maps aliases to canonical labels, null for unknown', () => {
    expect(normalizeUnit('kph')).toBe('km/h');
    expect(normalizeUnit(' DegC ')).toBe('°C');
    expect(normalizeUnit('lb-ft')).toBe('lb·ft');
    expect(normalizeUnit('rpm')).toBeNull();
    expect(normalizeUnit('')).toBeNull();
  });
});

describe('getConverter', () => {
  it('converts speed', () => {
    expect(getConverter('km/h', 'mph').fn(100)).toBeCloseTo(62.137, 3);
    expect(getConverter('kph', 'mph').unit).toBe('mph');
  });

  it('converts temperature (affine) both ways', () => {
    expect(getConverter('°C', '°F').fn(100)).toBeCloseTo(212, 6);
    expect(getConverter('degC', '°F').fn(0)).toBeCloseTo(32, 6);
    expect(getConverter('°F', '°C').fn(212)).toBeCloseTo(100, 6);
  });

  it('converts pressure', () => {
    expect(getConverter('bar', 'psi').fn(1)).toBeCloseTo(14.5038, 3);
    expect(getConverter('kPa', 'psi').fn(100)).toBeCloseTo(14.5038, 3);
  });

  it('is identity for unknown, empty or incompatible units and keeps the raw label', () => {
    const rpm = getConverter('rpm', 'mph');
    expect(rpm.identity).toBe(true);
    expect(rpm.unit).toBe('rpm');
    expect(rpm.fn(3000)).toBe(3000);
    expect(getConverter('', 'mph').identity).toBe(true);
    expect(getConverter('', 'mph').unit).toBe('');
    expect(getConverter('km/h', '°F').identity).toBe(true);
    expect(getConverter('km/h', 'km/h').identity).toBe(true);
  });
});

describe('resolveDisplayUnit', () => {
  it('maps by unit system, with per-channel override winning', () => {
    expect(resolveDisplayUnit('Speed', 'km/h', imperial)).toBe('mph');
    expect(resolveDisplayUnit('Speed', 'km/h', { unitSystem: 'imperial', unitOverrides: { Speed: 'm/s' } })).toBe('m/s');
    expect(resolveDisplayUnit('Speed', 'km/h', { unitSystem: 'logger', unitOverrides: {} })).toBe('km/h');
    expect(resolveDisplayUnit('Speed', 'mph', { unitSystem: 'metric', unitOverrides: {} })).toBe('km/h');
    expect(resolveDisplayUnit('RPM', 'rpm', imperial)).toBe('rpm');
  });

  it('ignores an override that is not compatible with the raw unit', () => {
    expect(resolveDisplayUnit('Speed', 'km/h', { unitSystem: 'logger', unitOverrides: { Speed: 'psi' } })).toBe('km/h');
  });
});

describe('convertibleUnits', () => {
  it('lists units of the same dimension, empty for unknown', () => {
    expect(convertibleUnits('kph')).toEqual(expect.arrayContaining(['km/h', 'mph', 'm/s']));
    expect(convertibleUnits('rpm')).toEqual([]);
  });
});

describe('linearCoefficients', () => {
  it('expresses a converter as value * scale + offset', () => {
    const c = linearCoefficients(getConverter('°C', '°F'));
    expect(c.scale).toBeCloseTo(1.8, 9);
    expect(c.offset).toBeCloseTo(32, 9);
  });
});
