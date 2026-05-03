/**
 * DerivedChannelDialog — Create or edit a derived/computed channel.
 * Supports formula mode (math expression) and JavaScript mode (function body).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, FlaskConical, Code2, ChevronDown, ChevronUp, AlertCircle, CheckCircle2, Search } from 'lucide-react';
import type { DerivedChannel } from '../lib/useXRKStore';
import type { XRKSession } from '../lib/xrk-parser';

interface DerivedChannelDialogProps {
  session: XRKSession;
  editing?: DerivedChannel;
  onClose: () => void;
  onPreview: (def: Omit<DerivedChannel, 'id' | 'color'>) => Promise<{ timestamps: number[]; values: number[] } | string>;
  onSubmit: (def: Omit<DerivedChannel, 'id' | 'color'>) => Promise<{ error: string } | { id: number }>;
}

const FORMULA_EXAMPLES = [
  { label: 'Speed mph', expr: 'Spd1 * 0.621371' },
  { label: 'Total G', expr: 'sqrt(InlA^2 + LatA^2)' },
  { label: 'Brake diff', expr: 'RBRK - RBrP' },
  { label: 'Acceleration', expr: 'diff(Spd1) / 3.6' },
  { label: 'Smooth lat G', expr: 'smooth(LatA, 20)' },
  { label: 'Lat G 500ms MAVG', expr: 'MAVG(LatA, 500)' },
  { label: 'Energy Wh', expr: 'integral(VBAT * IBAT) / 3600' },
  { label: 'Distance m', expr: 'integral(Spd1) / 3.6' },
];

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
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
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

export function DerivedChannelDialog({
  session,
  editing,
  onClose,
  onPreview,
  onSubmit,
}: DerivedChannelDialogProps) {
  const [name, setName] = useState(editing?.name ?? '');
  const [units, setUnits] = useState(editing?.units ?? '');
  const [mode, setMode] = useState<'formula' | 'python'>(editing?.mode ?? 'formula');
  const [expression, setExpression] = useState(
    editing?.expression ?? (editing?.mode === 'python' ? PYTHON_TEMPLATE : '')
  );
  const [previewResult, setPreviewResult] = useState<{ timestamps: number[]; values: number[] } | string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showChannelList, setShowChannelList] = useState(false);
  const [channelSearch, setChannelSearch] = useState('');

  const [isEvaluating, setIsEvaluating] = useState(false);

  // When mode changes, set template if expression is empty
  const handleModeChange = (m: 'formula' | 'python') => {
    setMode(m);
    if (!expression.trim()) {
      setExpression(m === 'python' ? PYTHON_TEMPLATE : '');
    }
    setPreviewResult(null);
  };

  // Show every channel the device recorded data for, even if its samples
  // haven't been pulled to the client yet — useXRKStore lazy-fetches on
  // preview/submit when a formula references an unloaded channel.
  const channelNames = Array.from(session.channels.values())
    .filter(ch => (ch.fileSampleCount ?? 0) > 0)
    .map(ch => ch.shortName)
    .sort();

  const handlePreview = useCallback(async () => {
    if (!name.trim() || !expression.trim()) return;
    setIsEvaluating(true);
    try {
      const result = await onPreview({ name: name.trim(), units, mode, expression });
      setPreviewResult(result);
    } finally {
      setIsEvaluating(false);
    }
  }, [name, units, mode, expression, onPreview]);

  const handleSubmit = async () => {
    if (!name.trim()) { setSubmitError('Channel name is required'); return; }
    if (!expression.trim()) { setSubmitError('Expression is required'); return; }
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      data-backdrop="1"
      onClick={handleBackdrop}
    >
      <div
        className="relative w-[480px] max-h-[90vh] flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              {editing ? 'Edit Derived Channel' : 'Create Derived Channel'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Name + Units row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Channel Name *</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. SpeedMPH"
                className="w-full px-2.5 py-1.5 bg-muted/40 border border-border rounded text-xs text-foreground placeholder-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                data-testid="input-derived-name"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Units (optional)</label>
              <input
                type="text"
                value={units}
                onChange={e => setUnits(e.target.value)}
                placeholder="e.g. mph, g, bar"
                className="w-full px-2.5 py-1.5 bg-muted/40 border border-border rounded text-xs text-foreground placeholder-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                data-testid="input-derived-units"
              />
            </div>
          </div>

          {/* Mode toggle */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Expression Mode</label>
            <div className="flex gap-2">
              <button
                onClick={() => handleModeChange('formula')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border transition-colors ${
                  mode === 'formula'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40'
                }`}
                data-testid="btn-mode-formula"
              >
                <FlaskConical className="w-3 h-3" />
                Formula
              </button>
              <button
                onClick={() => handleModeChange('python')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border transition-colors ${
                  mode === 'python'
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40'
                }`}
                data-testid="btn-mode-python"
              >
                <Code2 className="w-3 h-3" />
                Python
              </button>
            </div>
          </div>

          {/* Formula examples */}
          {mode === 'formula' && (
            <div className="flex flex-wrap gap-1.5">
              {FORMULA_EXAMPLES.map(ex => (
                <button
                  key={ex.label}
                  onClick={() => setExpression(ex.expr)}
                  className="px-2 py-0.5 rounded bg-muted/40 border border-border/60 text-xs text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition-colors"
                  title={ex.expr}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          )}

          {/* Expression input */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              {mode === 'formula' ? 'Math Expression' : 'Python Script'}
            </label>
            <textarea
              value={expression}
              onChange={e => setExpression(e.target.value)}
              rows={mode === 'python' ? 8 : 3}
              placeholder={
                mode === 'formula'
                  ? 'e.g. Spd1 * 0.621371'
                  : "result = {'timestamps': [...], 'values': [...]}"
              }
              className="w-full px-2.5 py-2 bg-background border border-border rounded text-xs text-foreground placeholder-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary font-mono resize-y leading-relaxed"
              spellCheck={false}
              data-testid="textarea-expression"
            />
            {mode === 'formula' && (
              <p className="mt-1 text-xs text-muted-foreground/60">
                Use channel names as variables. Operators: +, −, ×, ÷, ^ (power), &nbsp;&amp; | &lt;&lt; &gt;&gt; ~ (bitwise). Functions: abs, sqrt, sin, cos, log, exp, diff, derivative, derivative2, integral, smooth, mavg, delay, xor.
              </p>
            )}
            {mode === 'python' && (
              <div className="mt-2 space-y-2 text-xs text-muted-foreground/70 bg-muted/20 border border-border/40 rounded p-2.5">
                <p className="text-muted-foreground font-medium">Your script receives:</p>
                <ul className="space-y-1.5 ml-1">
                  <li>
                    <code className="text-primary/80">channels</code> — dict of all channel data.
                    Access like <code className="text-primary/80">channels['Spd1']</code>,
                    each is <code className="text-primary/80">{'{"timestamps": [...], "values": [...]}'}</code>
                  </li>
                  <li>
                    <code className="text-primary/80">np</code> — numpy, for array math
                  </li>
                  <li>
                    <code className="text-primary/80">math</code> — Python math module
                  </li>
                  <li>
                    <code className="text-primary/80">interpolate(ch, t)</code> — get a channel's value at timestamp <code className="text-primary/80">t</code>.
                    Useful when channels have different sample rates
                  </li>
                </ul>
                <p className="text-muted-foreground font-medium pt-1 border-t border-border/30">
                  Must assign: <code className="text-primary/80">{"result = {'timestamps': [...], 'values': [...]}"}</code>
                </p>
              </div>
            )}
          </div>

          {/* Available channels */}
          <div>
            <button
              onClick={() => setShowChannelList(v => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showChannelList ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Available channels {(() => {
                const q = channelSearch.trim().toLowerCase();
                const filtered = q ? channelNames.filter(n => n.toLowerCase().includes(q)) : channelNames;
                return q ? `(${filtered.length}/${channelNames.length})` : `(${channelNames.length})`;
              })()}
            </button>
            {showChannelList && (() => {
              const q = channelSearch.trim().toLowerCase();
              const filtered = q ? channelNames.filter(n => n.toLowerCase().includes(q)) : channelNames;
              return (
                <div className="mt-2 space-y-2">
                  <div className="relative">
                    <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
                    <input
                      type="text"
                      value={channelSearch}
                      onChange={e => setChannelSearch(e.target.value)}
                      placeholder="Search channels..."
                      className="w-full pl-7 pr-2 py-1 bg-muted/40 border border-border rounded text-xs text-foreground placeholder-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                      data-testid="input-channel-search"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-2 bg-muted/20 rounded border border-border/40">
                    {filtered.length === 0 ? (
                      <span className="text-xs text-muted-foreground/60 italic">No channels match "{channelSearch}"</span>
                    ) : filtered.map(n => (
                      <button
                        key={n}
                        onClick={() => {
                          // Insert at cursor or append
                          setExpression(prev => prev ? prev + ' ' + n : n);
                        }}
                        className="px-1.5 py-0.5 rounded bg-muted/60 text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Preview button + result */}
          <div className="space-y-2">
            <button
              onClick={handlePreview}
              disabled={!name.trim() || !expression.trim() || isEvaluating}
              className="w-full py-1.5 rounded text-xs border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              data-testid="btn-preview"
            >
              {isEvaluating ? 'Evaluating...' : 'Preview'}
            </button>

            {previewResult !== null && (
              <div>
                {typeof previewResult === 'string' ? (
                  <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span className="font-mono">{previewResult}</span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-xs text-green-400">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{previewResult.values.length.toLocaleString()} samples computed</span>
                    </div>
                    <MiniPreviewChart
                      timestamps={previewResult.timestamps}
                      values={previewResult.values}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Submit error */}
          {submitError && (
            <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="font-mono">{submitError}</span>
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
