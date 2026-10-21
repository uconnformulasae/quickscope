// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { directionLabel, fmt } from './widgets';
import { EVDashboard } from './EVDashboard';
import { ICDashboard } from './ICDashboard';
import { LiveView } from '../LiveView';

afterEach(cleanup);

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

describe('EVDashboard', () => {
  const snap = {
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
    render(<EVDashboard latest={snap} totalReceived={42} />);
    expect(screen.getAllByText('380.0').length).toBeGreaterThan(0);
    expect(screen.getByText('100.0')).toBeTruthy();
    expect(screen.getByText('87.5')).toBeTruthy();
    expect(screen.getByText('38.0')).toBeTruthy(); // 380 V × 100 A = 38 kW
    expect(screen.getByText('55.3')).toBeTruthy();
    expect(screen.getByText('FWD')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('12.34s')).toBeTruthy();
    expect(screen.getByText('Syst')).toBeTruthy();
  });

  it('shows enabled discharge and inverter states', () => {
    render(<EVDashboard latest={snap} totalReceived={1} />);
    expect(screen.getAllByText('ENABLED')).toHaveLength(2);
  });

  it('marks state channels ON/OFF and missing ones with a dash', () => {
    render(<EVDashboard latest={snap} totalReceived={1} />);
    expect(screen.getByTitle('BMS_Disch_Enable = 1 (1 = on, 0 = off)').textContent).toContain('ON');
    expect(screen.getByTitle('lc_enabled = — (1 = on, 0 = off)').textContent).toContain('—');
  });

  it('flags active faults in red and healthy ones in green', () => {
    render(<EVDashboard latest={snap} totalReceived={1} />);
    expect(screen.getByTitle('RTD_Fault = 1').className).toContain('red');
    expect(screen.getByTitle('BSE_Fault = 0').className).toContain('emerald');
  });

  it('lists channels no panel owns under "Other channels"', () => {
    render(<EVDashboard latest={snap} totalReceived={1} />);
    expect(screen.getByTitle('Mystery_Channel')).toBeTruthy();
    expect(screen.getByText('1235')).toBeTruthy();
  });

  it('explains an empty "Other channels" panel', () => {
    render(<EVDashboard latest={{ ...snap, channels: { Pack_Voltage: 1 } }} totalReceived={1} />);
    expect(screen.getByText(/No other channels in this snapshot/)).toBeTruthy();
  });
});

describe('ICDashboard', () => {
  it('waits for the first snapshot', () => {
    render(<ICDashboard latest={null} totalReceived={0} />);
    expect(screen.getByText('waiting…')).toBeTruthy();
  });

  it('shows ECU data when engine channels are present', () => {
    render(
      <ICDashboard
        latest={{
          ts: 1000,
          subsystem: 'kkk',
          raw: '',
          channels: { S8_RPM: 6500, S8_gear: 3, S8_lam1: 0.98, S8_revCutActive: 1, S8_engineEnable: 1, '0TC01': 85.25, '0TC02': -1000, Other_X: 1.5 },
        }}
        totalReceived={5}
      />,
    );
    expect(screen.getByText('ECU data live')).toBeTruthy();
    expect(screen.getByText('6500')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('0.98')).toBeTruthy();
    expect(screen.getByText('85.3')).toBeTruthy();
    expect(screen.getByTitle('S8_revCutActive = 1').className).toContain('red');
    expect(screen.getByTitle('S8_engineEnable = 1').className).toContain('emerald');
    expect(screen.getByTitle('Other_X')).toBeTruthy();
  });

  it('explains when the ECU is silent', () => {
    render(<ICDashboard latest={{ ts: 1000, subsystem: 'kkk', raw: '', channels: { LateralAcc: 0.5 } }} totalReceived={1} />);
    expect(screen.getByText('ECU not transmitting')).toBeTruthy();
    expect(screen.getByText(/ECU CAN feed/)).toBeTruthy();
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
  });

  afterEach(() => vi.unstubAllGlobals());

  const ws = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

  it('shows the connecting state with the discovered device', () => {
    render(<LiveView onBack={() => {}} aimDevice={{ ip: '10.0.0.1', ssid: '', device_name: '', vehicle: 'UConn-EV', model: 'EVO5' }} />);
    expect(screen.getByText('Opening live stream')).toBeTruthy();
    expect(screen.getByText('Connecting to UConn-EV at 10.0.0.1…')).toBeTruthy();
  });

  it('renders the EV dashboard while streaming and supports pause/resume', () => {
    render(<LiveView onBack={() => {}} />);
    ws().receive({ type: 'connected', device: { ip: '10.0.0.1', model: 'EVO5', serial: '740', vehicle: 'UConn-EV' } });
    ws().receive({ type: 'snapshot', ts: 1000, subsystem: 'Syst', channels: { Pack_Voltage: 380 } });

    expect(screen.getByText('Streaming')).toBeTruthy();
    expect(screen.getByText('AiM EVO5')).toBeTruthy();
    expect(screen.getByText('Received 1')).toBeTruthy();
    expect(screen.getByText('Pack · 100s4p · max 415 V')).toBeTruthy();

    fireEvent.click(screen.getByText('Pause'));
    expect(screen.getByText('Paused')).toBeTruthy();
    fireEvent.click(screen.getByText('Resume'));
    expect(screen.getByText('Streaming')).toBeTruthy();
  });

  it('renders the IC dashboard for an IC car', () => {
    render(<LiveView onBack={() => {}} />);
    ws().receive({ type: 'connected', device: { ip: '10.0.0.1', model: 'EVO5', serial: '1', vehicle: 'UConn-IC' } });
    expect(screen.getByText('Engine · ECU')).toBeTruthy();
  });

  it('shows the reconnecting banner during a device drop', () => {
    render(<LiveView onBack={() => {}} />);
    ws().receive({ type: 'connected', device: { ip: '10.0.0.1', model: 'EVO5', serial: '1', vehicle: 'EV' } });
    ws().receive({ type: 'status', state: 'reconnecting' });
    expect(screen.getByText('Reconnecting to logger…')).toBeTruthy();
  });

  it('shows connection errors with a Retry button that reconnects', () => {
    render(<LiveView onBack={() => {}} />);
    ws().receive({ type: 'error', message: 'device refused' });
    expect(screen.getByText('Connection error')).toBeTruthy();
    expect(screen.getByText('device refused')).toBeTruthy();

    fireEvent.click(screen.getByText('Retry'));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('disconnect stops the stream and shows the stopped state', () => {
    render(<LiveView onBack={() => {}} />);
    const first = ws();
    first.receive({ type: 'connected', device: { ip: '10.0.0.1', model: 'EVO5', serial: '1', vehicle: 'EV' } });
    fireEvent.click(screen.getByText('Disconnect'));
    expect(first.sent).toEqual(['stop']);
    expect(screen.getByText('Live stream stopped')).toBeTruthy();
    expect(screen.getByText('Connect')).toBeTruthy();
  });

  it('calls onBack', () => {
    const onBack = vi.fn();
    render(<LiveView onBack={onBack} />);
    fireEvent.click(screen.getByTitle('Back to session browser'));
    expect(onBack).toHaveBeenCalled();
  });
});
