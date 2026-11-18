import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { initialWindowBounds, fitBoundsToWorkArea } = require('../../electron/window-size.cjs');

describe('initialWindowBounds', () => {
  it('fills 90% of the work area, centred', () => {
    const b = initialWindowBounds({ x: 0, y: 25, width: 1920, height: 1055 });
    expect(b).toMatchObject({ width: 1728, height: 950, minWidth: 1024, minHeight: 640 });
    expect(b.x).toBe(96);
    expect(b.y).toBe(25 + 53);
  });

  it('never exceeds a small screen, shrinking the minimum size to fit', () => {
    const b = initialWindowBounds({ x: 0, y: 0, width: 1000, height: 600 });
    expect(b.minWidth).toBe(1000);
    expect(b.minHeight).toBe(600);
    expect(b.width).toBe(1000);
    expect(b.height).toBe(600);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });

  it('respects a work area offset (secondary display)', () => {
    const b = initialWindowBounds({ x: 2560, y: 0, width: 1440, height: 900 });
    expect(b.x).toBeGreaterThanOrEqual(2560);
    expect(b.x + b.width).toBeLessThanOrEqual(2560 + 1440);
  });
});

describe('fitBoundsToWorkArea', () => {
  it('leaves a window that already fits alone', () => {
    const bounds = { x: 100, y: 100, width: 1200, height: 800 };
    expect(fitBoundsToWorkArea(bounds, { x: 0, y: 0, width: 1920, height: 1080 })).toBeNull();
  });

  it('shrinks and moves a window that no longer fits', () => {
    const fitted = fitBoundsToWorkArea({ x: 500, y: 300, width: 1800, height: 1000 }, { x: 0, y: 0, width: 1280, height: 800 });
    expect(fitted).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it('pulls an off-screen window back inside', () => {
    const fitted = fitBoundsToWorkArea({ x: 1500, y: 100, width: 800, height: 600 }, { x: 0, y: 0, width: 1920, height: 1080 });
    expect(fitted).toEqual({ x: 1120, y: 100, width: 800, height: 600 });
  });
});
