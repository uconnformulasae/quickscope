// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { directionLabel, fmt } from './widgets';
import { LiveDashboard } from './LiveDashboard';
import { EV_DEFAULT_LAYOUT, IC_DEFAULT_LAYOUT } from './default-layouts';
import { type LiveLayout } from './layout-schema';
import { type Snapshot } from './live-channels';
import { LiveView } from '../LiveView';

afterEach(cleanup);

// jsdom has no matchMedia; report a narrow window so LiveDashboard stacks the
// widgets instead of measuring a react-grid-layout grid.
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => vi.unstubAllGlobals());

function renderDashboard(layout: LiveLayout, latest: Snapshot | null, totalReceived = 1) {
  return render(
    <LiveDashboard
      layout={layout}
      latest={latest}
      totalReceived={totalReceived}
      stale={false}
      editing={false}
      onGridChange={() => {}}
      onEditWidget={() => {}}
      onRemoveWidget={() => {}}
      unitOverrides={{}}
      onCycleUnit={() => {}}
    />,
  );
}

/** The panel whose heading is `title`. */
function panel(title: string): HTMLElement {
  return screen.getByText(title).closest('section, div[class*="rounded"]') as HTMLElement;
}

describe('widget helpers', () => {
  it('fmt formats finite numbers and dashes missing ones', () => {
    expect(fmt(3.14159, 2)).toBe('3.14');
    expect(fmt(0, 1)).toBe('0.0');
    expect(fmt(undefined, 1)).toBe('—');
    expect(fmt(NaN, 1)).toBe('—');
    expect(fmt(Infinity, 1)).toBe('—');
  });

  it('directionLabel maps the direction flag', () => {
    expect(directionLabel(1)).toBe('FWD');
    expect(directionLabel(0.5)).toBe('FWD');
    expect(directionLabel(0)).toBe('REV');
    expect(directionLabel(undefined)).toBe('—');
  });
});

describe('EV default layout', () => {
  const snap: Snapshot = {
    ts: 12_340,
    subsystem: 'Syst',
    raw: '',
    channels: {
      Pack_Voltage: 380,
      Pack_Current: 100,
      State_of_Charge: 87.5,
      BMS_Disch_Enable: 1,
      Motor_Temp: 55.25,
      InverterEnable: 1,
      RTD_Fault: 1,
      BSE_Fault: 0,
      Direction: 1,
      Mystery_Channel: 1234.5,
    },
  };

  it('renders pack summary, power and stream health from a snapshot', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, snap, 42);
    expect(screen.getAllByText('380.0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('100.0').length).toBeGreaterThan(0);
    expect(screen.getByText('87.5')).toBeTruthy();
    expect(screen.getByText('38.0')).toBeTruthy(); // 380 V × 100 A = 38 kW
    expect(screen.getByText('55.3')).toBeTruthy();
    expect(screen.getByText('FWD')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('12.34s')).toBeTruthy();
    expect(screen.getByText('Syst')).toBeTruthy();
  });

  it('shows enabled discharge and inverter states', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, snap);
    expect(screen.getAllByText('ENABLED')).toHaveLength(2);
  });

  it('flags discharge DISABLED only when the device actually reports 0', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, { ...snap, channels: { BMS_Disch_Enable: 0 } });
    expect(screen.getByText('DISABLED')).toBeTruthy();
  });

  it('shows no reading instead of a red DISABLED alarm or a fake 0.0 kW', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, null, 0);
    expect(screen.queryByText('DISABLED')).toBeNull();
    expect(screen.queryByText('ENABLED')).toBeNull();
    expect(screen.queryByText('0.0')).toBeNull();
  });

  it('computes pack power only once both inputs have arrived', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, { ...snap, channels: { Pack_Voltage: 400, Pack_Current: 50 } });
    expect(screen.getByText('20.0')).toBeTruthy(); // 400 V × 50 A = 20 kW
    cleanup();
    renderDashboard(EV_DEFAULT_LAYOUT, { ...snap, channels: { Pack_Voltage: 400 } });
    expect(screen.queryByText('0.0')).toBeNull();
  });

  it('marks state channels ON/OFF and missing ones with a dash', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, snap);
    expect(screen.getByTitle('BMS_Disch_Enable = 1 (1 = on, 0 = off)').textContent).toContain('ON');
    expect(screen.getByTitle('lc_enabled = — (1 = on, 0 = off)').textContent).toContain('—');
  });

  it('flags active faults in red and healthy ones in green', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, snap);
    expect(screen.getByTitle(/^RTD_Fault = 1 /).className).toContain('danger');
    expect(screen.getByTitle(/^BSE_Fault = 0 /).className).toContain('success');
  });

  it('lists channels no widget shows under "Other channels"', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, snap);
    expect(screen.getByTitle('Mystery_Channel')).toBeTruthy();
    expect(screen.getByText('1235')).toBeTruthy();
  });

  it('explains an empty "Other channels" panel', () => {
    renderDashboard(EV_DEFAULT_LAYOUT, { ...snap, channels: { Pack_Voltage: 1 } });
    expect(screen.getByText(/Every channel in this snapshot is already on the dashboard/)).toBeTruthy();
  });
});

