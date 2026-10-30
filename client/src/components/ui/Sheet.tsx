import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({
  title,
  subtitle,
  onClose,
  footer,
  width = 520,
  children,
  closeOnBackdrop = true,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose?: () => void;
  footer?: ReactNode;
  width?: number;
  children?: ReactNode;
  closeOnBackdrop?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const p = panel.current;
    if (p && !p.contains(document.activeElement)) {
      (p.querySelector<HTMLElement>('[data-autofocus]') ?? p.querySelector<HTMLElement>(FOCUSABLE) ?? p).focus();
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const els = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (els.length === 0) {
      e.preventDefault();
      return;
    }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-[10vh] dark:bg-black/45"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ width, maxWidth: 'calc(100vw - 32px)' }}
        className="flex max-h-[80vh] flex-col overflow-hidden rounded-[14px] bg-popover text-foreground shadow-2xl outline-none ring-1 ring-border"
      >
        <div className="flex items-start gap-3 px-[18px] pb-1.5 pt-4">
          <div className="min-w-0 flex-1">
            <h3 className="m-0 font-display text-[15px] font-semibold tracking-[-0.012em]">{title}</h3>
            {subtitle && <p className="mb-0 mt-[3px] text-[12.5px] text-muted-foreground">{subtitle}</p>}
          </div>
          {onClose && (
            <IconButton label="Close" onClick={onClose} className="-mr-1.5 -mt-1">
              <X size={15} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-1 pt-2.5">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-[18px] pb-4 pt-3.5">{footer}</div>}
      </div>
    </div>
  );
}
