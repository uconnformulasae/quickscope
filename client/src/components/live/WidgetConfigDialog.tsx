import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, LayoutGrid, Plus, Trash2, X } from 'lucide-react';
import { ChannelDatalist, ChannelPicker, type ChannelSources } from './ChannelPicker';
import {
  WIDGET_TYPES,
  type ChannelRef,
  type StatStyle,
  type Tone,
  type ValueFormat,
  type WidgetConfig,
  type WidgetType,
} from './layout-schema';

const INPUT = 'w-full px-2 py-1 bg-background border border-border rounded text-xs text-foreground placeholder-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary';
const LABEL = 'block text-[10px] uppercase tracking-wide text-muted-foreground mb-1';

const HAS_CHANNELS = new Set<WidgetType>(['stats', 'bars', 'boolGroup', 'gForce']);
const HAS_COLUMNS = new Set<WidgetType>(['stats', 'boolGroup', 'otherChannels']);

function parseNum(text: string): number | undefined {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) ? undefined : n;
}

function NumField({ label, value, onChange, placeholder }: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
}) {
  // Keep the raw text so "-" or "1." can be typed before it parses; re-sync
  // only when the value changes from outside (e.g. rows reordered).
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    if (parseNum(text) !== value) setText(value === undefined ? '' : String(value));
  }, [value]);
  return (
    <label className="block min-w-0">
      <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/80 mb-0.5">{label}</span>
      <input
        value={text}
        inputMode="decimal"
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseNum(e.target.value));
        }}
        className={`${INPUT} tabular`}
      />
    </label>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T | undefined;
  options: { value: T | ''; label: string }[];
  onChange: (v: T | undefined) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/80 mb-0.5">{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange((e.target.value || undefined) as T | undefined)} className={INPUT}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

const TONES: { value: Tone | ''; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'primary', label: 'Blue' },
  { value: 'emerald', label: 'Green' },
  { value: 'amber', label: 'Amber' },
  { value: 'red', label: 'Red' },
  { value: 'muted', label: 'Grey' },
];

/** Type-specific settings for one channel row. */
function ChannelDetails({ type, ch, set }: { type: WidgetType; ch: ChannelRef; set: (patch: Partial<ChannelRef>) => void }) {
  if (type === 'boolGroup') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <SelectField<'state' | 'fault'>
          label="Meaning of 1"
          value={ch.kind ?? 'state'}
          options={[{ value: 'state', label: 'On / enabled (green)' }, { value: 'fault', label: 'Fault active (red)' }]}
          onChange={(v) => set({ kind: v ?? 'state' })}
        />
      </div>
    );
  }
  if (type === 'gForce') return null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        <label className="block min-w-0">
          <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/80 mb-0.5">Unit</span>
          <input value={ch.unit ?? ''} onChange={(e) => set({ unit: e.target.value || undefined })} placeholder="auto" className={INPUT} />
        </label>
        <NumField label="Decimals" value={ch.precision} onChange={(v) => set({ precision: v === undefined ? undefined : Math.max(0, Math.min(6, Math.round(v))) })} placeholder="auto" />
        <NumField label="Warn ≥" value={ch.warn} onChange={(v) => set({ warn: v })} />
        <NumField label="Critical ≥" value={ch.crit} onChange={(v) => set({ crit: v })} />
      </div>
      <div className="grid grid-cols-4 gap-2">
        {type === 'bars' ? (
          <>
            <NumField label="Bar min" value={ch.min} onChange={(v) => set({ min: v })} placeholder="0" />
            <NumField label="Bar max" value={ch.max} onChange={(v) => set({ max: v })} placeholder="100" />
          </>
        ) : (
          <SelectField<ValueFormat>
            label="Show as"
            value={ch.format}
            options={[{ value: '', label: 'Number' }, { value: 'onoff', label: 'Enabled / Disabled' }, { value: 'direction', label: 'FWD / REV' }]}
            onChange={(v) => set({ format: v === 'number' ? undefined : v })}
          />
        )}
        <SelectField<Tone> label="Color" value={ch.tone} options={TONES} onChange={(v) => set({ tone: v })} />
        <NumField label="No data ≤" value={ch.invalidBelow} onChange={(v) => set({ invalidBelow: v })} />
      </div>
      <label className="block">
        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/80 mb-0.5">
          Formula (optional — replaces the channel, e.g. Pack_Voltage * Pack_Current / 1000)
        </span>
        <input value={ch.expr ?? ''} onChange={(e) => set({ expr: e.target.value || undefined })} spellCheck={false} className={`${INPUT} font-mono`} />
      </label>
    </div>
  );
}

