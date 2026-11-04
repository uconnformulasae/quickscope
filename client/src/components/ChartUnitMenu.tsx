import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';

export interface UnitMenuChannel {
  shortName: string;
  rawUnit: string;
}

interface ChartUnitMenuProps {
  /** Channels the choice applies to (one strip, or one overlay unit axis). */
  channels: UnitMenuChannel[];
  /** Units the channels can be shown in ([] = not convertible). */
  options: string[];
  /** Unit currently displayed. */
  current: string;
  /** Unit the global unit system would pick (the "Default" entry). */
  defaultUnit: string;
  /** Whether a per-channel override is active. */
  overridden: boolean;
  x: number;
  y: number;
  onPick: (unit: string | null) => void; // null = back to default
  onClose: () => void;
}

/** Popover opened by clicking a channel's label/axis on the chart. */
export function ChartUnitMenu({ channels, options, current, defaultUnit, overridden, x, y, onPick, onClose }: ChartUnitMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const title = channels.map(c => c.shortName).join(', ');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    // Defer so the click that opened the menu doesn't close it.
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const item = 'w-full flex items-center gap-2 px-2.5 py-1 text-left text-xs rounded hover:bg-muted/60';

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${title} units`}
      className="absolute z-20 min-w-[140px] max-w-[240px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1"
      style={{ left: x, top: y }}
    >
      <div className="px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground truncate" title={title}>
        {title} · units
      </div>
      {options.length === 0 ? (
        <div className="px-2.5 pb-1.5 text-xs text-muted-foreground">No other units</div>
      ) : (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!overridden}
            className={item}
            onClick={() => onPick(null)}
          >
            <Check className={`w-3 h-3 ${!overridden ? '' : 'invisible'}`} />
            Default ({defaultUnit})
          </button>
          {options.map(u => {
            const checked = overridden && u === current;
            return (
              <button key={u} type="button" role="menuitemradio" aria-checked={checked} className={item} onClick={() => onPick(u)}>
                <Check className={`w-3 h-3 ${checked ? '' : 'invisible'}`} />
                {u}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
