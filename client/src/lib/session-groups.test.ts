import { describe, expect, it } from 'vitest';
import { groupSessionsByDate } from './session-groups';

const now = new Date(2026, 9, 29, 21, 0);
const s = (id: string, recorded_at: string | null, created_at = '2026-01-01T00:00:00') => ({ id, recorded_at, created_at });

describe('groupSessionsByDate', () => {
  it('groups into Today, This Week, then months newest first', () => {
    const groups = groupSessionsByDate(
      [s('jun', '2026-06-06T10:00:00'), s('oct9', '2026-10-09T10:00:00'), s('week', '2026-10-25T10:00:00'), s('today', '2026-10-29T08:00:00')],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'This Week', 'October 2026', 'June 2026']);
    expect(groups.map((g) => g.sessions[0].id)).toEqual(['today', 'week', 'oct9', 'jun']);
  });

  it('falls back to created_at when recorded_at is null', () => {
    const groups = groupSessionsByDate([s('a', null, '2026-10-29T01:00:00')], now);
    expect(groups.map((g) => g.label)).toEqual(['Today']);
  });

  it('puts unparseable dates last under Earlier', () => {
    const groups = groupSessionsByDate([s('bad', 'garbage', 'garbage'), s('today', '2026-10-29T08:00:00')], now);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Earlier']);
    expect(groups[1].sessions[0].id).toBe('bad');
  });

  it('sorts newest first within a group', () => {
    const groups = groupSessionsByDate([s('a', '2026-10-01T10:00:00'), s('b', '2026-10-03T10:00:00'), s('c', '2026-10-02T10:00:00')], now);
    expect(groups[0].sessions.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns [] for no sessions', () => {
    expect(groupSessionsByDate([], now)).toEqual([]);
  });
});
