import { usePreferences, UI_SCALE_MAX, UI_SCALE_MIN, type UnitSystem } from '../../lib/usePreferences';

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
      </div>
    </section>
  );
}