describe('IC default layout', () => {
  it('waits for the first snapshot', () => {
    renderDashboard(IC_DEFAULT_LAYOUT, null, 0);
    expect(screen.getByText(/no other widget shows will appear here/)).toBeTruthy();
    expect(screen.queryByText('no data')).toBeNull();
  });

  it('shows ECU data when engine channels are present', () => {
    renderDashboard(IC_DEFAULT_LAYOUT, {
      ts: 1000,
      subsystem: 'kkk',
      raw: '',
      channels: { S8_RPM: 6500, S8_gear: 3, S8_lam1: 0.98, S8_revCutActive: 1, S8_engineEnable: 1, '0TC01': 85.25, '0TC02': -1000, Other_X: 1.5 },
    }, 5);
    expect(within(panel('Engine · ECU')).queryByText('no data')).toBeNull();
    expect(screen.getByText('6500')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('0.98')).toBeTruthy();
    expect(screen.getByText('85.3')).toBeTruthy();
    expect(screen.getByTitle(/^S8_revCutActive = 1 /).className).toContain('danger');
    expect(screen.getByTitle(/^S8_engineEnable = 1 /).className).toContain('success');
    expect(screen.getByTitle('Other_X')).toBeTruthy();
  });

  it('explains when the ECU is silent', () => {
    renderDashboard(IC_DEFAULT_LAYOUT, { ts: 1000, subsystem: 'kkk', raw: '', channels: { LateralAcc: 0.5 } });
    expect(within(panel('Engine · ECU')).getByText('no data')).toBeTruthy();
    expect(screen.getByText(/ECU CAN feed/)).toBeTruthy();
  });
});

describe('stat tone styling', () => {
  const layout = (warn?: number): LiveLayout => ({
    id: 't', name: 'T', vehicle: 'ev',
    widgets: [{ id: 'w', type: 'stats', title: 'Temps', style: 'tile', channels: [{ name: 'Pack_Temp', label: 'Pack Temp', precision: 1, warn }] }],
    grid: [{ i: 'w', x: 0, y: 0, w: 4, h: 6 }],
  } as LiveLayout);
  const snap: Snapshot = { ts: 1, subsystem: 'Syst', channels: { Pack_Temp: 60 }, units: {} } as Snapshot;

  /** The <p> holding the tile's value (text node + unit span). */
  const valueEl = () => screen.getByText((_, el) => el?.tagName === 'P' && el.firstChild?.textContent === '60.0');

  it('tints a tile at or above its warn threshold', () => {
    renderDashboard(layout(50), snap);
    const tileEl = valueEl().parentElement as HTMLElement;
    expect(tileEl.className).toContain('bg-warning');
  });

  it('renders primary-tone values in text-foreground', () => {
    renderDashboard(layout(), snap);
    expect(valueEl().className).toContain('text-foreground');
  });
});

