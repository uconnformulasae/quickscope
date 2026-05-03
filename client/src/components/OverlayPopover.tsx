// Stub — full implementation lands in Task 5.3 of the overlay plan.
import { useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import type { OverlayState, OverlayAlignment } from '../lib/overlay-types';
import type { XRKSession } from '../lib/xrk-parser';
import { fastestLapIndex } from '../lib/overlay-alignment';

interface Props {
  primary: XRKSession;
  overlays: OverlayState[];
  onRemove: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onUpdateAlignment: (id: string, alignment: OverlayAlignment) => void;
  onClose: () => void;
}

export function OverlayPopover({
  primary, overlays, onRemove, onToggleVisible, onUpdateAlignment, onClose,
}: Props) {
  const primaryLapCount = Math.max(0, primary.lapMarkers.length - 1);
  const showPerfWarning = overlays.length > 3;

  return (
    <div
      className="absolute right-2 top-10 w-[420px] max-h-[500px] overflow-y-auto bg-card border border-border rounded-lg shadow-lg z-20"
      data-testid="overlay-popover"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-sm font-semibold">Overlays ({overlays.length})</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" data-testid="overlay-popover-close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {showPerfWarning && (
        <div className="px-3 py-1.5 text-xs bg-amber-500/10 text-amber-700 dark:text-amber-300 border-b border-amber-500/30">
          Past 3 overlays the chart may slow down. Hide some to recover frame rate.
        </div>
      )}

      {overlays.length === 0 && (
        <p className="px-3 py-4 text-xs text-muted-foreground">No overlays loaded. Multi-select sessions in the browser to add.</p>
      )}

      <ul>
        {overlays.map((ov, i) => {
          const ovLapCount = Math.max(0, ov.session.lapMarkers.length - 1);
          return (
            <li key={ov.id} className="px-3 py-2 border-b border-border/50 last:border-b-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-mono text-foreground">#{i + 1} {ov.label}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onToggleVisible(ov.id)}
                    className="text-muted-foreground hover:text-foreground"
                    title={ov.visible ? 'Hide' : 'Show'}
                  >
                    {ov.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => onRemove(ov.id)}
                    className="text-muted-foreground hover:text-red-500"
                    title="Remove overlay"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <AlignmentControls
                primary={primary}
                overlay={ov.session}
                primaryLapCount={primaryLapCount}
                overlayLapCount={ovLapCount}
                alignment={ov.alignment}
                onChange={(a) => onUpdateAlignment(ov.id, a)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AlignmentControls({
  primary, overlay, primaryLapCount, overlayLapCount, alignment, onChange,
}: {
  primary: XRKSession;
  overlay: XRKSession;
  primaryLapCount: number;
  overlayLapCount: number;
  alignment: OverlayAlignment;
  onChange: (a: OverlayAlignment) => void;
}) {
  const [manualMs, setManualMs] = useState(alignment.kind === 'manual' ? alignment.offsetMs : 0);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-muted-foreground w-14">Align:</label>
        <select
          value={alignment.kind}
          onChange={(e) => {
            const k = e.target.value as 'raw' | 'lap' | 'manual';
            if (k === 'raw') onChange({ kind: 'raw' });
            else if (k === 'manual') onChange({ kind: 'manual', offsetMs: manualMs });
            else {
              const p = fastestLapIndex(primary.lapMarkers);
              const o = fastestLapIndex(overlay.lapMarkers);
              onChange({ kind: 'lap', primaryLap: p === -1 ? 0 : p, overlayLap: o === -1 ? 0 : o });
            }
          }}
          className="text-xs bg-background border border-border rounded px-1.5 py-0.5 flex-1"
        >
          <option value="raw">Raw (t=0 = t=0)</option>
          <option value="lap" disabled={primaryLapCount === 0 || overlayLapCount === 0}>
            By lap (primary lap N vs overlay lap M)
          </option>
          <option value="manual">Manual offset (ms)</option>
        </select>
      </div>
      {alignment.kind === 'lap' && (
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-muted-foreground w-14">Lap:</label>
          <select
            value={alignment.primaryLap}
            onChange={(e) => onChange({ ...alignment, primaryLap: parseInt(e.target.value, 10) })}
            className="text-xs bg-background border border-border rounded px-1 py-0.5"
          >
            {Array.from({ length: primaryLapCount }, (_, i) => (
              <option key={i} value={i}>Primary L{i + 1}</option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">vs</span>
          <select
            value={alignment.overlayLap}
            onChange={(e) => onChange({ ...alignment, overlayLap: parseInt(e.target.value, 10) })}
            className="text-xs bg-background border border-border rounded px-1 py-0.5"
          >
            {Array.from({ length: overlayLapCount }, (_, i) => (
              <option key={i} value={i}>Overlay L{i + 1}</option>
            ))}
          </select>
        </div>
      )}
      {alignment.kind === 'manual' && (
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-muted-foreground w-14">Offset:</label>
          <input
            type="number"
            value={manualMs}
            step={10}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10) || 0;
              setManualMs(v);
              onChange({ kind: 'manual', offsetMs: v });
            }}
            className="text-xs bg-background border border-border rounded px-1.5 py-0.5 w-24 tabular"
          />
          <span className="text-[10px] text-muted-foreground">ms</span>
        </div>
      )}
    </div>
  );
}
