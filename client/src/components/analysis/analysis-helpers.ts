/**
 * Shared helpers for analysis panel tabs.
 */
import type { XRKSession, ChannelSample } from '../../lib/xrk-parser';
import type { DerivedChannel } from '../../lib/useXRKStore';

/** Resolve channel info from session or derived channels */
export function resolveChannel(id: number, session: XRKSession, derivedChannels?: DerivedChannel[]) {
  const sessionChan = session.channels.get(id);
  if (sessionChan) return sessionChan;
  const dc = derivedChannels?.find(d => d.id === id);
  if (dc) return { index: dc.id, shortName: dc.name, longName: dc.name, units: dc.units, color: dc.color, sampleRateHz: 0, sampleRateRaw: 0 } satisfies import('../../lib/xrk-parser').ChannelDef;
  return null;
}

/** Resolve sample data from session or derived samples map */
export function resolveSamples(id: number, session: XRKSession, derivedSamplesMap?: Map<number, ChannelSample[]>) {
  return session.samples.get(id) || derivedSamplesMap?.get(id) || [];
}

/** Format a number compactly based on magnitude */
export function formatNum(n: number): string {
  if (Math.abs(n) >= 10000) return n.toFixed(0);
  if (Math.abs(n) >= 100) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

/** Load Plotly.js from CDN (shared by Histogram and XY Plot tabs) */
let plotlyPromise: Promise<void> | null = null;
export function ensurePlotly(onReady: () => void) {
  if ((window as any).Plotly) {
    onReady();
    return;
  }
  if (!plotlyPromise) {
    plotlyPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Plotly'));
      document.head.appendChild(script);
    });
  }
  plotlyPromise.then(onReady).catch(() => {});
}
