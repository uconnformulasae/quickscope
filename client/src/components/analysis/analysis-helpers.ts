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

/** Read Plotly-relevant CSS custom properties from the current theme */
export function getPlotlyColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    gridcolor: s.getPropertyValue('--chart-grid').trim(),
    tickfontColor: s.getPropertyValue('--chart-text').trim(),
    fontColor: s.getPropertyValue('--chart-text').trim(),
    hoverBg: s.getPropertyValue('--chart-cursor-pill').trim(),
    hoverText: s.getPropertyValue('--chart-cursor-pill-text').trim(),
    borderColor: s.getPropertyValue('--chart-separator').trim(),
  };
}

/** Load the bundled Plotly.js lazily (shared by Histogram and XY Plot tabs). Works offline. */
let plotlyPromise: Promise<void> | null = null;
export function ensurePlotly(onReady: () => void) {
  if ((window as any).Plotly) {
    onReady();
    return;
  }
  if (!plotlyPromise) {
    plotlyPromise = import('plotly.js-dist-min').then((mod) => {
      (window as any).Plotly = mod.default ?? mod;
    });
    plotlyPromise.catch(() => { plotlyPromise = null; }); // allow a retry on the next call
  }
  plotlyPromise.then(onReady).catch((err) => console.error('Failed to load Plotly', err));
}
