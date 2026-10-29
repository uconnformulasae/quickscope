import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteLiveLayout,
  fetchLiveLayouts,
  saveLiveLayout,
  saveLiveLayoutSelection,
} from '../../lib/api';
import { type VehicleKind } from './live-channels';
import { BUILTIN_LAYOUTS } from './default-layouts';
import {
  BUILTIN_ID,
  EMPTY_SELECTION,
  cloneLayout,
  layoutForConnect,
  layoutForOffline,
  selectionAfterPick,
  validateLayout,
  type LayoutSelection,
  type LiveLayout,
} from './layout-schema';

/**
 * Built-in + user layouts, which one is showing, and persistence.
 *
 * `connectedKind` is the car currently streaming (null when offline). On the
 * transition to a car, the view switches to that car's last-used layout
 * unless one is pinned. While `suspendAutoSwitch` is true (edit mode) the
 * switch is deferred until it's false again.
 */
export function useLiveLayouts(connectedKind: VehicleKind | null, suspendAutoSwitch: boolean) {
  const [userLayouts, setUserLayouts] = useState<LiveLayout[]>([]);
  const [selection, setSelection] = useState<LayoutSelection>(EMPTY_SELECTION);
  const [loaded, setLoaded] = useState(false);
  const [currentId, setCurrentId] = useState<string>(BUILTIN_ID.ev);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLiveLayouts()
      .then((res) => {
        if (cancelled) return;
        const valid: LiveLayout[] = [];
        for (const raw of res.layouts) {
          try {
            valid.push(validateLayout(raw).layout);
          } catch (e) {
            console.warn('Skipping unreadable saved layout', e);
          }
        }
        setUserLayouts(valid);
        setSelection({ ...EMPTY_SELECTION, ...res.selection });
      })
      .catch((e: unknown) => {
        // Built-ins still work without the backend; just can't save.
        if (!cancelled) setError(`Couldn't load saved layouts: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  const layouts = useMemo(() => [...BUILTIN_LAYOUTS, ...userLayouts], [userLayouts]);
  const ids = useMemo(() => new Set(layouts.map((l) => l.id)), [layouts]);
  const current = layouts.find((l) => l.id === currentId) ?? BUILTIN_LAYOUTS[0];

  // `undefined` = nothing applied yet (first resolve picks the offline layout).
  const appliedKind = useRef<VehicleKind | null | undefined>(undefined);
  useEffect(() => {
    if (!loaded || suspendAutoSwitch || appliedKind.current === connectedKind) return;
    const first = appliedKind.current === undefined;
    appliedKind.current = connectedKind;
    if (connectedKind) setCurrentId(layoutForConnect(ids, selection, connectedKind));
    else if (first) setCurrentId(layoutForOffline(ids, selection));
    // Going offline keeps whatever is on screen.
  }, [loaded, suspendAutoSwitch, connectedKind, ids, selection]);

  const persistSelection = useCallback((next: LayoutSelection) => {
    setSelection(next);
    saveLiveLayoutSelection(next).catch((e: unknown) => {
      setError(`Couldn't save layout choice: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, []);

  const select = useCallback((id: string) => {
    const layout = layouts.find((l) => l.id === id);
    if (!layout) return;
    setCurrentId(id);
    persistSelection(selectionAfterPick(selection, layout));
  }, [layouts, selection, persistSelection]);

  const togglePin = useCallback(() => {
    persistSelection({ ...selection, pinned: selection.pinned === current.id ? null : current.id });
  }, [selection, current.id, persistSelection]);

  /** Save (create or replace) a user layout and show it. Optimistic, rolled back on failure. */
  const save = useCallback(async (layout: LiveLayout): Promise<boolean> => {
    const stamped: LiveLayout = { ...layout, builtIn: undefined, updatedAt: new Date().toISOString() };
    const previous = userLayouts;
    const exists = previous.some((l) => l.id === stamped.id);
    setUserLayouts(exists ? previous.map((l) => (l.id === stamped.id ? stamped : l)) : [...previous, stamped]);
    try {
      await saveLiveLayout(stamped);
      setError(null);
    } catch (e) {
      setUserLayouts(previous);
      setError(`Couldn't save layout: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    setCurrentId(stamped.id);
    persistSelection(selectionAfterPick(selection, stamped));
    return true;
  }, [userLayouts, selection, persistSelection]);

  const remove = useCallback(async (id: string) => {
    const target = userLayouts.find((l) => l.id === id);
    if (!target) return;
    const previous = userLayouts;
    setUserLayouts(previous.filter((l) => l.id !== id));
    try {
      await deleteLiveLayout(id);
    } catch (e) {
      setUserLayouts(previous);
      setError(`Couldn't delete layout: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Mirror the backend's cleanup of selection references.
    const fallback = BUILTIN_ID[target.vehicle];
    setSelection((sel) => ({
      active: Object.fromEntries(Object.entries(sel.active).filter(([, v]) => v !== id)),
      pinned: sel.pinned === id ? null : sel.pinned,
      last_used: sel.last_used === id ? null : sel.last_used,
    }));
    if (currentId === id) setCurrentId(fallback);
  }, [userLayouts, currentId]);

  const duplicate = useCallback((id: string) => {
    const source = layouts.find((l) => l.id === id);
    if (!source) return Promise.resolve(false);
    return save(cloneLayout(source, { name: uniqueName(`${source.name} (copy)`, layouts) }));
  }, [layouts, save]);

  /** Import a layout file's JSON. Returns warnings (dropped widgets) or throws on an unusable file. */
  const importLayout = useCallback(async (json: unknown): Promise<string[]> => {
    const { layout, warnings } = validateLayout(json);
    const clash = ids.has(layout.id) || layout.id.startsWith('builtin-');
    const nameClash = layouts.some((l) => l.name === layout.name);
    const toSave = clash ? cloneLayout(layout) : layout;
    if (nameClash) toSave.name = uniqueName(`${layout.name} (imported)`, layouts);
    const ok = await save(toSave);
    if (!ok) throw new Error('Saving the imported layout failed');
    return warnings;
  }, [ids, layouts, save]);

  return {
    layouts,
    current,
    selection,
    loaded,
    error,
    clearError: () => setError(null),
    pinned: selection.pinned === current.id,
    select,
    togglePin,
    save,
    remove,
    duplicate,
    importLayout,
  };
}

function uniqueName(base: string, layouts: LiveLayout[]): string {
  const names = new Set(layouts.map((l) => l.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}
