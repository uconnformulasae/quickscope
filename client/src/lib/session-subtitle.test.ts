import { describe, expect, it } from 'vitest';
import { sessionSubtitle } from './session-subtitle';
import { formatTime } from './xrk-parser';

const full = { vehicle: 'CT16-EV', date: 'Oct 22, 2026', time: '8:19 PM', venue: 'Standardized' };

describe('sessionSubtitle', () => {
  it('joins all parts in order', () => {
    expect(sessionSubtitle(full, 2639022, 31)).toBe(
      `CT16-EV · Oct 22, 2026 at 8:19 PM · ${formatTime(2639022)} · 31 laps · Standardized`,
    );
  });
  it('omits Unknown/empty parts with no stray separators', () => {
    const u = { vehicle: 'Unknown', date: 'Unknown', time: 'Unknown', venue: '' };
    expect(sessionSubtitle(u, 2639022, 0)).toBe(formatTime(2639022));
  });
  it('uses date only when time is Unknown', () => {
    expect(sessionSubtitle({ ...full, time: 'Unknown' }, 1000, 0)).toBe(
      `CT16-EV · Oct 22, 2026 · ${formatTime(1000)} · Standardized`,
    );
  });
});
