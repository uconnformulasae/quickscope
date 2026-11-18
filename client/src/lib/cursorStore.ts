/**
 * The chart cursor time, kept outside React state.
 *
 * The cursor follows the mouse, so it changes many times a second. In the
 * app-wide state object every one of those changes re-rendered the whole app.
 * Here only the components that subscribe (the GPS marker, the chart's own
 * sync) hear about it.
 */
import { useSyncExternalStore } from 'react';

/** A single value that components can subscribe to without it living in React state. */
export interface ValueStore<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** Re-render the calling component whenever the stored value changes. */
export function useStoreValue<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Cursor time in seconds (lap-relative in lap compare mode), or null. */
export type CursorStore = ValueStore<number | null>;

export const createCursorStore = (): CursorStore => createValueStore<number | null>(null);

/** Re-render the calling component whenever the cursor moves. */
export const useCursorTime = (store: CursorStore): number | null => useStoreValue(store);
