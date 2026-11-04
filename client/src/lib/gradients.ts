/** Color gradients for the GPS speed trail. */
import type { GpsGradientPrefs, GradientPreset } from './usePreferences';

export const GRADIENT_PRESETS: Record<Exclude<GradientPreset, 'custom'>, string[]> = {
  turbo: ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c7ef34', '#fbb938', '#f56918', '#c92903', '#7a0403'],
  classic: ['#32c832', '#ffc832', '#ff0032'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
};

export function gradientStops(p: GpsGradientPrefs): string[] {
  return p.preset === 'custom' ? [p.customLow, p.customHigh] : GRADIENT_PRESETS[p.preset];
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) || 0) as [number, number, number];
}

/** Color at t (0..1, clamped) along evenly spaced stops, as 'rgb(r, g, b)'. */
export function sampleGradient(stops: string[], t: number): string {
  if (stops.length === 0) return 'rgb(0, 0, 0)';
  const tc = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const pos = tc * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  if (stops.length === 1) {
    const [r, g, b] = hexToRgb(stops[0]);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const f = pos - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const mix = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** Position of v in [min, max] as 0..1 (clamped); 0 when the range is empty. */
export function speedToT(v: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}