export function WidgetConfigDialog({
  widget,
  sources,
  onSave,
  onClose,
}: {
  widget: WidgetConfig;
  sources: ChannelSources;
  onSave: (widget: WidgetConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<WidgetConfig>(() => ({
    ...widget,
    channels: widget.type === 'gForce' && widget.channels.length < 2
      ? [...widget.channels, ...Array.from({ length: 2 - widget.channels.length }, () => ({ name: '' }))]
      : widget.channels.map((c) => ({ ...c })),
  }));
  const set = (patch: Partial<WidgetConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const setChannel = (i: number, patch: Partial<ChannelRef>) =>
    setDraft((d) => ({ ...d, channels: d.channels.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const channels = [...d.channels];
      const j = i + dir;
      if (j < 0 || j >= channels.length) return d;
      [channels[i], channels[j]] = [channels[j], channels[i]];
      return { ...d, channels };
    });

  const changeType = (type: WidgetType) =>
    setDraft((d) => ({
      ...d,
      type,
      // gForce always has exactly lateral + longitudinal.
      channels: type === 'gForce'
        ? [d.channels[0] ?? { name: 'LateralAcc' }, d.channels[1] ?? { name: 'InlineAcc' }]
        : d.channels,
    }));

  const save = () => {
    const channels = HAS_CHANNELS.has(draft.type)
      ? draft.channels.filter((c) => c.name.trim() || c.expr?.trim()).map((c) => ({ ...c, name: c.name.trim() }))
      : [];
    onSave({ ...draft, title: draft.title.trim() || WIDGET_TYPES.find((t) => t.type === draft.type)!.label, channels });
  };

  const listId = `channels-${widget.id}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="relative w-[640px] max-w-[calc(100vw-2rem)] max-h-[90vh] flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Configure widget"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Configure widget</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <ChannelDatalist id={listId} sources={sources} />

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={LABEL}>Type</span>
              <select value={draft.type} onChange={(e) => changeType(e.target.value as WidgetType)} className={INPUT}>
                {WIDGET_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label} — {t.description}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={LABEL}>Title</span>
              <input value={draft.title} onChange={(e) => set({ title: e.target.value })} className={INPUT} />
            </label>
          </div>

          <div className="grid grid-cols-3 gap-3 items-end">
            {draft.type === 'stats' && (
              <SelectField<StatStyle>
                label="Tile size"
                value={draft.style ?? 'tile'}
                options={[{ value: 'big', label: 'Large' }, { value: 'tile', label: 'Medium' }, { value: 'compact', label: 'Compact' }]}
                onChange={(v) => set({ style: v })}
              />
            )}
            {HAS_COLUMNS.has(draft.type) && (
              <NumField
                label="Columns"
                value={draft.columns}
                placeholder="auto"
                onChange={(v) => set({ columns: v === undefined ? undefined : Math.max(1, Math.min(12, Math.round(v))) })}
              />
            )}
            {draft.type === 'gForce' && (
              <NumField label="Range (g)" value={draft.channels[0]?.max} placeholder="2" onChange={(v) => setChannel(0, { max: v })} />
            )}
            <label className="flex items-center gap-2 text-xs text-muted-foreground pb-1.5">
              <input type="checkbox" checked={!!draft.emphasis} onChange={(e) => set({ emphasis: e.target.checked || undefined })} />
              Highlight border
            </label>
          </div>

          {HAS_CHANNELS.has(draft.type) && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={LABEL}>Channels</span>
                {draft.type !== 'gForce' && (
                  <button
                    onClick={() => set({ channels: [...draft.channels, { name: '' }] })}
                    className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                  >
                    <Plus className="w-3 h-3" /> Add channel
                  </button>
                )}
              </div>
              {draft.channels.length === 0 && (
                <p className="text-[11px] text-muted-foreground/70">No channels yet.</p>
              )}
              <div className="space-y-2">
                {draft.channels.map((ch, i) => (
                  <div key={i} className="rounded-md border border-border/60 bg-muted/20 p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      {draft.type === 'gForce' && (
                        <span className="text-[10px] text-muted-foreground w-20 shrink-0">{i === 0 ? 'Lateral' : 'Longitudinal'}</span>
                      )}
                      <ChannelPicker value={ch.name} onChange={(name) => setChannel(i, { name })} listId={listId} sources={sources} />
                      {draft.type !== 'gForce' && (
                        <>
                          <input
                            value={ch.label ?? ''}
                            onChange={(e) => setChannel(i, { label: e.target.value || undefined })}
                            placeholder="Label"
                            className={`${INPUT} !w-32`}
                          />
                          <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30" title="Move up">
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button onClick={() => move(i, 1)} disabled={i === draft.channels.length - 1} className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30" title="Move down">
                            <ArrowDown className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => set({ channels: draft.channels.filter((_, j) => j !== i) })}
                            className="p-1 text-muted-foreground hover:text-red-500"
                            title="Remove channel"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                    <ChannelDetails type={draft.type} ch={ch} set={(patch) => setChannel(i, patch)} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <label className="block">
            <span className={LABEL}>{draft.type === 'note' ? 'Text' : 'Note under widget (optional)'}</span>
            <textarea
              value={draft.note ?? ''}
              onChange={(e) => set({ note: e.target.value || undefined })}
              rows={draft.type === 'note' ? 5 : 2}
              className={`${INPUT} resize-y`}
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted/50 text-foreground hover:bg-muted transition-colors">
            Cancel
          </button>
          <button onClick={save} className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
