import { usePreferences, UI_SCALE_MAX, UI_SCALE_MIN, type UnitSystem, type GradientPreset, type GpsGradientPrefs } from '../../lib/usePreferences';
import { GRADIENT_PRESETS } from '../../lib/gradients';
import { getConverter } from '../../lib/units';

const PRESETS: { id: GradientPreset; label: string }[] = [
  { id: 'turbo', label: 'Turbo' },
  { id: 'classic', label: 'Classic' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'custom', label: 'Custom' },
];
const inputCls = 'w-full px-2 py-1 rounded-md text-xs bg-muted/30 border border-border text-foreground focus:outline-none focus:border-primary/50';

const UNIT_SYSTEMS: { id: UnitSystem; label: string }[] = [
  { id: 'logger', label: 'Logger' },
  { id: 'metric', label: 'Metric' },
  { id: 'imperial', label: 'Imperial' },
];

const labelCls = 'block text-xs text-muted-foreground mb-1';

/** "Display" section of the Settings dialog. Changes apply immediately. */
export function DisplaySettings() {
  const { prefs, update } = usePreferences();
  const pct = Math.round(prefs.uiScale * 100);
  const g = prefs.gpsGradient;
  const setGradient = (patch: Partial<GpsGradientPrefs>) => update({ gpsGradient: { ...g, ...patch } });
  const presetStops = (id: GradientPreset) => (id === 'custom' ? [g.customLow, g.customHigh] : GRADIENT_PRESETS[id]);
  // The fixed range is stored in km/h (so it means the same speed for every
  // session, whatever unit it logged) and edited in mph under Imperial.
  const speedUnit = prefs.unitSystem === 'imperial' ? 'mph' : 'km/h';
  const toShown = getConverter('km/h', speedUnit).fn;
  const toKmh = getConverter(speedUnit, 'km/h').fn;
  const shown = (kmh: number) => String(Math.round(toShown(kmh) * 10) / 10);

  return (
    <section data-testid="display-settings">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Display
      </h3>
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="ui-scale">UI Scaler</label>
          <div className="flex items-center gap-2">
            <input
              id="ui-scale"
              type="range"
              aria-label="UI scale"
              min={UI_SCALE_MIN * 100}
              max={UI_SCALE_MAX * 100}
              step={5}
              value={pct}
              onChange={e => update({ uiScale: Number(e.target.value) / 100 })}
              className="flex-1 accent-primary"
            />
            <span className="w-10 text-right text-xs tabular text-foreground">{pct}%</span>
            <button
              type="button"
              onClick={() => update({ uiScale: 1 })}
              disabled={prefs.uiScale === 1}
              className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </div>
        <div>
          <span className={labelCls} id="unit-system-label">Units</span>
          <div role="radiogroup" aria-labelledby="unit-system-label" className="inline-flex rounded-md border border-border p-0.5">
            {UNIT_SYSTEMS.map(u => (
              <button
                key={u.id}
                type="button"
                role="radio"
                aria-checked={prefs.unitSystem === u.id}
                onClick={() => update({ unitSystem: u.id })}
                className={`px-3 py-1 rounded text-xs transition-colors ${prefs.unitSystem === u.id ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {u.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Logger shows units as recorded. Per-channel overrides are on the active channel chips.</p>
        </div>
        <div>
          <span className={labelCls}>GPS trail colours</span>
          <div className="grid grid-cols-4 gap-1.5">
            {PRESETS.map(p => (
              <button
                key={p.id}
                type="button"
                aria-pressed={g.preset === p.id}
                onClick={() => setGradient({ preset: p.id })}
                className={`rounded-md border p-1 text-xs transition-colors ${g.preset === p.id ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}
              >
                <div className="h-2 rounded-sm" style={{ background: `linear-gradient(to right, ${presetStops(p.id).join(', ')})` }} />
                <span className="block mt-0.5">{p.label}</span>
              </button>
            ))}
          </div>
          {g.preset === 'custom' && (
            <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              <label className="flex items-center gap-1.5">
                Slow <input type="color" value={g.customLow} onChange={e => setGradient({ customLow: e.target.value })} aria-label="Slow colour" />
              </label>
              <label className="flex items-center gap-1.5">
                Fast <input type="color" value={g.customHigh} onChange={e => setGradient({ customHigh: e.target.value })} aria-label="Fast colour" />
              </label>
            </div>
          )}
          <div className="mt-2 flex flex-col items-start gap-2 text-xs">
            <div role="radiogroup" aria-label="GPS colour range" className="inline-flex rounded-md border border-border p-0.5">
              {(['auto', 'fixed'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={g.rangeMode === m}
                  onClick={() => setGradient({ rangeMode: m })}
                  className={`px-2.5 py-0.5 rounded whitespace-nowrap ${g.rangeMode === m ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                  title={m === 'auto' ? 'Colours span the slowest to fastest speed in each session' : 'Colours span a speed range you set, the same for every session'}
                >
                  {m === 'auto' ? 'Auto range' : 'Fixed range'}
                </button>
              ))}
            </div>
            {g.rangeMode === 'fixed' && (
              <div className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                <span>Slow</span>
                <input type="number" min={0} aria-label="Fixed range minimum" className={`${inputCls} w-20`} value={shown(g.fixedMin)}
                  onChange={e => setGradient({ fixedMin: toKmh(Number(e.target.value) || 0) })} />
                <span>to fast</span>
                <input type="number" min={0} aria-label="Fixed range maximum" className={`${inputCls} w-20`} value={shown(g.fixedMax)}
                  onChange={e => setGradient({ fixedMax: toKmh(Number(e.target.value) || 0) })} />
                <span>{speedUnit}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
