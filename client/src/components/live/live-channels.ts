export interface Snapshot {
  ts: number;
  subsystem: string;
  raw: string;
  channels?: Record<string, number>;  // populated in preview mode; real frames decode this client-side later
}

export interface ChannelMeta {
  name: string;
  unit: string;
  /** rendering hint — how many decimals to show */
  precision: number;
}

export const RING_BUFFER_SIZE = 240; // 60 s at ~4 Hz

// Channel metadata. Names match the EXACT names the AiM device publishes
// in its channel-config frame (verified against
// docs/protocol/captures/analysis/q6_full_records.py extraction of the
// 103-channel record list). When the real-device decoder lands, channels
// arrive in `snap.channels` keyed by exactly these names — no translation
// layer.
//
// Constants below are CT-17 EV: 100s4p pack, 5 modules of 20s4p, 4.15 V/
// cell ESF cap → pack max 415 V, nominal 370 V (per
// CT17_EV_Powertrain_Binder_Context).
export const PACK_V_MAX = 415;
export const PACK_V_NOMINAL = 370;
export const PACK_TEMP_DERATE = 45;

export const CHANNEL_META: ChannelMeta[] = [
  // Vehicle dynamics
  { name: 'RPM',                unit: 'rpm', precision: 0 },
  { name: 'LFspeed',            unit: 'kph', precision: 1 },
  { name: 'Throttle_Pos',       unit: '%',   precision: 0 },
  { name: 'TPS_1',              unit: '%',   precision: 1 },
  { name: 'TPS_2',              unit: '%',   precision: 1 },
  { name: 'BSE_Voltage',        unit: 'V',   precision: 2 },
  { name: 'Direction',          unit: '',    precision: 0 },
  { name: 'BrakeBias',          unit: '%',   precision: 1 },
  // IMU
  { name: 'LateralAcc',         unit: 'g',   precision: 2 },
  { name: 'InlineAcc',          unit: 'g',   precision: 2 },
  { name: 'VerticalAcc',        unit: 'g',   precision: 2 },
  { name: 'YawRate',            unit: '°/s', precision: 1 },
  { name: 'RollRate',           unit: '°/s', precision: 1 },
  { name: 'PitchRate',          unit: '°/s', precision: 1 },
  // Brake pressure
  { name: 'FrBrakePressure',    unit: 'psi', precision: 0 },
  { name: 'RBrkPressure',       unit: 'psi', precision: 0 },
  // Pack (Orion BMS aggregates — only what the live stream carries)
  { name: 'Pack_Voltage',       unit: 'V',   precision: 1 },
  { name: 'Pack_Current',       unit: 'A',   precision: 1 },
  { name: 'State_of_Charge',    unit: '%',   precision: 1 },
  { name: 'Pack_Temp',          unit: '°C',  precision: 1 },
  { name: 'Min_Cell_Voltage',   unit: 'V',   precision: 3 },
  { name: 'BMS_Disch_Lim',      unit: 'A',   precision: 0 },
  { name: 'BMS_Disch_Enable',   unit: '',    precision: 0 },
  { name: 'BMS_LV_input',       unit: 'V',   precision: 2 },
  // Motor + Inverter (Cascadia CM200DX → Emrax 228 LC)
  { name: 'Motor_Temp',         unit: '°C',  precision: 1 },
  { name: 'Torque_Command',     unit: 'Nm',  precision: 0 },
  { name: 'Torque_Feedback',    unit: 'Nm',  precision: 0 },
  { name: 'MCU_Torque_Limit',   unit: 'Nm',  precision: 0 },
  { name: 'MCU_DC_Current',     unit: 'A',   precision: 1 },
  { name: 'Phase_A_Current',    unit: 'A',   precision: 0 },
  { name: 'Phase_B_Current',    unit: 'A',   precision: 0 },
  { name: 'Phase_C_Current',    unit: 'A',   precision: 0 },
  { name: 'Id_Feeback',         unit: 'A',   precision: 0 },
  { name: 'Iq_Feedback',        unit: 'A',   precision: 0 },
  { name: 'InverterEnable',     unit: '',    precision: 0 },
  // External voltages / logger
  { name: 'External Voltage',   unit: 'V',   precision: 2 },
  { name: 'Logger Temperature', unit: '°C',  precision: 1 },
  // GPS (channel #13, 56-byte struct at offset 168 of the live frame)
  { name: 'GPS_Lat',            unit: '°',   precision: 6 },
  { name: 'GPS_Lon',            unit: '°',   precision: 6 },
  { name: 'GPS_Speed',          unit: 'kph', precision: 1 },
  { name: 'GPS_Heading',        unit: '°',   precision: 1 },
  { name: 'GPS_Altitude',       unit: 'm',   precision: 1 },
  { name: 'GPS_Sats',           unit: '',    precision: 0 },
];

