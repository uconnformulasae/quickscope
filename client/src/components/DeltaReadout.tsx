/**
 * DeltaReadout — the Δ table for the two delta cursors, docked under the
 * chart so it never covers the traces.
 */
import { X } from 'lucide-react';
import type { DeltaRow } from '../lib/chart-cursors';

export function DeltaReadout({ deltaT, rows, onClose }: { deltaT: number; rows: DeltaRow[]; onClose: () => void }) {
  return (
    <div
      className="flex-shrink-0 border-t border-border bg-card flex items-start gap-4 px-3 py-1.5 max-h-36 overflow-y-auto"
      data-testid="delta-readout"
    >
      <div className="flex-shrink-0 pt-0.5 font-mono text-xs font-semibold text-cyan-400 tabular whitespace-nowrap">
        Δt = {deltaT.toFixed(3)}s
      </div>
      <table className="min-w-0 text-xs font-mono tabular">
        <thead className="sticky top-0 bg-card">
          <tr className="text-muted-foreground">
            <th className="text-left font-normal pr-4">Channel</th>
            <th className="text-right font-normal px-3">A</th>
            <th className="text-right font-normal px-3">B</th>
            <th className="text-right font-normal pl-3">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.channelId}>
              <td className="text-left font-semibold pr-4 truncate max-w-[16rem]" style={{ color: r.color }}>{r.label}</td>
              <td className="text-right text-foreground px-3">{r.valA}</td>
              <td className="text-right text-foreground px-3">{r.valB}</td>
              <td className="text-right font-semibold text-cyan-400 pl-3">{r.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={onClose}
        aria-label="Close delta measurement"
        title="Close delta measurement"
        className="ml-auto flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
