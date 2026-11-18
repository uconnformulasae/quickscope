import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * True when exit animations should be skipped: under tests (so assertions see
 * unmounts immediately), when matchMedia is unavailable, or when the user asked
 * the OS to reduce motion.
 */
export function prefersReducedMotion(): boolean {
  if (import.meta.env.MODE === 'test') return true;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keeps a conditionally rendered overlay mounted for `exitMs` after `show`
 * turns false, so CSS can play its exit (`[data-presence="closing"] …`).
 * While closing it renders the last children it was shown with, is
 * aria-hidden and inert, and the closing CSS disables pointer events. Showing again
 * mid-exit returns straight to open. Purely visual: callers' state changes
 * and callbacks happen exactly when they did before.
 */
// React 18 has no typed `inert` prop; an empty-string attribute is passed through.
const INERT = { inert: '' } as Record<string, string>;

export function Presence({ show, exitMs = 150, children }: { show: boolean; exitMs?: number; children: ReactNode }) {
  const cached = useRef<ReactNode>(children);
  const wasShown = useRef(show);
  const [lingering, setLingering] = useState(false);
  // Bumped on every closed→open transition so a reopen (even mid-exit) mounts
  // fresh children, exactly as the old `cond && <Dialog/>` did. The closing
  // copy keeps the open copy's key, so it doesn't remount on close.
  const generation = useRef(0);
  const renderedShow = useRef(false);
  if (show && !renderedShow.current) generation.current += 1;
  renderedShow.current = show;

  if (show) cached.current = children;

  useEffect(() => {
    const justClosed = wasShown.current && !show;
    wasShown.current = show;
    if (!justClosed || prefersReducedMotion()) {
      setLingering(false);
      return;
    }
    setLingering(true);
    const t = setTimeout(() => setLingering(false), exitMs);
    return () => clearTimeout(t);
  }, [show, exitMs]);

  if (show) {
    return <div key={generation.current} data-presence="open" className="contents">{children}</div>;
  }
  // `wasShown` is still true on the first render after closing (the effect
  // hasn't run yet) — render the closing copy then too, so there's no
  // one-frame gap before the exit starts.
  const closing = lingering || (wasShown.current && !prefersReducedMotion());
  if (!closing) return null;
  // inert: the exiting copy can't take focus or keyboard activation (a second
  // Enter must not re-run Save/Export on the stale copy).
  return (
    <div key={generation.current} data-presence="closing" aria-hidden="true" className="contents" {...INERT}>
      {cached.current}
    </div>
  );
}
