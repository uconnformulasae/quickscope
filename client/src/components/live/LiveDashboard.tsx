import { useEffect, useMemo, useState } from 'react';
import { Responsive, WidthProvider, type Layout, type Layouts } from 'react-grid-layout';
import { Pencil, X } from 'lucide-react';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { extractChannelNames } from '../../lib/formula-engine';
import { type Snapshot } from './live-channels';
import { GRID_COLS, usedChannels, type GridItem, type LiveLayout, type WidgetConfig } from './layout-schema';
import { WidgetRenderer } from './WidgetRenderer';
import { type UnitOverrides } from './useUnitOverrides';

const ResponsiveGrid = WidthProvider(Responsive);

// Below this width widgets stack in one column, in layout order, at their
// natural height. Only the 12-column arrangement is stored, so there's no
// separate mobile layout to keep in sync.
const WIDE_QUERY = '(min-width: 768px)';
const ROW_HEIGHT = 24;
const MARGIN: [number, number] = [12, 12];

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
  const layouts: Layouts = useMemo(() => ({ lg: layout.grid }), [layout.grid]);
  const wide = useIsWide();
  const unitSwitch = useMemo(
    () => (editing ? undefined : { layoutId: layout.id, overrides: unitOverrides, cycle: onCycleUnit }),
    [editing, layout.id, unitOverrides, onCycleUnit],
  );

  const handleLayoutChange = (current: Layout[]) => {
    if (!editing) return;
    const next = current.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    const same = next.length === layout.grid.length && next.every((n) => {
      const g = layout.grid.find((o) => o.i === n.i);
      return g && g.x === n.x && g.y === n.y && g.w === n.w && g.h === n.h;
    });
    if (!same) onGridChange(next);
  };

  if (layout.widgets.length === 0) {
    return (
      <div className="max-w-md mx-auto text-center mt-16 px-4 text-xs text-muted-foreground">
        {editing ? 'This layout is empty. Use Add widget to start building it.' : 'This layout has no widgets.'}
      </div>
    );
  }

  const renderWidget = (w: WidgetConfig) => (
    <>
      <WidgetRenderer widget={w} latest={latest} totalReceived={totalReceived} usedChannels={used} unitSwitch={unitSwitch} />
      {editing && (
        <div className="no-drag absolute top-1.5 right-1.5 flex gap-1">
          <button
            onClick={() => onEditWidget(w.id)}
            className="p-1 rounded-md bg-card/90 border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Configure widget"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            onClick={() => onRemoveWidget(w.id)}
            className="p-1 rounded-md bg-card/90 border border-border text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
            title="Remove widget"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </>
  );

  const dim = stale && !editing ? 'opacity-60' : '';

  if (!wide) {
    const pos = new Map(layout.grid.map((g) => [g.i, g]));
    const sorted = [...layout.widgets].sort((a, b) => {
      const ga = pos.get(a.id)!;
      const gb = pos.get(b.id)!;
      return ga.y - gb.y || ga.x - gb.x;
    });
    return (
      <div className={`space-y-3 transition-opacity ${dim}`}>
        {sorted.map((w) => (
          <div key={w.id} className="relative">{renderWidget(w)}</div>
        ))}
      </div>
    );
  }

  return (
    <div className={`max-w-[1600px] mx-auto transition-opacity ${dim}`}>
      <ResponsiveGrid
        className={editing ? 'live-grid-editing' : undefined}
        layouts={layouts}
        breakpoints={{ lg: 0 }}
        cols={{ lg: GRID_COLS }}
        rowHeight={ROW_HEIGHT}
        margin={MARGIN}
        containerPadding={[0, 0]}
        isDraggable={editing}
        isResizable={editing}
        draggableCancel=".no-drag"
        onLayoutChange={handleLayoutChange}
      >
        {layout.widgets.map((w) => (
          <div key={w.id} className={`relative ${editing ? 'cursor-move' : ''}`}>
            {renderWidget(w)}
          </div>
        ))}
      </ResponsiveGrid>
    </div>
  );
}
