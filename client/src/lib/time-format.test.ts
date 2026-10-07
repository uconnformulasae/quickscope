import { describe, expect, it } from 'vitest';
import {
  formatChartAxisTime,
  formatChartCursorTime,
  formatChartElapsed,
  parseLogStartMs,
  resolveLogStartMs,
} from './time-format';

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

describe('parseLogStartMs', () => {
  it('parses AiM day/month/year dates with times', () => {
    expect(parseLogStartMs('05/10/2026', '14:30:00')).toBe(local(2026, 10, 5, 14, 30));
  });
  it('falls back to month/day when day/month is impossible', () => {
    expect(parseLogStartMs('10/25/2026', '08:00:00')).toBe(local(2026, 10, 25, 8));
  });
  it('accepts ISO and dash dates and HH:MM times', () => {
    expect(parseLogStartMs('2026-10-05', '09:05')).toBe(local(2026, 10, 5, 9, 5));
    expect(parseLogStartMs('05-10-2026', '')).toBe(local(2026, 10, 5));
  });
  it.each(['', 'Unknown', 'garbage', '31/02/2026'])('rejects %j', date => {
    expect(parseLogStartMs(date, '10:00:00')).toBeNull();
  });
});

describe('resolveLogStartMs', () => {
  it('prefers the stored recordedAt ISO timestamp', () => {
    expect(resolveLogStartMs('2026-10-05T14:30:00', '01/01/2000', '00:00:00')).toBe(
      Date.parse('2026-10-05T14:30:00'),
    );
  });
  it('falls back to date/time strings, then null', () => {
    expect(resolveLogStartMs(null, '05/10/2026', '14:30:00')).toBe(local(2026, 10, 5, 14, 30));
    expect(resolveLogStartMs('not-a-date', '05/10/2026', '14:30:00')).toBe(local(2026, 10, 5, 14, 30));
    expect(resolveLogStartMs(undefined)).toBeNull();
  });
});

describe('chart time labels', () => {
  const start = local(2026, 10, 5, 14, 30, 0);

  it('shows elapsed time when the log start is unknown', () => {
    expect(formatChartAxisTime(75.5, null)).toBe('1:15.5');
    expect(formatChartCursorTime(5.123, null)).toBe('5.123s');
  });

  it('shows 12-hour wall clock time when the start is known', () => {
    expect(formatChartAxisTime(0, start, 5)).toBe('2:30:00 PM');
    expect(formatChartAxisTime(90, start, 5)).toBe('2:31:30 PM');
    expect(formatChartAxisTime(0.5, start, 0.5)).toBe('2:30:00.500 PM');
  });

  it('drops seconds on minute and hour tick spacing', () => {
    expect(formatChartAxisTime(120, start, 60)).toBe('2:32 PM');
    expect(formatChartAxisTime(3600, start, 3600)).toBe('3:30 PM');
  });

  it('crosses midnight and noon correctly', () => {
    const late = local(2026, 10, 5, 23, 59, 30);
    expect(formatChartAxisTime(60, late, 5)).toBe('12:00:30 AM');
    const noon = local(2026, 10, 5, 11, 59, 30);
    expect(formatChartAxisTime(60, noon, 5)).toBe('12:00:30 PM');
  });

  it('cursor and elapsed readouts include/omit milliseconds', () => {
    expect(formatChartCursorTime(1.25, start)).toBe('2:30:01.250 PM');
    expect(formatChartElapsed(61_000, start)).toBe('2:31:01 PM');
  });
});
