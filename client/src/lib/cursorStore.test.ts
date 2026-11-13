import { describe, expect, it, vi } from 'vitest';
import { createCursorStore } from './cursorStore';

describe('cursorStore', () => {
  it('notifies subscribers only when the value changes', () => {
    const store = createCursorStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(1.5);
    store.set(1.5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(1.5);

    store.set(null);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.set(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
