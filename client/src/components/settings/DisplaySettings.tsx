import { usePreferences, UI_SCALE_MAX, UI_SCALE_MIN } from '../../lib/usePreferences';

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
      </div>
    </section>
  );
}
