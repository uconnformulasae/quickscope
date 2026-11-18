import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Responsive, WidthProvider, type Layout, type Layouts } from 'react-grid-layout';
import { Pencil, X } from 'lucide-react';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { extractChannelNames } from '../../lib/formula-engine';
import { type Snapshot } from './live-channels';
import { GRID_COLS, usedChannels, type GridItem, type LiveLayout, type WidgetConfig } from './layout-schema';
import { WidgetRenderer, type UnitSwitch } from './WidgetRenderer';
import { type UnitOverrides } from './useUnitOverrides';
import { fittedGrid, useNeededRows } from './auto-fit';

const ResponsiveGrid = WidthProvider(Responsive);

// Below this width widgets stack in one column, in layout order, at their
// natural height. Only the 12-column arrangement is stored, so there's no
// separate mobile layout to keep in sync.
const WIDE_QUERY = '(min-width: 768px)';
const ROW_HEIGHT = 24;
const MARGIN: [number, number] = [12, 12];
// Module constants so the grid sees the same objects on every render.
const NO_PADDING: [number, number] = [0, 0];
const GRID_BREAKPOINTS = { lg: 0 };
const GRID_COLUMNS = { lg: GRID_COLS };

function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

// The newest snapshot reaches widgets through context, not props. Snapshots
// arrive several times a second; passed as a prop they rebuilt every grid
// child, so react-grid-layout re-laid-out the whole dashboard on each one.
// With context the grid's element tree stays the same object between
// snapshots and only the widgets themselves re-render.
const SnapshotContext = createContext<{ latest: Snapshot | null; totalReceived: number }>({
  latest: null,
  totalReceived: 0,
});

interface WidgetActions {
  edit: (id: string) => void;
  remove: (id: string) => void;
}

const LiveWidget = memo(function LiveWidget({
  widget, usedChannels, unitSwitch, editing, actions,
}: {
  widget: WidgetConfig;
  usedChannels: Set<string>;
  unitSwitch: UnitSwitch | undefined;
  editing: boolean;
  actions: WidgetActions;
}) {
  const { latest, totalReceived } = useContext(SnapshotContext);
  return (
    <>
      <WidgetRenderer widget={widget} latest={latest} totalReceived={totalReceived} usedChannels={usedChannels} unitSwitch={unitSwitch} />
      {editing && (
        <div className="no-drag absolute top-1.5 right-1.5 flex gap-1">
          <button
            onClick={() => actions.edit(widget.id)}
            className="p-1 rounded-md bg-card/90 border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Configure widget"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            onClick={() => actions.remove(widget.id)}
            className="p-1 rounded-md bg-card/90 border border-border text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
            title="Remove widget"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </>
  );
});

export function LiveDashboard({
  layout,
  latest,
  totalReceived,
  stale,
  editing,
  onGridChange,
  onEditWidget,
  onRemoveWidget,
  unitOverrides,
  onCycleUnit,
}: {
  layout: LiveLayout;
  latest: Snapshot | null;
  totalReceived: number;
  /** Values on screen are from a session that has ended. */
  stale: boolean;
  editing: boolean;
  onGridChange: (grid: GridItem[]) => void;
  onEditWidget: (id: string) => void;
  onRemoveWidget: (id: string) => void;
  /** Click-to-switch units; ignored while editing (a click there starts a drag). */
  unitOverrides: UnitOverrides;
  onCycleUnit: (key: string, units: string[]) => void;
}) {
  const used = useMemo(() => usedChannels(layout, extractChannelNames), [layout]);
  const wide = useIsWide();
  // View mode: widgets grow to fit content that re-wraps on smaller displays.
  const { containerRef, needed } = useNeededRows(ROW_HEIGHT, MARGIN[1], [layout.widgets, wide, editing, latest === null]);
  const layouts: Layouts = useMemo(
    () => ({ lg: fittedGrid(layout.grid, needed, editing) }),
    [layout.grid, needed, editing],
  );
  const unitSwitch = useMemo(
    () => (editing ? undefined : { layoutId: layout.id, overrides: unitOverrides, cycle: onCycleUnit }),
    [editing, layout.id, unitOverrides, onCycleUnit],
  );

  // The parent passes fresh callbacks on every render (i.e. every snapshot).
  // Reading them through a ref keeps the memoised tree below from changing.
  const callbacks = useRef({ onGridChange, onEditWidget, onRemoveWidget });
  callbacks.current = { onGridChange, onEditWidget, onRemoveWidget };
  const actions = useMemo<WidgetActions>(() => ({
    edit: (id) => callbacks.current.onEditWidget(id),
    remove: (id) => callbacks.current.onRemoveWidget(id),
  }), []);

  const grid = layout.grid;
  const handleLayoutChange = useCallback((current: Layout[]) => {
    if (!editing) return;
    const next = current.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    const same = next.length === grid.length && next.every((n) => {
      const g = grid.find((o) => o.i === n.i);
      return g && g.x === n.x && g.y === n.y && g.w === n.w && g.h === n.h;
    });
    if (!same) callbacks.current.onGridChange(next);
  }, [editing, grid]);

  const snapshot = useMemo(() => ({ latest, totalReceived }), [latest, totalReceived]);
  const widgets = layout.widgets;

  // Everything below depends on the layout, not on the snapshot.
  const body = useMemo(() => {
    const renderWidget = (w: WidgetConfig) => (
      <LiveWidget widget={w} usedChannels={used} unitSwitch={unitSwitch} editing={editing} actions={actions} />
    );

    if (!wide) {
      const pos = new Map(grid.map((g) => [g.i, g]));
      const sorted = [...widgets].sort((a, b) => {
        const ga = pos.get(a.id)!;
        const gb = pos.get(b.id)!;
        return ga.y - gb.y || ga.x - gb.x;
      });
      return sorted.map((w) => (
        <div key={w.id} className="relative">{renderWidget(w)}</div>
      ));
    }

    return (
      <ResponsiveGrid
        className={editing ? 'live-grid-editing' : undefined}
        layouts={layouts}
        breakpoints={GRID_BREAKPOINTS}
        cols={GRID_COLUMNS}
        rowHeight={ROW_HEIGHT}
        margin={MARGIN}
        containerPadding={NO_PADDING}
        isDraggable={editing}
        isResizable={editing}
        draggableCancel=".no-drag"
        onLayoutChange={handleLayoutChange}
      >
        {widgets.map((w) => (
          <div key={w.id} data-widget-id={w.id} className={`relative ${editing ? 'cursor-move' : ''}`}>
            {renderWidget(w)}
          </div>
        ))}
      </ResponsiveGrid>
    );
  }, [wide, widgets, grid, layouts, editing, used, unitSwitch, actions, handleLayoutChange]);

  if (widgets.length === 0) {
    return (
      <div className="max-w-md mx-auto text-center mt-16 px-4 text-xs text-muted-foreground">
        {editing ? 'This layout is empty. Use Add widget to start building it.' : 'This layout has no widgets.'}
      </div>
    );
  }

  const dim = stale && !editing ? 'opacity-60' : '';

  return (
    <SnapshotContext.Provider value={snapshot}>
      {wide ? (
        <div ref={containerRef} className={`max-w-[1600px] mx-auto transition-opacity ${dim}`}>{body}</div>
      ) : (
        <div className={`space-y-3 transition-opacity ${dim}`}>{body}</div>
      )}
    </SnapshotContext.Provider>
  );
}
