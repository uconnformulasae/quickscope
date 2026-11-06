/**
 * DerivedChannelDialog — Create or edit a derived/computed channel.
 *
 * Formula mode is built for people who don't know the logger's channel codes:
 * recipes (filtered to what this log contains) fill in a formula, channels
 * show by plain-English name, and the preview updates as you type. Formulas
 * are still saved with raw codes. Python (backend sandbox) sits behind an
 * "Advanced" link.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, FlaskConical, Code2, ChevronDown, ChevronUp, AlertCircle, CheckCircle2, Search, Pencil, BookOpen } from 'lucide-react';
import type { DerivedChannel } from '../lib/useXRKStore';
import type { XRKSession } from '../lib/xrk-parser';
import { describeChannel, inferCarType, type ChannelCategory, type ChannelInfo } from '../lib/channel-dictionary';
import { checkFormula, FUNCTION_HELP } from '../lib/formula-engine';
import { buildLabelIndex } from '../lib/formula-text';
import { availableRecipes, prefillSlots, type Recipe } from '../lib/formula-recipes';
import { usePreferences } from '../lib/usePreferences';
import { FormulaInput, type FormulaInputHandle } from './formula/FormulaInput';

interface DerivedChannelDialogProps {
  session: XRKSession;
  editing?: DerivedChannel;
  /** The user's other derived channels; formulas can use them too. */
  derivedChannels?: DerivedChannel[];
  onClose: () => void;
  onPreview: (def: Omit<DerivedChannel, 'id' | 'color'>) => Promise<{ timestamps: number[]; values: number[] } | string>;
  onSubmit: (def: Omit<DerivedChannel, 'id' | 'color'>) => Promise<{ error: string } | { id: number }>;
}

const PYTHON_TEMPLATE = `# Example: Power = Voltage * Current
# Available: channels (dict), np (numpy), math, interpolate(ch, t)
# Must assign result = { 'timestamps': [...], 'values': [...] }

v = channels.get('VBAT')
i = channels.get('IBAT')
if not v or not i:
    result = {'timestamps': [], 'values': []}
else:
    ts = v['timestamps']
    vals = [v['values'][idx] * interpolate(i, t) for idx, t in enumerate(ts)]
    result = {'timestamps': ts, 'values': vals}`;

const PREVIEW_DEBOUNCE_MS = 300;

const CATEGORY_ORDER: ChannelCategory[] = [
  'Your Channels', 'Driver Inputs', 'Brakes', 'Wheels & Speed', 'Chassis & IMU', 'GPS', 'Battery', 'Motor & Inverter',
  'Engine', 'Fuel', 'Temperatures', 'Status', 'Faults & Alarms', 'Logger', 'Other',
];

const FIELD = 'w-full px-2.5 py-1.5 bg-muted/40 border border-border rounded text-xs text-foreground placeholder-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary';

