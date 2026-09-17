import { useCallback, useRef } from 'react';
import { MIN_CHART_WIDTH, clampWidth } from '../lib/useSidebarWidths';

interface ResizeHandleProps {
  /** Which edge of the layout this handle sits on. Left handles grow to the
   *  right as the pointer moves right; right handles are mirrored. */
  side: 'left' | 'right';
  /** The panel element being resized. */
  panelRef: React.RefObject<HTMLDivElement | null>;
  width: number;
  bounds: { default: number; min: number; max: number };
  onCommit: (width: number) => void;
  label: string;
}

const KEYBOARD_STEP = 16;

/** Draggable divider between a sidebar and the chart area.
 *
 *  During the drag it writes straight to `panelRef.current.style.width` — no
 *  setState per pointermove, same rule the canvas chart follows. TelemetryChart
 *  has a ResizeObserver, so it re-measures on its own. The React state (and
 *  localStorage) is updated once, on pointer-up.
 */
export function ResizeHandle({ side, panelRef, width, bounds, onCommit, label }: ResizeHandleProps) {
  const dragRef = useRef<{ startX: number; startWidth: number; current: number } | null>(null);

  /** Upper bound for this drag: never squeeze the chart area below MIN_CHART_WIDTH.
   *  row = this panel + the other sidebar and handles + the chart area. */
  const maxForViewport = useCallback(() => {
    const panel = panelRef.current;
    if (!panel?.parentElement) return bounds.max;
    const available = panel.parentElement.clientWidth - otherChildrenWidth(panel) - MIN_CHART_WIDTH;
    return Math.min(bounds.max, Math.max(bounds.min, available));
  }, [panelRef, bounds.max, bounds.min]);

  const applyWidth = useCallback((next: number) => {
    const clamped = clampWidth(next, { min: bounds.min, max: maxForViewport() });
    const panel = panelRef.current;
    if (panel) panel.style.width = `${clamped}px`;
    return clamped;
  }, [panelRef, bounds.min, maxForViewport]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;

    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: panel.clientWidth, current: panel.clientWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelRef]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = side === 'left' ? e.clientX - drag.startX : drag.startX - e.clientX;
    drag.current = applyWidth(drag.startWidth + delta);
  }, [side, applyWidth]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    onCommit(drag.current);
  }, [onCommit]);

  /** Double-click resets to the original fixed width. */
  const handleDoubleClick = useCallback(() => {
    onCommit(applyWidth(bounds.default));
  }, [applyWidth, bounds.default, onCommit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    const step = e.key === grow ? KEYBOARD_STEP : -KEYBOARD_STEP;
    onCommit(applyWidth(width + step));
  }, [side, width, applyWidth, onCommit]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      title={`Drag to resize · double-click to reset`}
      className="group relative w-1 flex-shrink-0 cursor-col-resize bg-border/60 hover:bg-primary/60 focus:bg-primary/60 focus:outline-none transition-colors"
    >
      {/* Widen the grab target without widening the visible line. */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

/** Width of everything in the flex row that is neither this panel nor the
 *  chart area — i.e. the other sidebar and both resize handles. */
function otherChildrenWidth(panel: HTMLDivElement): number {
  const parent = panel.parentElement;
  if (!parent) return 0;
  let total = 0;
  for (const child of Array.from(parent.children)) {
    const el = child as HTMLElement;
    if (el === panel || el.dataset.chartArea === 'true') continue;
    total += el.offsetWidth;
  }
  return total;
}
