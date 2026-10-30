// @vitest-environment jsdom
import { fakeLayout, makeSession, ramp } from '../test/dom-setup';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TelemetryChart } from './TelemetryChart';

const session = makeSession({
  1: { name: 'A', samples: ramp(1001) },
  2: { name: 'B', samples: ramp(1001) },
  3: { name: 'C', samples: ramp(1001) },
  4: { name: 'D', samples: ramp(1001) },
}); // 10 s long
const active = [1, 2, 3, 4].map(channelId => ({ channelId, color: '#f00' }));

function renderChart(props: Partial<Parameters<typeof TelemetryChart>[0]> = {}) {
  return render(
    <TelemetryChart session={session} activeChannels={active} viewRange={null} onViewRangeChange={() => {}} onChartModeChange={() => {}} {...props} />,
  );
}

function wheel(canvas: HTMLElement, init: WheelEventInit) {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 500, deltaY: -100, ...init });
  canvas.dispatchEvent(e);
  return e;
}

describe('TelemetryChart wheel', () => {
  it('lets a plain wheel scroll the strips when they overflow, and zooms on Ctrl/Cmd+wheel', () => {
    fakeLayout({ width: 1000, height: 300, scrollHeight: 800 }); // 4 strips don't fit
    const onViewRangeChange = vi.fn();
    renderChart({ onViewRangeChange });
    const canvas = screen.getByTestId('telemetry-canvas');

    expect(wheel(canvas, {}).defaultPrevented).toBe(false); // native scroll goes through
    expect(wheel(canvas, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(wheel(canvas, { metaKey: true }).defaultPrevented).toBe(true);
  });

  it('zooms on a plain wheel when everything fits', () => {
    fakeLayout({ width: 1000, height: 900 });
    renderChart();
    expect(wheel(screen.getByTestId('telemetry-canvas'), {}).defaultPrevented).toBe(true);
  });
});

describe('TelemetryChart cursor', () => {
  it('publishes a click-placed cursor immediately and keeps it after the mouse leaves', () => {
    fakeLayout({ width: 1000, height: 900 });
    const onCursorTimeChange = vi.fn();
    renderChart({ onCursorTimeChange });
    const canvas = screen.getByTestId('telemetry-canvas');

    fireEvent.mouseDown(canvas, { button: 0, clientX: 500 });
    fireEvent.mouseUp(canvas, { button: 0, clientX: 500 });
    const placed = onCursorTimeChange.mock.lastCall?.[0];
    expect(typeof placed).toBe('number');
    expect(placed).toBeGreaterThan(0);
    expect(placed).toBeLessThan(10);

    fireEvent.mouseLeave(canvas);
    expect(onCursorTimeChange).toHaveBeenLastCalledWith(placed); // not null
  });

  it('clears a hover-only cursor when the mouse leaves', () => {
    fakeLayout({ width: 1000, height: 900 });
    const onCursorTimeChange = vi.fn();
    renderChart({ onCursorTimeChange });
    const canvas = screen.getByTestId('telemetry-canvas');
    fireEvent.mouseMove(canvas, { clientX: 300 });
    fireEvent.mouseLeave(canvas);
    expect(onCursorTimeChange).toHaveBeenLastCalledWith(null);
  });
});

describe('TelemetryChart drawing', () => {
  it('stops scheduling animation frames once a static chart is drawn', () => {
    fakeLayout({ width: 1000, height: 900 });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { frames.push(cb); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    renderChart();

    // Run whatever is queued; a static chart must go idle instead of looping.
    for (let i = 0; i < 10 && frames.length; i++) {
      const pending = frames.splice(0);
      act(() => pending.forEach(cb => cb(performance.now())));
    }
    expect(frames).toHaveLength(0);
  });
});

describe('TelemetryChart toolbar', () => {
  it('switches chart layout from the toolbar', () => {
    fakeLayout({ width: 1000, height: 900 });
    const onChartModeChange = vi.fn();
    renderChart({ onChartModeChange });
    fireEvent.click(screen.getByRole('radio', { name: 'Overlay' }));
    expect(onChartModeChange).toHaveBeenCalledWith('overlay');
  });

  it('shows the first-run tip once', () => {
    fakeLayout({ width: 1000, height: 900 });
    try { localStorage.removeItem('quickscope-chart-tip-dismissed'); } catch { /* ignore */ }
    const first = renderChart();
    expect(screen.getByText(/Scroll to zoom/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText(/Scroll to zoom/)).toBeNull();
    first.unmount();
    renderChart();
    expect(screen.queryByText(/Scroll to zoom/)).toBeNull();
  });
});
