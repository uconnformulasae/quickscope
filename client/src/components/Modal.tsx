import { useEffect, type HTMLAttributes, type ReactNode } from 'react';
import { useBackdropDismiss } from '../lib/useBackdropDismiss';

interface ModalProps extends HTMLAttributes<HTMLDivElement> {
  onClose: () => void;
  /** Size and layout classes for the panel (width, max-height, flex, …). */
  className?: string;
  /** Escape closes the dialog. Turn off where that would discard typed work. */
  closeOnEscape?: boolean;
  children: ReactNode;
}

/**
 * The shell every dialog uses: the scrim, the panel chrome, and how it closes.
 * A click closes it only when the press both started and ended on the scrim
 * (see useBackdropDismiss), so dragging a text selection past the panel edge
 * never throws an edit away. Other props go to the panel element.
 */
export function Modal({ onClose, className = '', closeOnEscape = true, children, ...panelProps }: ModalProps) {
  const backdrop = useBackdropDismiss(onClose);

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOnEscape, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center qs-scrim" data-backdrop="1" {...backdrop}>
      <div {...panelProps} className={`qs-dialog bg-card border border-border rounded-xl shadow-2xl ${className}`}>
        {children}
      </div>
    </div>
  );
}