function MiniPreviewChart({
  timestamps,
  values,
}: {
  timestamps: number[];
  values: number[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || timestamps.length < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const minT = timestamps[0];
    const maxT = timestamps[timestamps.length - 1];
    // Loop instead of Math.min(...values): spreading large arrays overflows the call stack
    let minV = Infinity;
    let maxV = -Infinity;
    for (const v of values) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const rangeV = maxV - minV || 1;
    const rangeT = maxT - minT || 1;

    const toX = (t: number) => ((t - minT) / rangeT) * (W - 2) + 1;
    const toY = (v: number) => H - 1 - ((v - minV) / rangeV) * (H - 2);

    ctx.beginPath();
    ctx.strokeStyle = '#4361ee';
    ctx.lineWidth = 1.5;
    ctx.moveTo(toX(timestamps[0]), toY(values[0]));
    // Downsample to at most 500 points for drawing
    const step = Math.ceil(timestamps.length / 500);
    for (let i = 1; i < timestamps.length; i += step) {
      ctx.lineTo(toX(timestamps[i]), toY(values[i]));
    }
    ctx.stroke();

    // Draw axis labels
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-text').trim();
    ctx.fillStyle = textColor;
    ctx.font = '9px monospace';
    ctx.fillText(minV.toFixed(2), 2, H - 2);
    ctx.fillText(maxV.toFixed(2), 2, 10);
  }, [timestamps, values]);

  if (timestamps.length < 2) {
    return (
      <div className="h-20 flex items-center justify-center text-xs text-muted-foreground border border-border/50 rounded">
        No preview data
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      width={320}
      height={80}
      className="w-full rounded border border-border/50 bg-background"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

type PreviewResult = { timestamps: number[]; values: number[] } | string | null;

function PreviewPanel({ result }: { result: PreviewResult }) {
  if (result === null) return null;
  if (typeof result === 'string') {
    return (
      <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span>{result}</span>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-green-400">
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>{result.values.length.toLocaleString()} samples computed</span>
      </div>
      <MiniPreviewChart timestamps={result.timestamps} values={result.values} />
    </div>
  );
}

export function DerivedChannelDialog({
  session,
  editing,
  derivedChannels = [],
  onClose,
  onPreview,
  onSubmit,
}: DerivedChannelDialogProps) {
  const { prefs, update } = usePreferences();
  const [name, setName] = useState(editing?.name ?? '');
  const [units, setUnits] = useState(editing?.units ?? '');
  const [mode, setMode] = useState<'formula' | 'python'>(editing?.mode ?? 'formula');
  const [expression, setExpression] = useState(
    editing?.expression ?? (editing?.mode === 'python' ? PYTHON_TEMPLATE : '')
  );
  const [previewResult, setPreviewResult] = useState<PreviewResult>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showChannelList, setShowChannelList] = useState(false);
  const [showFunctions, setShowFunctions] = useState(false);
  const [channelSearch, setChannelSearch] = useState('');
  const [showCodes, setShowCodes] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  // Local copy so a rename shows immediately even without a preferences provider.
  const [labels, setLabels] = useState<Record<string, string>>(prefs.channelLabels);
  const [renaming, setRenaming] = useState<{ code: string; value: string } | null>(null);

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [detached, setDetached] = useState(false);
  // Name/units the recipe last filled in; a field still holding these may be overwritten.
  const autoFilled = useRef({ name: '', units: '' });
  const formulaRef = useRef<FormulaInputHandle>(null);

  // ── Channels available to formulas ──────────────────────────────────────
  // Every channel the device recorded data for, even if its samples haven't
  // been pulled to the client yet — useXRKStore lazy-fetches on preview/submit.
  const sessionCodes = useMemo(() => Array.from(session.channels.values())
    .filter(ch => (ch.fileSampleCount ?? 0) > 0)
    .map(ch => ch.shortName), [session]);
  const unitsByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const ch of session.channels.values()) if (ch.units) m.set(ch.shortName, ch.units);
    for (const dc of derivedChannels) if (dc.units) m.set(dc.name, dc.units);
    return m;
  }, [session, derivedChannels]);
  const otherDerived = useMemo(
    () => derivedChannels.filter(dc => dc.id !== editing?.id && !sessionCodes.includes(dc.name)),
    [derivedChannels, editing, sessionCodes],
  );
  const car = useMemo(() => inferCarType(sessionCodes, session.metadata?.vehicle), [sessionCodes, session]);

  const channels = useMemo<ChannelInfo[]>(() => [
    ...sessionCodes.map(code => describeChannel(code, car, labels)),
    ...otherDerived.map(dc => ({
      code: dc.name, label: labels[dc.name]?.trim() || dc.name, description: 'A channel you created',
      category: 'Your Channels' as const, known: true,
    })),
  ], [sessionCodes, otherDerived, car, labels]);
  const infoByCode = useMemo(() => new Map(channels.map(c => [c.code, c])), [channels]);
  const labelIndex = useMemo(
    () => buildLabelIndex(channels.map(c => c.code), code => infoByCode.get(code) ?? describeChannel(code, car, labels)),
    [channels, infoByCode, car, labels],
  );
  const sortedChannels = useMemo(
    () => [...channels].sort((a, b) => labelIndex.labelOf(a.code).localeCompare(labelIndex.labelOf(b.code))),
    [channels, labelIndex],
  );
  const recipes = useMemo(() => availableRecipes(channels), [channels]);

  const problem = mode === 'formula' && expression.trim()
    ? checkFormula(expression, code => infoByCode.has(code))
    : null;

  // ── Recipes ─────────────────────────────────────────────────────────────
  const applyRecipe = (r: Recipe, values: Record<string, string>) => {
    const out = r.build(values, labelIndex.labelOf);
    setExpression(out.expression);
    if (!name.trim() || name === autoFilled.current.name) setName(out.name);
    if (!units.trim() || units === autoFilled.current.units) setUnits(out.units);
    autoFilled.current = { name: out.name, units: out.units };
    setDetached(false);
  };

  const chooseRecipe = (r: Recipe) => {
    const values = prefillSlots(r, channels);
    setRecipe(r);
    setSlots(values);
    applyRecipe(r, values);
  };

  const setSlot = (key: string, value: string) => {
    if (!recipe) return;
    const values = { ...slots, [key]: value };
    setSlots(values);
    applyRecipe(recipe, values);
  };

  const handleFormulaChange = (stored: string) => {
    setExpression(stored);
    if (recipe) setDetached(true);
  };

  // ── Mode switching ──────────────────────────────────────────────────────
  const handleModeChange = (m: 'formula' | 'python') => {
    setMode(m);
    if (m === 'python' && !expression.trim()) setExpression(PYTHON_TEMPLATE);
    if (m === 'formula' && expression === PYTHON_TEMPLATE) setExpression('');
    setPreviewResult(null);
  };

  // ── Preview ─────────────────────────────────────────────────────────────
  const previewSeq = useRef(0);
  const runPreview = useCallback(async () => {
    const seq = ++previewSeq.current;
    setIsEvaluating(true);
    try {
      const result = await onPreview({ name: name.trim() || 'Preview', units, mode, expression });
      if (seq === previewSeq.current) setPreviewResult(result);
    } finally {
      if (seq === previewSeq.current) setIsEvaluating(false);
    }
  }, [name, units, mode, expression, onPreview]);

  // Formula mode previews by itself whenever the formula is valid.
  const canAutoPreview = mode === 'formula' && expression.trim() !== '' && problem === null;
  useEffect(() => {
    if (!canAutoPreview) {
      previewSeq.current++;
      if (mode === 'formula') setPreviewResult(null);
      return;
    }
    const t = setTimeout(() => { void runPreview(); }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // Re-run only when the formula itself changes, not on name/units edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoPreview, expression, mode]);

  // ── Renaming ────────────────────────────────────────────────────────────
  const saveRename = () => {
    if (!renaming) return;
    const next = { ...labels };
    const v = renaming.value.trim();
    if (v) next[renaming.code] = v; else delete next[renaming.code];
    setLabels(next);
    update({ channelLabels: next });
    setRenaming(null);
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setSubmitError('Channel name is required'); return; }
    if (!expression.trim()) { setSubmitError('Formula is required'); return; }
    setSubmitError(null);
    setIsEvaluating(true);

    try {
      const result = await onSubmit({ name: name.trim(), units, mode, expression });
      if ('error' in result) {
        setSubmitError(result.error);
      } else {
        onClose();
      }
    } finally {
      setIsEvaluating(false);
    }
  };

  // Backdrop click closes
  const handleBackdrop = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.backdrop) onClose();
  };

  // ── Channel browser (grouped, searchable) ───────────────────────────────
  const q = channelSearch.trim().toLowerCase();
  const filtered = q
    ? sortedChannels.filter(c => [labelIndex.labelOf(c.code), c.code, c.description, c.category].some(s => s.toLowerCase().includes(q)))
    : sortedChannels;
  const groups = CATEGORY_ORDER
    .map(cat => ({ cat, items: filtered.filter(c => c.category === cat) }))
    .filter(g => g.items.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center qs-scrim"
      data-backdrop="1"
      onClick={handleBackdrop}
    >
      <div
        className="qs-dialog relative w-[520px] max-w-[calc(100vw-32px)] max-h-[90vh] flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-primary-text" />
            <h2 className="text-sm font-semibold text-foreground">
              {editing ? 'Edit Derived Channel' : 'Create Derived Channel'}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {mode === 'formula' ? (
            <>
              {/* Recipes */}
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Start from a recipe</p>
                <div className="flex flex-wrap gap-1.5">
                  {recipes.map(r => (
                    <button
                      key={r.id}
                      onClick={() => chooseRecipe(r)}
                      title={r.blurb}
                      className={`px-2 py-1 rounded border text-xs transition-colors ${
                        recipe?.id === r.id
                          ? 'border-primary bg-primary/15 text-foreground'
                          : 'bg-muted/40 border-border/60 text-muted-foreground hover:text-foreground hover:border-muted-foreground/40'
                      }`}
                    >
                      {r.title}
                    </button>
                  ))}
                </div>
              </div>

              {/* Recipe slots */}
              {recipe && (
                <div className="space-y-2 p-2.5 rounded border border-border/60 bg-muted/20">
                  <p className="text-xs text-muted-foreground">{recipe.blurb}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {recipe.slots.map(slot => {
                      const id = `recipe-slot-${slot.key}`;
                      return (
                        <div key={slot.key}>
                          <label htmlFor={id} className="block text-[11px] text-muted-foreground mb-0.5">{slot.label}</label>
                          {slot.kind === 'channel' && (
                            <select id={id} value={slots[slot.key] ?? ''} disabled={detached}
                              onChange={e => setSlot(slot.key, e.target.value)} className={`${FIELD} disabled:opacity-50`}>
                              <option value="">Choose a channel…</option>
                              {sortedChannels.map(c => (
                                <option key={c.code} value={c.code}>{labelIndex.labelOf(c.code)}</option>
                              ))}
                            </select>
                          )}
                          {slot.kind === 'choice' && (
                            <select id={id} value={slots[slot.key] ?? slot.default} disabled={detached}
                              onChange={e => setSlot(slot.key, e.target.value)} className={`${FIELD} disabled:opacity-50`}>
                              {slot.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          )}
                          {slot.kind === 'number' && (
                            <div className="flex items-center gap-1">
                              <input id={id} type="number" min={1} value={slots[slot.key] ?? String(slot.default)} disabled={detached}
                                onChange={e => setSlot(slot.key, e.target.value)} className={`${FIELD} disabled:opacity-50`} />
                              <span className="text-xs text-muted-foreground">{slot.unit}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {detached && (
                    <p className="text-xs text-muted-foreground">
                      You've edited the formula by hand.{' '}
                      <button onClick={() => applyRecipe(recipe, slots)} className="text-primary-text hover:underline">
                        Start over from recipe
                      </button>
                    </p>
                  )}
                </div>
              )}

              {/* Formula */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-muted-foreground">Formula</label>
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer select-none">
                    <input type="checkbox" checked={showCodes} onChange={e => setShowCodes(e.target.checked)} className="accent-primary" />
                    Show codes
                  </label>
                </div>
                <FormulaInput
                  ref={formulaRef}
                  value={expression}
                  onChange={handleFormulaChange}
                  channels={channels}
                  labelIndex={labelIndex}
                  showCodes={showCodes}
                  unitsOf={code => unitsByCode.get(code) ?? ''}
                  placeholder="Type a channel name, e.g. brake, speed, battery…"
                  testId="textarea-expression"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Type any word to find a channel. Use + − * / and ^ (power) between them.
                </p>
              </div>

              {/* Channel browser */}
              <div>
                <button
                  onClick={() => setShowChannelList(v => !v)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showChannelList ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  Browse channels {q ? `(${filtered.length}/${channels.length})` : `(${channels.length})`}
                </button>
                {showChannelList && (
                  <div className="mt-2 space-y-2">
                    <div className="relative">
                      <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                      <input
                        type="text"
                        value={channelSearch}
                        onChange={e => setChannelSearch(e.target.value)}
                        placeholder="Search channels…"
                        className="w-full pl-7 pr-2 py-1 bg-muted/40 border border-border rounded text-xs text-foreground placeholder-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                        data-testid="input-channel-search"
                      />
                    </div>
                    <div className="max-h-56 overflow-y-auto rounded border border-border/40 bg-muted/20" data-testid="channel-browser">
                      {groups.length === 0 ? (
                        <p className="p-2 text-xs text-muted-foreground italic">No channels match "{channelSearch}"</p>
                      ) : groups.map(g => (
                        <div key={g.cat}>
                          <p className="sticky top-0 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground bg-card/95">{g.cat}</p>
                          {g.items.map(c => {
                            const label = labelIndex.labelOf(c.code);
                            return renaming?.code === c.code ? (
                              <div key={c.code} className="px-2 py-1 flex items-center gap-1.5">
                                <input
                                  autoFocus
                                  value={renaming.value}
                                  onChange={e => setRenaming({ code: c.code, value: e.target.value })}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') saveRename();
                                    if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
                                  }}
                                  onBlur={saveRename}
                                  placeholder={describeChannel(c.code, car).label}
                                  className={FIELD}
                                  data-testid="input-rename-channel"
                                />
                                <span className="font-mono text-[10px] text-muted-foreground shrink-0">{c.code}</span>
                              </div>
                            ) : (
                              <div key={c.code} className="group flex items-center gap-1.5 px-2 py-1 hover:bg-muted/60">
                                <button
                                  onClick={() => formulaRef.current?.insertChannel(c.code)}
                                  title={c.description || c.code}
                                  className="flex-1 min-w-0 flex items-baseline gap-2 text-left text-xs"
                                >
                                  <span className="text-foreground truncate">{label}</span>
                                  {c.uncertain && (
                                    <span className="text-amber-400" title="We're not sure what this channel is. Rename it if you know.">?</span>
                                  )}
                                  <span className="ml-auto font-mono text-[10px] text-muted-foreground shrink-0">
                                    {c.code}{unitsByCode.get(c.code) ? ` · ${unitsByCode.get(c.code)}` : ''}
                                  </span>
                                </button>
                                {c.category !== 'Your Channels' && (
                                  <button
                                    aria-label={`Rename ${label}`}
                                    title="Rename"
                                    onClick={() => setRenaming({ code: c.code, value: labels[c.code] ?? '' })}
                                    className="p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-foreground"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Function reference */}
              <div>
                <button
                  onClick={() => setShowFunctions(v => !v)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <BookOpen className="w-3 h-3" />
                  Functions
                  {showFunctions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {showFunctions && (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs p-2 rounded border border-border/40 bg-muted/20">
                    {FUNCTION_HELP.map(f => (
                      <div key={f.name} className="contents">
                        <dt className="font-mono text-primary-text">{f.signature}</dt>
                        <dd className="text-muted-foreground">{f.description}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>

              {/* Live preview */}
              <PreviewPanel result={previewResult} />
            </>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Code2 className="w-3 h-3" /> Python Script
                </label>
                <button onClick={() => handleModeChange('formula')} className="text-xs text-primary-text hover:underline" data-testid="btn-mode-formula">
                  Back to formula
                </button>
              </div>
              <textarea
                value={expression}
                onChange={e => setExpression(e.target.value)}
                rows={8}
                placeholder="result = {'timestamps': [...], 'values': [...]}"
                className="w-full px-2.5 py-2 bg-background border border-border rounded text-xs text-foreground placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary font-mono resize-y leading-relaxed"
                spellCheck={false}
                data-testid="textarea-expression"
              />
              <div className="mt-2 space-y-2 text-xs text-muted-foreground bg-muted/20 border border-border/40 rounded p-2.5">
                <p className="text-muted-foreground font-medium">Your script receives:</p>
                <ul className="space-y-1.5 ml-1">
                  <li>
                    <code className="text-primary-text/80">channels</code> — dict of all channel data.
                    Access like <code className="text-primary-text/80">channels['Pack_Voltage']</code>,
                    each is <code className="text-primary-text/80">{'{"timestamps": [...], "values": [...]}'}</code>
                  </li>
                  <li><code className="text-primary-text/80">np</code> — numpy, for array math</li>
                  <li><code className="text-primary-text/80">math</code> — Python math module</li>
                  <li>
                    <code className="text-primary-text/80">interpolate(ch, t)</code> — get a channel's value at timestamp <code className="text-primary-text/80">t</code>.
                    Useful when channels have different sample rates
                  </li>
                </ul>
                <p className="text-muted-foreground font-medium pt-1 border-t border-border/30">
                  Must assign: <code className="text-primary-text/80">{"result = {'timestamps': [...], 'values': [...]}"}</code>
                </p>
              </div>
              <div className="mt-3 space-y-2">
                <button
                  onClick={() => void runPreview()}
                  disabled={!expression.trim() || isEvaluating}
                  className="w-full py-1.5 rounded text-xs border border-primary/50 text-primary-text hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  data-testid="btn-preview"
                >
                  {isEvaluating ? 'Evaluating...' : 'Preview'}
                </button>
                <PreviewPanel result={previewResult} />
              </div>
            </div>
          )}

          {/* Name + Units row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="derived-name" className="block text-xs text-muted-foreground mb-1">Channel Name *</label>
              <input
                id="derived-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Battery Power"
                className={FIELD}
                data-testid="input-derived-name"
              />
            </div>
            <div>
              <label htmlFor="derived-units" className="block text-xs text-muted-foreground mb-1">Units (optional)</label>
              <input
                id="derived-units"
                type="text"
                value={units}
                onChange={e => setUnits(e.target.value)}
                placeholder="e.g. mph, g, kW"
                className={FIELD}
                data-testid="input-derived-units"
              />
            </div>
          </div>

          {mode === 'formula' && (
            <button onClick={() => handleModeChange('python')} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground" data-testid="btn-mode-python">
              <Code2 className="w-3 h-3" /> Advanced: write Python instead
            </button>
          )}

          {/* Submit error */}
          {submitError && (
            <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground border border-border hover:border-muted-foreground/40 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !expression.trim() || isEvaluating}
            className="px-4 py-1.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
            data-testid="btn-create-derived"
          >
            {isEvaluating ? 'Evaluating...' : (editing ? 'Update Channel' : 'Create Channel')}
          </button>
        </div>
      </div>
    </div>
  );
}
