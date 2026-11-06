// @vitest-environment jsdom
import '../test/dom-setup';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { DEFAULT_PREFERENCES, loadPreferences, PreferencesProvider, usePreferences } from './usePreferences';

const KEY = 'quickscope-preferences';

beforeEach(() => localStorage.clear());

describe('loadPreferences', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('merges stored values over defaults and clamps uiScale', () => {
    localStorage.setItem(KEY, '{"uiScale":3,"unitSystem":"imperial"}');
    const p = loadPreferences();
    expect(p.uiScale).toBe(1.5);
    expect(p.unitSystem).toBe('imperial');
    expect(p.gpsGradient).toEqual(DEFAULT_PREFERENCES.gpsGradient);
  });

  it('keeps per-theme channel colours and defaults them to empty', () => {
    expect(loadPreferences().channelColors).toEqual({ dark: {}, light: {} });
    localStorage.setItem(KEY, '{"channelColors":{"dark":{"RPM":"#123456"}}}');
    expect(loadPreferences().channelColors).toEqual({ dark: { RPM: '#123456' }, light: {} });
  });

  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem(KEY, 'not json');
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('falls back to defaults when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('PreferencesProvider', () => {
  it('persists updates to localStorage', () => {
    let api: ReturnType<typeof usePreferences> | null = null;
    function Consumer() { api = usePreferences(); return null; }
    render(<PreferencesProvider><Consumer /></PreferencesProvider>);
    act(() => api!.update({ uiScale: 1.2 }));
    expect(JSON.parse(localStorage.getItem(KEY)!).uiScale).toBe(1.2);
    expect(api!.prefs.uiScale).toBe(1.2);
  });

  it('applies uiScale as the --ui-scale CSS variable', () => {
    let api: ReturnType<typeof usePreferences> | null = null;
    function Consumer() { api = usePreferences(); return null; }
    render(<PreferencesProvider><Consumer /></PreferencesProvider>);
    act(() => api!.update({ uiScale: 1.25 }));
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
  });
});
