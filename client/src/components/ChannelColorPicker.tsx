import { useEffect, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { CHANNEL_PALETTE, type Theme } from '../lib/channelColors';

/** Inline colour chooser shown under a channel row (palette for the current
 *  theme, custom colour, reset). */
export function ChannelColorPicker({ name, theme, current, custom, onPick, onReset, onClose }: {
  name: string;
  theme: Theme;
  current: string;
  /** A custom colour is set for this theme. */
  custom: boolean;
  onPick: (hex: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${name} colour`}
      className="mx-2 mb-1.5 rounded-md border border-border bg-popover p-2 shadow-sm"
    >
      <div className="grid grid-cols-6 gap-1.5">
        {CHANNEL_PALETTE[theme].map(hex => (
          <button
            key={hex}
            type="button"
            aria-label={hex}
            onClick={() => onPick(hex)}
            className={`h-5 rounded-sm border ${hex.toLowerCase() === current.toLowerCase() ? 'ring-2 ring-primary ring-offset-1 ring-offset-popover border-transparent' : 'border-border/60'}`}
            style={{ background: hex }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5 cursor-pointer">
          Custom
          <input type="color" value={current} onChange={e => onPick(e.target.value)} aria-label={`${name} custom colour`} className="h-5 w-7 cursor-pointer bg-transparent" />
        </label>
        <button
          type="button"
          onClick={onReset}
          disabled={!custom}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="w-3 h-3" /> Reset to default
        </button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">Applies to the {theme} theme.</p>
    </div>
  );
}
