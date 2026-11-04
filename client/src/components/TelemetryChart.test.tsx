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
    <TelemetryChart session={session} activeChannels={active} viewRange={null} onViewRangeChange={() => {}} {...props} />,
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

describe('TelemetryChart delta cursor drag', () => {
  const at = (x: number) => ({ clientX: x, clientY: 50, button: 0 });
  // 10 s session, 1000 px wide: x → time = (x - LEFT_MARGIN) / plotW * 10
  function timeAt(x: number) { return ((x - 60) / (1000 - 60 - 12)) * 10; }

  it('drags cursor B without panning, and a press on a cursor does not re-place it', async () => {
    vi.useFakeTimers();
    fakeLayout({ width: 1000, height: 300 });
    const onViewRangeChange = vi.fn();
    renderChart({ onViewRangeChange });
    fireEvent.click(screen.getByTestId('delta-toggle'));
    const canvas = screen.getByTestId('telemetry-canvas');

    for (const x of [300, 600]) {
      fireEvent.mouseDown(canvas, at(x));
      fireEvent.mouseUp(canvas, at(x));
    }
    expect(Number(canvas.dataset.cursorB)).toBeCloseTo(timeAt(600), 2);

    fireEvent.mouseDown(canvas, at(600));
    fireEvent.mouseMove(canvas, at(700));
    fireEvent.mouseUp(canvas, at(700));
    expect(Number(canvas.dataset.cursorB)).toBeCloseTo(timeAt(700), 2);
    expect(Number(canvas.dataset.cursorA)).toBeCloseTo(timeAt(300), 2);

    fireEvent.mouseDown(canvas, at(702));
    fireEvent.mouseUp(canvas, at(702));
    expect(Number(canvas.dataset.cursorB)).toBeCloseTo(timeAt(700), 2);

    act(() => { vi.advanceTimersByTime(500); });
    expect(onViewRangeChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('TelemetryChart lap compare', () => {
  const lapSess = {
    ...makeSession({ 1: { name: 'A', samples: ramp(1001) } }), // 10 s
    lapMarkers: [
      { timestamp: 0, lapNumber: 1 },
      { timestamp: 4000, lapNumber: 2 },
      { timestamp: 7000, lapNumber: 3 },
    ],
  };

  it('shows a compare chip for 2+ selected laps and exits via its button', () => {
    fakeLayout({ width: 1000, height: 300 });
    const onClear = vi.fn();
    render(
      <TelemetryChart session={lapSess} activeChannels={[{ channelId: 1, color: '#f00' }]} viewRange={null}
        onViewRangeChange={() => {}} selectedLaps={[0, 1]} onClearLapSelection={onClear} />,
    );
    const chip = screen.getByTestId('lap-compare-chip');
    expect(chip.textContent).toContain('Lap 1');
    expect(chip.textContent).toContain('Lap 2');
    fireEvent.click(screen.getByRole('button', { name: 'Exit lap compare' }));
    expect(onClear).toHaveBeenCalled();
  });

  it('keeps compare zoom/pan inside the chart (no session view-range emits)', () => {
    vi.useFakeTimers();
    fakeLayout({ width: 1000, height: 300 });
    const onViewRangeChange = vi.fn();
    render(
      <TelemetryChart session={lapSess} activeChannels={[{ channelId: 1, color: '#f00' }]} viewRange={null}
        onViewRangeChange={onViewRangeChange} selectedLaps={[0, 1]} />,
    );
    const canvas = screen.getByTestId('telemetry-canvas');
    wheel(canvas, { ctrlKey: true });
    fireEvent.mouseDown(canvas, { clientX: 500, clientY: 50, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 50 });
    fireEvent.mouseUp(canvas, { clientX: 400, clientY: 50 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onViewRangeChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('shows no chip for a single selected lap', () => {
    fakeLayout({ width: 1000, height: 300 });
    render(
      <TelemetryChart session={lapSess} activeChannels={[{ channelId: 1, color: '#f00' }]} viewRange={null}
        onViewRangeChange={() => {}} selectedLaps={[1]} />,
    );
    expect(screen.queryByTestId('lap-compare-chip')).toBeNull();
  });
});
