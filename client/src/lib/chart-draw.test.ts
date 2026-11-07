import { describe, expect, it } from 'vitest';
import { drawOverlayLegend, drawStrips, overlayLegendHeight } from './chart-draw';
import type { ChartColors, DrawContext, StripLayout } from './chart-utils';
import { lapColor } from './lap-compare';
import type { ChannelSample, XRKSession } from './xrk-parser';

/** Records strokeStyle and dash pattern at each stroke(). */
function recordingContext() {
  const strokes: { style: unknown; dash: number[] }[] = [];
  const texts: { text: string; y: number }[] = [];
  const ops: { op: string; args: unknown[] }[] = [];
  let dash: number[] = [];
  const stack: { strokeStyle: unknown; dash: number[] }[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', globalAlpha: 1, lineJoin: 'round',
    measureText: (t: string) => ({ width: t.length * 6 }),
    setLineDash: (d: number[]) => { dash = d; },
    save: () => stack.push({ strokeStyle: ctx.strokeStyle, dash }),
    restore: () => { const p = stack.pop(); if (p) { ctx.strokeStyle = p.strokeStyle; dash = p.dash; } },
    stroke: () => { strokes.push({ style: ctx.strokeStyle, dash }); ops.push({ op: 'stroke', args: [ctx.strokeStyle] }); },
    rect: (...a: unknown[]) => ops.push({ op: 'rect', args: a }),
    clip: () => ops.push({ op: 'clip', args: [] }),
    roundRect: (...a: unknown[]) => ops.push({ op: 'roundRect', args: a }),
    fillText: (text: string, _x: number, y: number) => texts.push({ text, y }),
  };
  for (const op of ['beginPath', 'moveTo', 'lineTo', 'fill', 'arc', 'fillRect', 'translate', 'rotate', 'closePath']) {
    ctx[op] = () => {};
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, texts, ops };
}

const colors = {
  grid: 'grid', text: 'text', cursor: 'c', cursorPill: 'p', cursorPillText: 'pt', deltaFill: 'df', deltaLine: 'dl',
  deltaPanel: 'dp', deltaAccent: 'da', separator: 'sep', hoverLine: 'h', lapMarker: 'lm', lapText: 'lt',
} as ChartColors;

const lap = (offset: number): ChannelSample[] =>
  Array.from({ length: 50 }, (_, i) => ({ timestamp: i * 100, value: offset + i }));

function makeDc(chartMode: 'separate' | 'overlay') {
  const { ctx, strokes, texts, ops } = recordingContext();
  const strip: StripLayout = { top: 0, height: 100, channelId: 1, color: '#ff0000', label: 'RPM', units: 'rpm' };
  const lapA = lap(0), lapB = lap(10);
  const dc = {
    ctx, w: 1000, h: 300, lm: 60, rm: 20, plotW: 920, xRange: [0, 5] as [number, number], xTicks: [],
    strips: [strip],
    channelDataMap: new Map([[1, { def: { shortName: 'RPM', units: 'rpm', color: '#ff0000' }, allSamples: lapA }]]),
    chartMode, sharedYRanges: new Map(),
    timeToX: (t: number, xr: [number, number], pw: number) => 60 + ((t - xr[0]) / (xr[1] - xr[0])) * pw,
    getVisibleSamples: (_id: number, all: ChannelSample[]) => all,
    overlayAxisLayout: { unitAxes: new Map([['rpm', { side: 'left' as const, sideIndex: 0 }]]), axisCount: 1 },
    session: { lapMarkers: [], logStartMs: null } as unknown as XRKSession,
    smoothedYRanges: new Map(), needsDrawRef: { current: false }, colors, fontScale: 1,
    compare: { laps: [], series: new Map([[1, [lapA, lapB]]]) },
  } as DrawContext;
  return { dc, strokes, texts, ops };
}

