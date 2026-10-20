// @vitest-environment jsdom
import '../../test/dom-setup';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EVDashboard } from './EVDashboard';
import { CHANNEL_META, type Snapshot } from './live-channels';

function snapshot(channels: Record<string, number>): Snapshot {
  return { ts: 0, subsystem: 'Syst', raw: '', channels };
}

describe('EVDashboard with no data', () => {
  it('shows no reading instead of a red DISABLED alarm or a fake 0.0 kW', () => {
    render(<EVDashboard latest={null} totalReceived={0} />);
    expect(screen.queryByText('DISABLED')).toBeNull();
    expect(screen.queryByText('ENABLED')).toBeNull();
    expect(screen.queryByText('0.0')).toBeNull();
  });
});

describe('EVDashboard with data', () => {
  it('computes pack power and shows the discharge state', () => {
    render(<EVDashboard latest={snapshot({ Pack_Voltage: 400, Pack_Current: 50, BMS_Disch_Enable: 1 })} totalReceived={1} />);
    expect(screen.getByText('20.0')).toBeTruthy(); // 400 V * 50 A = 20 kW
    expect(screen.getByText('ENABLED')).toBeTruthy();
  });

  it('flags discharge DISABLED only when the device actually reports 0', () => {
    render(<EVDashboard latest={snapshot({ BMS_Disch_Enable: 0 })} totalReceived={1} />);
    expect(screen.getByText('DISABLED')).toBeTruthy();
  });

  it('only advertises channels the backend can actually decode (no live GPS)', () => {
    expect(CHANNEL_META.filter(m => m.name.startsWith('GPS_'))).toEqual([]);
  });
});
