import { BOOL_CHANNELS, IC_ENGINE_FLAGS, IC_ENGINE_STATS, IC_TC_DISCONNECTED } from './live-channels';
import { BUILTIN_ID, type ChannelRef, type GridItem, type LiveLayout, type WidgetConfig } from './layout-schema';

// ────────────────────────────────────────────────────────────────────────────
// Shipped dashboards — the former hand-built EVDashboard / ICDashboard
// expressed as layouts. They're read-only: editing one saves a copy.
// ────────────────────────────────────────────────────────────────────────────

// CT-17 EV: 100s4p pack, 4.15 V/cell cap → 415 V max, 370 V nominal; Orion
// derates above 45 °C pack temp (CT17_EV_Powertrain_Binder_Context).
const PACK_TEMP_DERATE = 45;

type Placed = WidgetConfig & { at: Omit<GridItem, 'i'> };

function build(id: string, name: string, vehicle: 'ev' | 'ic', placed: Placed[]): LiveLayout {
  return {
    id,
    name,
    vehicle,
    version: 1,
    builtIn: true,
    widgets: placed.map(({ at: _at, ...w }) => w),
    grid: placed.map(({ id: i, at }) => ({ i, ...at })),
    updatedAt: '2026-10-19T00:00:00.000Z',
  };
}

const imu: ChannelRef[] = [
  { name: 'LateralAcc', label: 'Lat G' },
  { name: 'InlineAcc', label: 'Long G' },
  { name: 'VerticalAcc', label: 'Vert G' },
  { name: 'YawRate', label: 'Yaw' },
  { name: 'RollRate', label: 'Roll' },
  { name: 'PitchRate', label: 'Pitch' },
];

export const EV_DEFAULT_LAYOUT = build(BUILTIN_ID.ev, 'EV default', 'ev', [
  {
    id: 'ev-pack', type: 'stats', style: 'big', columns: 4, emphasis: true,
    title: 'Pack · 100s4p · max 415 V · nom 370 V',
    channels: [
      { name: 'Pack_Voltage', label: 'Pack Voltage', tone: 'primary' },
      { name: 'Pack_Current', label: 'Pack Current', tone: 'primary' },
      { name: 'State_of_Charge', label: 'SOC', tone: 'emerald' },
      { name: '', expr: 'Pack_Voltage * Pack_Current / 1000', label: 'Pack Power', unit: 'kW', precision: 1, tone: 'amber' },
    ],
    at: { x: 0, y: 0, w: 12, h: 4 },
  },
  {
    id: 'ev-accumulator', type: 'stats', style: 'tile', columns: 2,
    title: 'Accumulator · 5 modules · 20s4p each',
    channels: [
      { name: 'Pack_Voltage', label: 'Pack Voltage', tone: 'emerald' },
      { name: 'Pack_Temp', label: 'Pack Temp', tone: 'emerald', crit: PACK_TEMP_DERATE },
      { name: 'Min_Cell_Voltage', label: 'Min Cell V', tone: 'emerald' },
      { name: 'BMS_LV_input', label: 'BMS LV', tone: 'emerald' },
      { name: 'BMS_Disch_Lim', label: 'I Limit', tone: 'muted' },
      { name: 'BMS_Disch_Enable', label: 'Discharge', format: 'onoff' },
    ],
    note: "Per-module voltages aren't broadcast on the AiM live stream — Orion BMS only exposes pack aggregates.",
    at: { x: 0, y: 4, w: 4, h: 9 },
  },
  {
    id: 'ev-cooling', type: 'stats', style: 'tile', columns: 2,
    title: 'Cooling',
    channels: [
      { name: 'Motor_Temp', label: 'Motor Temp', tone: 'emerald' },
      { name: 'Pack_Temp', label: 'Pack Temp', tone: 'primary', crit: PACK_TEMP_DERATE },
      { name: 'Logger Temperature', label: 'Logger', tone: 'muted' },
    ],
    note: 'Motor_Temp and Pack_Temp are the only thermal readings on the AiM live stream; inverter/coolant telemetry stays on the Cascadia CAN bus.',
    at: { x: 4, y: 4, w: 3, h: 9 },
  },
  {
    id: 'ev-vehicle', type: 'stats', style: 'compact',
    title: 'Vehicle',
    channels: [
      { name: 'LFspeed', label: 'Speed', precision: 0 },
      { name: 'RPM', label: 'RPM', unit: '' },
      ...imu,
      { name: 'BSE_Voltage', label: 'BSE' },
      { name: 'Direction', label: 'Dir', format: 'direction' },
    ],
    at: { x: 7, y: 4, w: 5, h: 9 },
  },
  {
    id: 'ev-pedals', type: 'bars',
    title: 'Pedals & brakes',
    channels: [
      { name: 'Throttle_Pos', label: 'Throttle', min: 0, max: 100, tone: 'emerald' },
      { name: 'TPS_1', label: 'TPS 1', min: 0, max: 100, tone: 'emerald' },
      { name: 'TPS_2', label: 'TPS 2', min: 0, max: 100, tone: 'emerald' },
      { name: 'FrBrakePressure', label: 'Front brake', min: 0, max: 800, tone: 'red' },
      { name: 'RBrkPressure', label: 'Rear brake', min: 0, max: 800, tone: 'red' },
      { name: 'BrakeBias', label: 'Brake bias', min: 0, max: 100, tone: 'muted' },
    ],
    at: { x: 0, y: 13, w: 4, h: 9 },
  },
  {
    id: 'ev-inverter', type: 'stats', style: 'tile',
    title: 'Inverter & Motor · Cascadia CM200DX',
    channels: [
      { name: 'Torque_Command', label: 'Torque Cmd', tone: 'emerald' },
      { name: 'Torque_Feedback', label: 'Torque Fdbk', tone: 'emerald' },
      { name: 'MCU_Torque_Limit', label: 'Torque Lim', tone: 'muted' },
      { name: 'MCU_DC_Current', label: 'MCU DC Current', tone: 'amber' },
      { name: 'InverterEnable', label: 'Inverter State', format: 'onoff' },
      { name: 'Phase_A_Current', label: 'Phase A', tone: 'muted' },
      { name: 'Phase_B_Current', label: 'Phase B', tone: 'muted' },
      { name: 'Phase_C_Current', label: 'Phase C', tone: 'muted' },
      { name: 'Id_Feeback', label: 'Id Feedback', tone: 'muted' },
      { name: 'Iq_Feedback', label: 'Iq Feedback', tone: 'muted' },
    ],
    at: { x: 4, y: 13, w: 8, h: 9 },
  },
  {
    id: 'ev-status', type: 'boolGroup',
    title: 'Status & Faults',
    channels: BOOL_CHANNELS.map((b) => ({ name: b.name, label: b.label, kind: b.kind })),
    at: { x: 0, y: 22, w: 12, h: 5 },
  },
  {
    id: 'ev-other', type: 'otherChannels', title: 'Other channels', channels: [],
    at: { x: 0, y: 27, w: 9, h: 8 },
  },
  {
    id: 'ev-stream', type: 'streamHealth', title: 'Stream health', channels: [],
    at: { x: 9, y: 27, w: 3, h: 8 },
  },
]);

