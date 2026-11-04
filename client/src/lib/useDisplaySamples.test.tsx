// @vitest-environment jsdom
import '../test/dom-setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PreferencesProvider } from './usePreferences';
import { useDisplaySamples } from './useDisplaySamples';

const raw = [{ timestamp: 0, value: 100 }, { timestamp: 10, value: 50 }];

function wrapperWith(unitSystem: string) {
  localStorage.setItem('quickscope-preferences', JSON.stringify({ unitSystem }));
  return ({ children }: { children: ReactNode }) => <PreferencesProvider>{children}</PreferencesProvider>;
}

beforeEach(() => localStorage.clear());

describe('useDisplaySamples', () => {
  it('converts to the display unit and caches the converted array', () => {
    const { result } = renderHook(() => useDisplaySamples(), { wrapper: wrapperWith('imperial') });
    const a = result.current(1, 'Speed', 'km/h', raw);
    expect(a.unit).toBe('mph');
    expect(a.samples[0].value).toBeCloseTo(62.137, 2);
    expect(a.samples[0].timestamp).toBe(0);
    expect(result.current(1, 'Speed', 'km/h', raw).samples).toBe(a.samples);
    expect(raw[0].value).toBe(100); // raw untouched
  });

  it('returns the raw array itself when no conversion applies', () => {
    const { result } = renderHook(() => useDisplaySamples(), { wrapper: wrapperWith('logger') });
    const a = result.current(1, 'Speed', 'km/h', raw);
    expect(a.unit).toBe('km/h');
    expect(a.samples).toBe(raw);
  });
});
