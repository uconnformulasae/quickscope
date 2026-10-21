/**
 * Shared setup for component tests. Import it first in any test file that
 * starts with `// @vitest-environment jsdom`.
 *
 * jsdom has no layout engine, no canvas and no ResizeObserver, so this stubs
 * just enough of them for components to mount, and gives tests a way to fake
 * element sizes.
 */
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { XRKSession, ChannelDef, ChannelSample } from '../lib/xrk-parser';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

class ResizeObserverStub {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(target: Element) {
    this.cb([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// Never reports intersections: lazy-loaded thumbnails just stay placeholders.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
globalThis.IntersectionObserver ??= IntersectionObserverStub as unknown as typeof IntersectionObserver;

// No 2D context in jsdom: components must cope with getContext() === null.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}

/** Give every element the same fake box (jsdom reports 0x0 by default). */
export function fakeLayout({ width, height, scrollHeight }: { width: number; height: number; scrollHeight?: number }) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight ?? height);
}

/** A minimal loaded session with the given channels' samples. */
export function makeSession(channels: Record<number, { name: string; samples: ChannelSample[] }>): XRKSession {
  const defs = new Map<number, ChannelDef>();
  const samples = new Map<number, ChannelSample[]>();
  let durationMs = 0;
  for (const [id, ch] of Object.entries(channels)) {
    const index = Number(id);
    defs.set(index, {
      index, shortName: ch.name, longName: ch.name, sampleRateRaw: 10_000, sampleRateHz: 100,
      units: '', color: '#4361ee', fileSampleCount: ch.samples.length,
    });
    samples.set(index, ch.samples);
    durationMs = Math.max(durationMs, ch.samples.at(-1)?.timestamp ?? 0);
  }
  return {
    metadata: { vehicle: '', driver: '', date: '', time: '', venue: '', championship: '', sessionType: '' },
    channels: defs, samples, lapMarkers: [], lapSource: 'none', durationMs,
    totalSamples: [...samples.values()].reduce((n, s) => n + s.length, 0), logStartMs: null,
  };
}

export const ramp = (n: number, dtMs = 10): ChannelSample[] =>
  Array.from({ length: n }, (_, i) => ({ timestamp: i * dtMs, value: i }));