// Boolean / state channels from the AiM channel-config. Each carries 0/1
// on the wire — meaningless as a number, very meaningful as a label.
// Polarity differs by channel: for "state" 1 = enabled (green); for
// "fault" 1 = active fault (red).
export type BoolKind = 'state' | 'fault';
export interface BoolChannelMeta {
  name: string;
  label: string;
  kind: BoolKind;
}
export const BOOL_CHANNELS: BoolChannelMeta[] = [
  // Enable / state (1 = active / good)
  { name: 'BMS_Disch_Enable',   label: 'BMS Discharge',  kind: 'state' },
  { name: 'InverterEnable',     label: 'Inverter',       kind: 'state' },
  { name: 'lc_enabled',         label: 'Launch Control', kind: 'state' },
  { name: 'lc_sensor_health',   label: 'LC Sensors OK',  kind: 'state' },
  { name: 'cut_rate_active',    label: 'Cut-rate Active',kind: 'state' },
  { name: 'StartRec',           label: 'Logging',        kind: 'state' },
  // Faults (1 = fault active / BAD)
  { name: 'RTD_Fault',           label: 'RTD',                 kind: 'fault' },
  { name: 'BSE_Fault',           label: 'BSE Plausibility',    kind: 'fault' },
  { name: 'TPS1_OOR_Fault',      label: 'TPS1 Out of Range',   kind: 'fault' },
  { name: 'TPS2_OOR_Fault',      label: 'TPS2 Out of Range',   kind: 'fault' },
  { name: 'APPS_Dist_Fault',     label: 'APPS Plausibility',   kind: 'fault' },
  { name: 'DC_Undervoltage',     label: 'DC Undervoltage',     kind: 'fault' },
  { name: 'InverterTempHi',      label: 'Inverter Temp Hi',    kind: 'fault' },
  { name: 'InverterTempLo',      label: 'Inverter Temp Lo',    kind: 'fault' },
  { name: 'MCU_LV_Out_of_Range', label: 'MCU LV OOR',          kind: 'fault' },
  { name: 'MotorOverTemp',       label: 'Motor Over Temp',     kind: 'fault' },
  { name: 'MotorOverSpeed',      label: 'Motor Over Speed',    kind: 'fault' },
  { name: 'InvOverVolt',         label: 'Inverter OverVolt',   kind: 'fault' },
  { name: 'HWOverCurrent',       label: 'HW Over Current',     kind: 'fault' },
  { name: 'CANCommandLost',      label: 'CAN Cmd Lost',        kind: 'fault' },
];

// CT-17 has 5 modules of 20s4p (80 cells/module). Per-module data is NOT
// in the AiM live stream — Orion BMS broadcasts pack-level aggregates only
// (Pack_Voltage, Pack_Temp, Min_Cell_Voltage, SOC). The Accumulator panel
// is structured around those plus BMS state channels.
export const NUM_MODULES = 5;

// Channels rendered by an explicit panel. The "Other" panel filters
// everything NOT in this set so newly-added device channels (e.g. the ~70
// fault/alarm bits, launch-control telemetry, lap timing) appear
// automatically without layout edits.
export const PANEL_OWNED_CHANNELS = new Set<string>([
  // Pack hero
  'Pack_Voltage', 'Pack_Current', 'State_of_Charge',
  // Accumulator (Orion-exposed)
  'Pack_Temp', 'Min_Cell_Voltage', 'BMS_Disch_Lim', 'BMS_Disch_Enable', 'BMS_LV_input',
  // Cooling
  'Motor_Temp',
  // Vehicle dynamics
  'Throttle_Pos', 'TPS_1', 'TPS_2', 'BSE_Voltage', 'LFspeed', 'RPM', 'YawRate', 'RollRate', 'PitchRate',
  'LateralAcc', 'InlineAcc', 'VerticalAcc',
  'FrBrakePressure', 'RBrkPressure', 'BrakeBias', 'Direction',
  // Inverter / motor
  'Torque_Command', 'Torque_Feedback', 'MCU_Torque_Limit', 'MCU_DC_Current',
  'Phase_A_Current', 'Phase_B_Current', 'Phase_C_Current',
  'Id_Feeback', 'Iq_Feedback', 'InverterEnable',
  // GPS (rendered in the Track panel)
  'GPS_Lat', 'GPS_Lon', 'GPS_Speed', 'GPS_Heading', 'GPS_Altitude', 'GPS_Sats',
  // Boolean state + fault channels (rendered in the Status & Faults panel)
  ...BOOL_CHANNELS.map((b) => b.name),
]);

