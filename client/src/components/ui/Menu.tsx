import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import { IconButton } from './Button';
import { useDismiss } from './useDismiss';

export type MenuEntry =
  | { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | 'separator';

export const Menu = forwardRef<
  HTMLDivElement,
  {
    items: MenuEntry[];
    onClose: () => void;
    className?: string;
    style?: CSSProperties;
    /** Element whose outside-mousedown dismisses the menu (defaults to the menu itself). */
    dismissRef?: RefObject<HTMLElement | null>;
  }
>(function Menu({ items, onClose, className = '', style, dismissRef }, fwd) {
  const own = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (i: number) => {
    const it = items[i];
    return !!it && it !== 'separator' && !it.disabled;
  };
  const firstEnabled = items.findIndex((_, i) => enabled(i));
  const [hl, setHl] = useState(firstEnabled);
  useDismiss(dismissRef ?? own, onClose);

  useEffect(() => {
    if (hl >= 0) itemRefs.current[hl]?.focus();
  }, [hl]);

  const move = (dir: 1 | -1) => {
    if (firstEnabled < 0) return;
    let i = hl;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (enabled(i)) {
        setHl(i);
        return;
      }
    }
  };

  const select = (i: number) => {
    const it = items[i];
    if (!it || it === 'separator' || it.disabled) return;
    it.onSelect();
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      select(hl);
    }
  };

  return (
    <div
      ref={(el) => {
        own.current = el;
        if (typeof fwd === 'function') fwd(el);
        else if (fwd) fwd.current = el;
      }}
      role="menu"
      onKeyDown={onKeyDown}
      className={`z-40 min-w-[180px] rounded-[10px] bg-popover p-[5px] shadow-xl ring-1 ring-border ${className}`}
      style={style}
    >
      {items.map((it, i) => {
        if (it === 'separator') {
          return <div key={`sep-${i}`} role="separator" className="mx-2 my-1 h-px bg-separator" />;
        }
        const Icon = it.icon;
        const lit = hl === i && !it.disabled;
        return (
          <button
            key={`${it.label}-${i}`}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={it.disabled || undefined}
            onMouseEnter={() => enabled(i) && setHl(i)}
            onClick={() => select(i)}
            className={`flex w-full items-center gap-[9px] rounded-[5px] px-[9px] py-[5px] text-left text-[13px] outline-none ${
              it.disabled
                ? 'cursor-not-allowed text-label-4'
                : lit
                  ? 'bg-primary text-white'
                  : it.danger
                    ? 'text-danger'
                    : 'text-foreground'
            }`}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            <span className="flex-1">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
});

export function MenuButton({
  label,
  icon,
  items,
  align = 'left',
}: {
  label: string;
  icon: ReactNode;
  items: MenuEntry[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="relative inline-block">
      <IconButton label={label} active={open} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon}
      </IconButton>
      {open && (
        <Menu
          items={items}
          onClose={() => setOpen(false)}
          dismissRef={box}
          className={`absolute top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'}`}
        />
      )}
    </div>
  );
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const margin = 8;
  const clamp = (w: number, h: number) => ({
    left: Math.max(margin, Math.min(x, window.innerWidth - w - margin)),
    top: Math.max(margin, Math.min(y, window.innerHeight - h - margin)),
  });
  const [pos, setPos] = useState(() => clamp(0, 0));
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    setPos(clamp(r?.width ?? 0, r?.height ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, items.length]);
  return <Menu ref={ref} items={items} onClose={onClose} className="fixed" style={{ left: pos.left, top: pos.top }} />;
}
