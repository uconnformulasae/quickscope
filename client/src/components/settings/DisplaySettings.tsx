import { usePreferences, UI_SCALE_MAX, UI_SCALE_MIN, type UnitSystem, type GradientPreset, type GpsGradientPrefs } from '../../lib/usePreferences';
import { GRADIENT_PRESETS } from '../../lib/gradients';
import { resolveDisplayUnit } from '../../lib/units';

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
  // Fixed range is in the display speed unit: known for Metric/Imperial; in
  // Logger mode it's whatever the session's GPS speed channel records.
  const speedUnit = prefs.unitSystem === 'logger' ? 'logger units' : resolveDisplayUnit('GPS Speed', 'km/h', prefs);

  return (
    <section data-testid="display-settings">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Display
      </h3>
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="ui-scale">Text size</label>
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
          <div className="mt-2 flex items-center gap-2 text-xs">
            <div role="radiogroup" aria-label="GPS colour range" className="inline-flex rounded-md border border-border p-0.5">
              {(['auto', 'fixed'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={g.rangeMode === m}
                  onClick={() => setGradient({ rangeMode: m })}
                  className={`px-2 py-0.5 rounded ${g.rangeMode === m ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {m === 'auto' ? 'Auto range' : 'Fixed range'}
                </button>
              ))}
            </div>
            {g.rangeMode === 'fixed' && (
              <div className="flex items-center gap-1 text-muted-foreground">
                <input type="number" aria-label="Fixed range minimum" className={`${inputCls} w-16`} value={g.fixedMin}
                  onChange={e => setGradient({ fixedMin: Number(e.target.value) || 0 })} />
                –
                <input type="number" aria-label="Fixed range maximum" className={`${inputCls} w-16`} value={g.fixedMax}
                  onChange={e => setGradient({ fixedMax: Number(e.target.value) || 0 })} />
                <span>{speedUnit}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