// ── Vehicle profile ─────────────────────────────────────────────────────────
// The logger's discovery reply names the car ("UConn-EV" / "UConn-IC"). The
// channel set differs completely between them (the IC layout is 85 channels
// with an ECU "S8_*" block; the EV layout is the 113-channel Orion/Cascadia
// set), so the dashboard is chosen from that name.
export type VehicleKind = 'ev' | 'ic';

export function vehicleKind(vehicle: string | undefined): VehicleKind {
  return /(^|[^a-z])ic([^a-z]|$)/i.test(vehicle ?? '') ? 'ic' : 'ev';
}

// IC channels (names verbatim from the UConn-IC layout, IC_RS3_live.pcapng).
export const IC_ENGINE_STATS: { name: string; label: string; unit: string; precision: number }[] = [
  { name: 'S8_RPM',      label: 'RPM',         unit: 'rpm', precision: 0 },
  { name: 'S8_gear',     label: 'Gear',        unit: '',    precision: 0 },
  { name: 'S8_tps1',     label: 'TPS',         unit: '',    precision: 1 },
  { name: 'S8_map1',     label: 'MAP',         unit: '',    precision: 1 },
  { name: 'S8_ect1',     label: 'Coolant',     unit: '',    precision: 1 },
  { name: 'S8_eot',      label: 'Oil Temp',    unit: '',    precision: 1 },
  { name: 'S8_eop',      label: 'Oil Press',   unit: '',    precision: 1 },
  { name: 'S8_fp1',      label: 'Fuel Press',  unit: '',    precision: 1 },
  { name: 'S8_lam1',     label: 'Lambda',      unit: '',    precision: 2 },
  { name: 'S8_vbat',     label: 'ECU Batt',    unit: '',    precision: 2 },
  { name: 'S8_ignFinal1',label: 'Ign Final',   unit: '',    precision: 1 },
  { name: 'S8_fuelFinalPri1', label: 'Fuel Final', unit: '', precision: 2 },
];
export const IC_WHEEL_SPEEDS = ['S8_lfSpeed', 'S8_rfspeed', 'S8_lrSpeed', 'S8_rrSpeed'] as const;
export const IC_ENGINE_FLAGS: { name: string; label: string; kind: BoolKind }[] = [
  { name: 'S8_engineEnable',   label: 'Engine Enable', kind: 'state' },
  { name: 'S8_LaunchSwitch',   label: 'Launch',        kind: 'state' },
  { name: 'S8_revLimitActiv',  label: 'Rev Limit',     kind: 'fault' },
  { name: 'S8_revCutActive',   label: 'Rev Cut',       kind: 'fault' },
  { name: 'S8_limpmode',       label: 'Limp Mode',     kind: 'fault' },
  { name: 'loggingActive',     label: 'Logging',       kind: 'state' },
  { name: 'StartRec',          label: 'Recording',     kind: 'state' },
];
export const IC_BRAKE_TEMPS = ['LF_BRKTempCH1', 'LF_BRKTempCH2', 'LF_BRKTempCH3', 'LF_BRKTempCH4'] as const;
export const IC_TIRE_TEMPS = ['0TC01', '0TC02', '0TC03', '0TC04'] as const;
// A disconnected thermocouple input reads this raw floor on the wire.
export const IC_TC_DISCONNECTED = -1000;

export const IC_PANEL_OWNED_CHANNELS = new Set<string>([
  ...IC_ENGINE_STATS.map((s) => s.name),
  ...IC_WHEEL_SPEEDS,
  ...IC_ENGINE_FLAGS.map((f) => f.name),
  ...IC_BRAKE_TEMPS,
  ...IC_TIRE_TEMPS,
  'LateralAcc', 'InlineAcc', 'VerticalAcc', 'YawRate', 'RollRate', 'PitchRate',
  'FBrakePressCorr', 'RBrakePressCorr', 'Brake_Bias',
  'External Voltage',
]);