describe('drawStrips in lap compare mode', () => {
  it('draws one trace per lap in lap colours on separate strips', () => {
    const { dc, strokes } = makeDc('separate');
    drawStrips(dc);
    const styles = strokes.map(s => s.style);
    expect(styles).toContain(lapColor(0));
    expect(styles).toContain(lapColor(1));
  });

  it('keeps the channel colour and dashes later laps in overlay mode', () => {
    const { dc, strokes } = makeDc('overlay');
    drawStrips(dc);
    const traces = strokes.filter(s => s.style === '#ff0000');
    expect(traces.some(s => s.dash.length === 0)).toBe(true);
    expect(traces.some(s => s.dash.join(',') === '6,3')).toBe(true);
  });
});

describe('min/max readout', () => {
  it('sits at the bottom of the strip, clear of the cursor pill at the top', () => {
    const { dc, texts } = makeDc('separate');
    drawStrips(dc);
    const readout = texts.find(t => t.text.startsWith('min '));
    expect(readout).toBeTruthy();
    expect(readout!.y).toBeGreaterThan(50); // strip is 0..100; pill occupies the top ~24px
  });
});

describe('overlay legend band', () => {
  it('reserves height only in overlay mode', () => {
    expect(overlayLegendHeight(makeDc('separate').dc)).toBe(0);
    expect(overlayLegendHeight(makeDc('overlay').dc)).toBeGreaterThan(0);
  });

  it('wraps onto more rows (taller band, two text baselines) when the plot is narrow', () => {
    const wide = makeDc('overlay');
    const narrow = makeDc('overlay');
    const second = { ...narrow.dc.strips[0], channelId: 2, color: '#00ff00', label: 'Speed' };
    for (const d of [wide.dc, narrow.dc]) {
      d.strips = [...d.strips, second];
      d.channelDataMap = new Map([...d.channelDataMap, [2, { def: { shortName: 'Speed', units: 'km/h', color: '#00ff00' }, allSamples: lap(5) }]]);
      d.compare = null;
    }
    narrow.dc.w = 260; narrow.dc.plotW = 180;
    expect(overlayLegendHeight(narrow.dc)).toBeGreaterThan(overlayLegendHeight(wide.dc));
    drawOverlayLegend(narrow.dc);
    const ys = new Set(narrow.texts.map(t => t.y));
    expect(ys.size).toBe(2);
  });
});

describe('lap labels', () => {
  it('skips a lap label that would overlap its neighbour', () => {
    const { dc, texts } = makeDc('separate');
    dc.compare = null;
    dc.session = { lapMarkers: [{ timestamp: 1000, lapNumber: 1 }, { timestamp: 1010, lapNumber: 2 }, { timestamp: 4000, lapNumber: 3 }], logStartMs: null } as unknown as XRKSession;
    drawStrips(dc);
    const laps = texts.filter(t => /^L\d+$/.test(t.text)).map(t => t.text);
    expect(laps).toEqual(['L1', 'L3']);
  });
});

describe('trace bounds and label order', () => {
  it('clips traces to the plot area', () => {
    const { dc, ops } = makeDc('separate');
    drawStrips(dc);
    const clipAt = ops.findIndex(o => o.op === 'clip');
    expect(clipAt).toBeGreaterThan(0);
    expect(ops[clipAt - 1]).toEqual({ op: 'rect', args: [60, 0, 920, 100] });
  });

  it('draws min/max boxes after every trace in overlay mode', () => {
    const { dc, ops } = makeDc('overlay');
    dc.compare = null;
    const second = { ...dc.strips[0], channelId: 2, color: '#00ff00', label: 'Speed' };
    dc.strips = [...dc.strips, second];
    dc.channelDataMap = new Map([...dc.channelDataMap, [2, { def: { shortName: 'Speed', units: 'km/h', color: '#00ff00' }, allSamples: lap(5) }]]);
    drawStrips(dc);
    const lastTrace = ops.map(o => o.op === 'stroke' && o.args[0] === '#00ff00').lastIndexOf(true);
    const firstBox = ops.findIndex(o => o.op === 'roundRect');
    expect(firstBox).toBeGreaterThan(lastTrace);
  });
});
