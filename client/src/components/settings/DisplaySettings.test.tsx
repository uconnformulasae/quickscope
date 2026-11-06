// @vitest-environment jsdom
import '../../test/dom-setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PreferencesProvider } from '../../lib/usePreferences';
import { DisplaySettings } from './DisplaySettings';

function renderWith(prefs: object) {
  localStorage.setItem('quickscope-preferences', JSON.stringify(prefs));
  return render(<PreferencesProvider><DisplaySettings /></PreferencesProvider>);
}
const fixed = (min: number, max: number) => ({ preset: 'turbo', rangeMode: 'fixed', fixedMin: min, fixedMax: max });

beforeEach(() => localStorage.clear());

describe('DisplaySettings GPS fixed range', () => {
  it('shows the range in km/h for Logger and Metric', () => {
    renderWith({ unitSystem: 'logger', gpsGradient: fixed(0, 155) });
    expect(screen.getByText('km/h')).toBeTruthy();
    expect((screen.getByLabelText('Fixed range maximum') as HTMLInputElement).value).toBe('155');
    expect(screen.queryByText('logger units')).toBeNull();
  });

  it('shows and edits the range in mph for Imperial, storing km/h', () => {
    renderWith({ unitSystem: 'imperial', gpsGradient: fixed(0, 160.9344) });
    expect(screen.getByText('mph')).toBeTruthy();
    const max = screen.getByLabelText('Fixed range maximum') as HTMLInputElement;
    expect(max.value).toBe('100');
    fireEvent.change(max, { target: { value: '50' } });
    const stored = JSON.parse(localStorage.getItem('quickscope-preferences')!).gpsGradient.fixedMax;
    expect(stored).toBeCloseTo(80.4672, 3);
  });
});

describe('DisplaySettings UI scale', () => {
  it('is labelled UI Scaler', () => {
    renderWith({});
    expect(screen.getByText('UI Scaler')).toBeTruthy();
    expect(screen.queryByText('Text size')).toBeNull();
  });
});
