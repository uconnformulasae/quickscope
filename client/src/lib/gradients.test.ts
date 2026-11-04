import { describe, expect, it } from 'vitest';
import { fixedRangeIn, gradientStops, GRADIENT_PRESETS, sampleGradient, speedToT } from './gradients';
import { DEFAULT_PREFERENCES } from './usePreferences';

describe('sampleGradient', () => {
  it('interpolates linearly between two stops and clamps t', () => {
    expect(sampleGradient(['#000000', '#ffffff'], 0.5)).toBe('rgb(128, 128, 128)');
    expect(sampleGradient(['#000000', '#ffffff'], -1)).toBe('rgb(0, 0, 0)');
    expect(sampleGradient(['#000000', '#ffffff'], 2)).toBe('rgb(255, 255, 255)');
  });

  it('hits the middle stop of a three-stop gradient', () => {
    expect(sampleGradient(['#ff0000', '#00ff00', '#0000ff'], 0.5)).toBe('rgb(0, 255, 0)');
  });
});

describe('speedToT', () => {
  it('normalises into 0..1 and never divides by zero', () => {
    expect(speedToT(50, 0, 100)).toBe(0.5);
    expect(speedToT(10, 10, 10)).toBe(0);
    expect(speedToT(200, 0, 100)).toBe(1);
  });
});

describe('gradientStops', () => {
  it('uses custom colours for the custom preset and preset stops otherwise', () => {
    const g = DEFAULT_PREFERENCES.gpsGradient;
    expect(gradientStops({ ...g, preset: 'custom', customLow: '#111111', customHigh: '#eeeeee' })).toEqual(['#111111', '#eeeeee']);
    expect(gradientStops({ ...g, preset: 'classic' })).toEqual(GRADIENT_PRESETS.classic);
  });
});

describe('fixedRangeIn', () => {
  it('converts the stored km/h range to the session\'s speed unit', () => {
    const [lo, hi] = fixedRangeIn(0, 180, 'm/s');
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(50, 6);
    expect(fixedRangeIn(0, 160.9344, 'mph')[1]).toBeCloseTo(100, 4);
  });

  it('assumes km/h when the session unit is unknown', () => {
    expect(fixedRangeIn(10, 150, '')).toEqual([10, 150]);
  });

  it('orders a reversed range', () => {
    expect(fixedRangeIn(150, 10, 'km/h')).toEqual([10, 150]);
  });
});
