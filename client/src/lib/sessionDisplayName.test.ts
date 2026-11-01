import { describe, expect, it } from 'vitest';
import {
  quickscopeSessionDisplayName,
  quickscopeSessionExportBaseName,
  quickscopeSessionExportFileBase,
} from './sessionDisplayName';
import type { LocalSession } from './api';

function session(overrides: Partial<LocalSession>): LocalSession {
  return {
    id: 'id',
    aim_session_id: '',
    filename: 'run.xrk',
    local_path: null,
    track_name: '',
    driver_name: '',
    vehicle_name: '',
    recorded_at: null,
    duration_s: 0,
    lap_count: 0,
    source: 'manual_upload',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('sessionDisplayName', () => {
  it('uses aim_session_id when set', () => {
    expect(quickscopeSessionDisplayName(session({ aim_session_id: 'Heat 2', filename: 'a_0042.xrk' }))).toBe(
      'Heat 2',
    );
  });

  it('falls back to filename in the list', () => {
    expect(quickscopeSessionDisplayName(session({ filename: 'run1.xrk' }))).toBe('run1.xrk');
  });

  it('builds export base from display name', () => {
    expect(quickscopeSessionExportBaseName('Endurance')).toBe('Endurance');
    expect(quickscopeSessionExportBaseName('run1.xrk')).toBe('run1');
  });

  it('sanitizes export file base', () => {
    expect(
      quickscopeSessionExportFileBase(session({ aim_session_id: 'Heat 2 / Test', filename: 'x.xrk' })),
    ).toBe('Heat-2-Test');
  });
});
