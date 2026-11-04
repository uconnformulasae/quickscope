/**
 * Live dashboard widgets grow to fit their content: on a smaller display tiles
 * wrap onto more rows, so a fixed grid height would cut the bottom off.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GridItem } from './layout-schema';

/** Fewest grid rows whose span (rows*rowHeight + gaps) holds `px`. */
export function rowsForHeight(px: number, rowHeight: number, marginY: number): number {
  return Math.max(1, Math.ceil((px + marginY) / (rowHeight + marginY)));
}

/** Grid with each widget at least as tall as its content needs (view mode
 *  only; while editing the saved layout is used as-is). */
export function fittedGrid(grid: GridItem[], neededRows: Record<string, number>, editing: boolean): GridItem[] {
  if (editing) return grid;
  return grid.map(g => {
    const need = neededRows[g.i];
    return need !== undefined && need > g.h ? { ...g, h: need } : g;
  });
}

/**
 * Measures each widget's content (`[data-widget-id]` > section > body >
 * `[data-panel-content]`) and reports the rows it needs. Re-measures when
 * content size changes (window/display resize makes tiles re-wrap).
 */
export function useNeededRows(rowHeight: number, marginY: number, deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [needed, setNeeded] = useState<Record<string, number>>({});

  const measure = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const next: Record<string, number> = {};
    root.querySelectorAll<HTMLElement>('[data-widget-id]').forEach(item => {
      const section = item.querySelector('section');
      const content = item.querySelector<HTMLElement>('[data-panel-content]');
      const body = content?.parentElement;
      if (!section || !content || !body) return;
      const chrome = section.offsetHeight - body.clientHeight; // header + padding + border
      next[item.dataset.widgetId!] = rowsForHeight(chrome + content.offsetHeight, rowHeight, marginY);
    });
    setNeeded(prev => {
      const keys = Object.keys(next);
      const same = keys.length === Object.keys(prev).length && keys.every(k => prev[k] === next[k]);
      return same ? prev : next;
    });
  }, [rowHeight, marginY]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    root.querySelectorAll('[data-panel-content]').forEach(el => ro.observe(el));
    ro.observe(root);
    measure();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  return { containerRef, needed };
}
