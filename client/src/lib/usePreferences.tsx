/**
 * Per-viewer display preferences (UI scale, units, GPS trail colors).
 * Kept in localStorage like the theme and sidebar widths — they are a
 * property of this machine/user, not of a session or the backend.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type UnitSystem = 'logger' | 'metric' | 'imperial';
export type GradientPreset = 'turbo' | 'classic' | 'viridis' | 'custom';

export interface GpsGradientPrefs {
  preset: GradientPreset;
  customLow: string;
  customHigh: string;
  rangeMode: 'auto' | 'fixed';
  fixedMin: number;
  fixedMax: number;
}

export interface Preferences {
  uiScale: number;
  unitSystem: UnitSystem;
  /** Channel shortName → display unit label. */
  unitOverrides: Record<string, string>;
  gpsGradient: GpsGradientPrefs;
}

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;
const STORAGE_KEY = 'quickscope-preferences';

export const DEFAULT_PREFERENCES: Preferences = {
  uiScale: 1,
  unitSystem: 'logger',
  unitOverrides: {},
  gpsGradient: {
    preset: 'turbo',
    customLow: '#2563eb',
    customHigh: '#dc2626',
    rangeMode: 'auto',
    fixedMin: 0,
    fixedMax: 150,
  },
};

function clampScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_PREFERENCES.uiScale;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n));
}

function sanitize(raw: Partial<Preferences> | null | undefined): Preferences {
  const d = DEFAULT_PREFERENCES;
  const r = raw && typeof raw === 'object' ? raw : {};
  const unitSystem: UnitSystem = r.unitSystem === 'metric' || r.unitSystem === 'imperial' || r.unitSystem === 'logger'
    ? r.unitSystem : d.unitSystem;
  const overrides = r.unitOverrides && typeof r.unitOverrides === 'object' ? { ...r.unitOverrides } : {};
  return {
    uiScale: clampScale(r.uiScale),
    unitSystem,
    unitOverrides: overrides,
    gpsGradient: { ...d.gpsGradient, ...(r.gpsGradient && typeof r.gpsGradient === 'object' ? r.gpsGradient : {}) },
  };
}

export function loadPreferences(): Preferences {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return sanitize(null);
    return sanitize(JSON.parse(s));
  } catch {
    return sanitize(null);
  }
}

interface PreferencesApi {
  prefs: Preferences;
  update: (patch: Partial<Preferences>) => void;
  reset: () => void;
}

const noop = () => {};
// Without a provider (isolated component tests) everything sees defaults.
const PreferencesContext = createContext<PreferencesApi>({ prefs: DEFAULT_PREFERENCES, update: noop, reset: noop });

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // storage blocked — prefs still apply for this run
    }
  }, [prefs]);

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(prefs.uiScale));
  }, [prefs.uiScale]);

  const update = useCallback((patch: Partial<Preferences>) => {
    setPrefs(prev => sanitize({ ...prev, ...patch }));
  }, []);
  const reset = useCallback(() => setPrefs(sanitize(null)), []);

  const api = useMemo(() => ({ prefs, update, reset }), [prefs, update, reset]);
  return <PreferencesContext.Provider value={api}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesApi {
  return useContext(PreferencesContext);
}
