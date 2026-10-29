import { describe, expect, it } from 'vitest';
import { drawCursors } from './chart-cursors';
import type { ChartColors, DrawContext, StripLayout } from './chart-utils';
import type { XRKSession } from './xrk-parser';

type Call = { op: string; args: unknown[]; fillStyle?: unknown };

/** Minimal 2D context that records the drawing calls drawCursors makes. */
function recordingContext() {
  const calls: Call[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    globalAlpha: 1,
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  for (const op of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'roundRect', 'fillRect', 'fillText']) {
    ctx[op] = (...args: unknown[]) => calls.push({ op, args, fillStyle: ctx.fillStyle });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const colors: ChartColors = {
  grid: 'grid', text: 'text', cursor: 'cursor', cursorPill: 'pill', cursorPillText: 'pillText',
  deltaFill: 'deltaFill', deltaLine: 'deltaLine', deltaPanel: 'deltaPanel', deltaAccent: 'deltaAccent',
  separator: 'sep', hoverLine: 'hover', lapMarker: 'lap', lapText: 'lapText',
};

const session = { logStartMs: null } as unknown as XRKSession;

const strip: StripLayout = { top: 0, height: 100, channelId: 1, color: '#f00', label: 'RPM', units: 'rpm' };

function makeDc(overrides: Partial<DrawContext> = {}) {
  const { ctx, calls } = recordingContext();
  // 1000 px wide, 60 px left margin, 20 px right margin; x range 0..10 s.
  const lm = 60;
  const dc = {
    ctx,
    w: 1000,
    h: 300,
    lm,
    rm: 20,
    plotW: 920,
    xRange: [0, 10] as [number, number],
    xTicks: [],
    strips: [strip],
    channelDataMap: new Map([[1, {
      def: { shortName: 'RPM', units: 'rpm', color: '#f00' },
      allSamples: [
        { timestamp: 0, value: 1000 },
        { timestamp: 5000, value: 2000 },
        { timestamp: 10000, value: 3000 },
      ],
    }]]),
    chartMode: 'separate',
    sharedYRanges: new Map(),
    timeToX: (t: number, xr: [number, number], plotW: number) => lm + ((t - xr[0]) / (xr[1] - xr[0])) * plotW,
    getVisibleSamples: () => [],
    overlayAxisLayout: { unitAxes: new Map(), axisCount: 0 },
    session,
    smoothedYRanges: new Map([['ch:1', [0, 4000] as [number, number]]]),
    needsDrawRef: { current: false },
    colors,
    ...overrides,
  } as DrawContext;
  return { dc, calls };
}

const texts = (calls: Call[]) => calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);

describe('drawCursors', () => {
  it('draws nothing when no cursor or hover is set', () => {
    const { dc, calls } = makeDc();
    drawCursors(dc, { cursorA: null, cursorB: null, hoverT: null, deltaMode: false }, 280);
    expect(calls).toEqual([]);
  });

  it('draws cursor A as a vertical line with a time label and a value pill', () => {
    const { dc, calls } = makeDc();
    drawCursors(dc, { cursorA: 5, cursorB: null, hoverT: null, deltaMode: false }, 280);

    const line = calls.find((c) => c.op === 'moveTo');
    expect(line?.args).toEqual([520.5, 0]);
    expect(calls.find((c) => c.op === 'lineTo')?.args).toEqual([520.5, 280]);
    expect(texts(calls)).toContain('RPM');
    expect(texts(calls)).toContain('2000.0');
    // No delta fill or panel with a single cursor
    expect(calls.some((c) => c.op === 'fillRect')).toBe(false);
  });

  it('does not draw a cursor line outside the plot area', () => {
    const { dc, calls } = makeDc();
    drawCursors(dc, { cursorA: null, cursorB: null, hoverT: 20, deltaMode: false }, 280);
    expect(calls.some((c) => c.op === 'moveTo')).toBe(false);
  });

  it('shades the region between two visible cursors and shows a delta panel', () => {
    const { dc, calls } = makeDc();
    drawCursors(dc, { cursorA: 0, cursorB: 10, hoverT: null, deltaMode: true }, 280);

    const fill = calls.find((c) => c.op === 'fillRect');
    expect(fill?.args).toEqual([60, 0, 920, 280]);
    expect(fill?.fillStyle).toBe('deltaFill');
    const labels = texts(calls);
    expect(labels).toContain('Δt = 10.000s');
    expect(labels).toEqual(expect.arrayContaining(['Channel', 'A', 'B', 'Δ', '1000.0', '3000.0', '2000.0']));
  });

  it('orders the shaded region the same way when cursor B is left of A', () => {
    const { dc, calls } = makeDc();
    drawCursors(dc, { cursorA: 7.5, cursorB: 2.5, hoverT: null, deltaMode: true }, 280);

    expect(calls.find((c) => c.op === 'fillRect')?.args).toEqual([290, 0, 460, 280]);
    expect(texts(calls)).toContain('Δt = 5.000s');
  });

  it('draws a hover crosshair with a value pill', () => {
    const { dc, calls } = makeDc();
    drawCursors(dc, { cursorA: null, cursorB: null, hoverT: 9, deltaMode: false }, 280);

    expect(calls.find((c) => c.op === 'moveTo')?.args).toEqual([888.5, 0]);
    expect(texts(calls)).toContain('3000.0');
  });

  it('skips the hover line when hovering on cursor A', () => {
    const { dc, calls } = makeDc();
    drawCursors(dc, { cursorA: 5, cursorB: null, hoverT: 5.001, deltaMode: false }, 280);
    expect(calls.filter((c) => c.op === 'moveTo')).toHaveLength(1);
  });

  it('hides hover value pills in delta mode until a cursor is placed', () => {
    const { dc, calls } = makeDc();
    drawCursors(dc, { cursorA: null, cursorB: null, hoverT: 5, deltaMode: true }, 280);
    expect(texts(calls)).not.toContain('2000.0');
  });

  it('skips strips whose channel has no samples', () => {
    const { dc, calls } = makeDc({ channelDataMap: new Map() });
    drawCursors(dc, { cursorA: 5, cursorB: null, hoverT: null, deltaMode: false }, 280);
    expect(texts(calls)).not.toContain('RPM');
  });
});