describe('LiveView', () => {
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) { FakeWebSocket.instances.push(this); }
    send(d: string) { this.sent.push(d); }
    close() { this.readyState = 3; }
    receive(msg: unknown) { act(() => this.onmessage?.({ data: JSON.stringify(msg) })); }
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    // No saved layouts or cached channels: LiveView falls back to the built-ins.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('/layouts')
        ? { layouts: [], selection: {} }
        : { vehicle: 'ev', channels: [], units: {} }),
    })));
  });

  const ws = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

  it('shows the connecting state with the discovered device', () => {
    render(<LiveView onOpenSettings={() => {}} onBack={() => {}} aimDevice={{ ip: '10.0.0.1', ssid: '', device_name: '', vehicle: 'UConn-EV', model: 'EVO5' }} />);
    expect(screen.getByText('Connecting')).toBeTruthy();
    // The header shows the connection; there is no separate connecting banner.
    expect(screen.queryByText('Connecting to UConn-EV at 10.0.0.1…')).toBeNull();
    expect(screen.getByText('EVO5 · UConn-EV')).toBeTruthy();
  });

  it('renders the EV dashboard while streaming and supports pause/resume', () => {
    render(<LiveView onOpenSettings={() => {}} onBack={() => {}} />);
    ws().receive({ type: 'connected', device: { ip: '10.0.0.1', model: 'EVO5', serial: '740', vehicle: 'UConn-EV' } });
    ws().receive({ type: 'snapshot', ts: 1000, subsystem: 'Syst', channels: { Pack_Voltage: 380 } });

    expect(screen.getByText('Streaming')).toBeTruthy();
    expect(screen.getByText('EVO5 · UConn-EV')).toBeTruthy();
    expect(screen.getByTitle('Received 1')).toBeTruthy();
    expect(screen.getByText(EV_DEFAULT_LAYOUT.widgets[0].title!)).toBeTruthy();

    fireEvent.click(screen.getByText('Pause'));
    expect(screen.getByText('Paused')).toBeTruthy();
    fireEvent.click(screen.getByText('Resume'));
    expect(screen.getByText('Streaming')).toBeTruthy();
  });

  it('switches to the IC dashboard for an IC car', async () => {
    render(<LiveView onOpenSettings={() => {}} onBack={() => {}} />);
    ws().receive({ type: 'connected', device: { ip: '10.0.0.1', model: 'EVO5', serial: '1', vehicle: 'UConn-IC' } });
    // The auto-switch waits for the saved layouts to load.
    expect(await screen.findByText('Engine · ECU')).toBeTruthy();
  });

  it('shows the reconnecting banner during a device drop', () => {
    render(<LiveView onOpenSettings={() => {}} onBack={() => {}} />);
    ws().receive({ type: 'connected', device: { ip: '10.0.0.1', model: 'EVO5', serial: '1', vehicle: 'EV' } });
    ws().receive({ type: 'status', state: 'reconnecting' });
    expect(screen.getByText('Reconnecting to logger…')).toBeTruthy();
  });

  it('shows connection errors with a Retry button that reconnects', () => {
    render(<LiveView onOpenSettings={() => {}} onBack={() => {}} />);
    ws().receive({ type: 'error', message: 'device refused' });
    expect(screen.getByText('Connection error.')).toBeTruthy();
    expect(screen.getByText(/device refused/)).toBeTruthy();

    fireEvent.click(screen.getByText('Retry'));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('disconnect stops the stream and shows the stopped state', () => {
    render(<LiveView onOpenSettings={() => {}} onBack={() => {}} />);
    const first = ws();
    first.receive({ type: 'connected', device: { ip: '10.0.0.1', model: 'EVO5', serial: '1', vehicle: 'EV' } });
    fireEvent.click(screen.getByText('Disconnect'));
    expect(first.sent).toEqual(['stop']);
    expect(screen.getByText('Disconnected')).toBeTruthy();
    expect(screen.getByText('Connect')).toBeTruthy();
  });

  it('calls onBack', () => {
    const onBack = vi.fn();
    render(<LiveView onOpenSettings={() => {}} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
    expect(onBack).toHaveBeenCalled();
  });
});
