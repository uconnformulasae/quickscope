import { useCallback, useState } from 'react';

/** Persisted widths for the two analysis-view sidebars.
 *  Kept out of useAppState on purpose: a resize drag must not re-render the
 *  chart tree, so ResizeHandle mutates the panel's style directly and only
 *  commits here on pointer-up. */

const STORAGE_KEY = 'quickscope-sidebar-widths';

export const LEFT_SIDEBAR = { default: 192, min: 140, max: 480 } as const;  // 192 = the old w-48
export const RIGHT_SIDEBAR = { default: 288, min: 220, max: 640 } as const; // 288 = the old w-72

/** Chart area never shrinks below this, however small the window gets. */
export const MIN_CHART_WIDTH = 320;

export interface SidebarWidths {
  left: number;
  right: number;
}

export function clampWidth(width: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

function getInitialWidths(): SidebarWidths {
  const fallback = { left: LEFT_SIDEBAR.default, right: RIGHT_SIDEBAR.default };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return fallback;
    const parsed = JSON.parse(saved) as Partial<SidebarWidths>;
    return {
      left: typeof parsed.left === 'number' ? clampWidth(parsed.left, LEFT_SIDEBAR) : fallback.left,
      right: typeof parsed.right === 'number' ? clampWidth(parsed.right, RIGHT_SIDEBAR) : fallback.right,
    };
  } catch {
    return fallback;
  }
}

export function useSidebarWidths() {
  const [widths, setWidths] = useState<SidebarWidths>(getInitialWidths);

  const commit = useCallback((side: keyof SidebarWidths, width: number) => {
    setWidths(prev => {
      const bounds = side === 'left' ? LEFT_SIDEBAR : RIGHT_SIDEBAR;
      const next = { ...prev, [side]: clampWidth(width, bounds) };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // private mode / quota — widths just won't persist
      }
      return next;
    });
  }, []);

  const setLeftWidth = useCallback((w: number) => commit('left', w), [commit]);
  const setRightWidth = useCallback((w: number) => commit('right', w), [commit]);

  return { widths, setLeftWidth, setRightWidth } as const;
}