const HERO_IC = ['S8_RPM', 'S8_gear', 'S8_tps1', 'S8_lam1'];

export const IC_DEFAULT_LAYOUT = build(BUILTIN_ID.ic, 'IC default', 'ic', [
  {
    id: 'ic-engine', type: 'stats', style: 'big', columns: 4, emphasis: true,
    title: 'Engine · ECU',
    channels: [
      { name: 'S8_RPM', label: 'RPM', tone: 'primary' },
      { name: 'S8_gear', label: 'Gear', tone: 'emerald' },
      { name: 'S8_tps1', label: 'TPS', tone: 'amber' },
      { name: 'S8_lam1', label: 'Lambda', tone: 'primary' },
    ],
    note: 'No data on every S8_* channel means the ECU CAN feed isn\'t reaching the logger (key off, ECU unpowered or CAN unplugged).',
    at: { x: 0, y: 0, w: 12, h: 5 },
  },
  {
    id: 'ic-ecu', type: 'stats', style: 'compact', columns: 8,
    title: 'ECU',
    channels: IC_ENGINE_STATS.filter((s) => !HERO_IC.includes(s.name)).map((s) => ({ name: s.name, label: s.label })),
    at: { x: 0, y: 5, w: 12, h: 4 },
  },
  {
    id: 'ic-chassis', type: 'stats', style: 'compact', columns: 3,
    title: 'Chassis',
    channels: imu,
    at: { x: 0, y: 9, w: 5, h: 6 },
  },
  {
    id: 'ic-brakes', type: 'stats', style: 'compact', columns: 3,
    title: 'Brakes',
    channels: [
      { name: 'FBrakePressCorr', label: 'Front', precision: 1 },
      { name: 'RBrakePressCorr', label: 'Rear', precision: 1 },
      { name: 'Brake_Bias', label: 'Bias', precision: 1 },
    ],
    at: { x: 5, y: 9, w: 4, h: 6 },
  },
  {
    id: 'ic-tires', type: 'stats', style: 'compact', columns: 2,
    title: 'Tires · Electrical',
    channels: [
      ...['0TC01', '0TC02', '0TC03', '0TC04'].map((name, i) => ({
        name, label: `TC${i + 1}`, precision: 1, invalidBelow: IC_TC_DISCONNECTED,
      })),
      { name: 'External Voltage', label: 'Ext Voltage' },
    ],
    at: { x: 9, y: 9, w: 3, h: 10 },
  },
  {
    id: 'ic-wheels', type: 'stats', style: 'compact', columns: 4,
    title: 'Wheel speed',
    channels: [
      { name: 'S8_lfSpeed', label: 'LF', precision: 1 },
      { name: 'S8_rfspeed', label: 'RF', precision: 1 },
      { name: 'S8_lrSpeed', label: 'LR', precision: 1 },
      { name: 'S8_rrSpeed', label: 'RR', precision: 1 },
    ],
    at: { x: 0, y: 15, w: 5, h: 4 },
  },
  {
    id: 'ic-rotor', type: 'stats', style: 'compact', columns: 4,
    title: 'LF rotor temp (CH1–4)',
    channels: ['LF_BRKTempCH1', 'LF_BRKTempCH2', 'LF_BRKTempCH3', 'LF_BRKTempCH4'].map((name, i) => ({
      name, label: `CH${i + 1}`, unit: '°C', precision: 1,
    })),
    at: { x: 5, y: 15, w: 4, h: 4 },
  },
  {
    id: 'ic-status', type: 'boolGroup',
    title: 'Status',
    channels: IC_ENGINE_FLAGS.map((f) => ({ name: f.name, label: f.label, kind: f.kind })),
    at: { x: 0, y: 19, w: 12, h: 4 },
  },
  {
    id: 'ic-other', type: 'otherChannels', title: 'Other channels', channels: [],
    at: { x: 0, y: 23, w: 9, h: 8 },
  },
  {
    id: 'ic-stream', type: 'streamHealth', title: 'Stream health', channels: [],
    at: { x: 9, y: 23, w: 3, h: 8 },
  },
]);

export const BUILTIN_LAYOUTS: LiveLayout[] = [EV_DEFAULT_LAYOUT, IC_DEFAULT_LAYOUT];
