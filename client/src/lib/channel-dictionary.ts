/**
 * Channel dictionary — plain-English names for the logger's channel codes.
 *
 * The AiM logger stores one short code per channel (e.g. `FBrakePressure`,
 * `Id_Feeback`, `S8_lam1`). This table gives each known code a readable
 * label, a one-line description, a category and (for channels recipes need)
 * a semantic role. Entries are hand-written from the team's EV logs, the EV
 * and IC live layouts (live/live-channels.ts) and common AiM / ECU naming.
 *
 * Anything we can't identify with confidence is marked `uncertain` so the UI
 * can say so instead of presenting a guess as fact. Codes that aren't in the
 * table keep working everywhere under their own name.
 */

import type { ChannelDef, XRKSession } from './xrk-parser';

export type CarType = 'ev' | 'ic' | 'unknown';

export type ChannelCategory =
  | 'Driver Inputs'
  | 'Brakes'
  | 'Chassis & IMU'
  | 'Wheels & Speed'
  | 'GPS'
  | 'Battery'
  | 'Motor & Inverter'
  | 'Engine'
  | 'Fuel'
  | 'Temperatures'
  | 'Faults & Alarms'
  | 'Status'
  | 'Logger'
  | 'Your Channels'
  | 'Other';

export interface ChannelInfo {
  code: string;
  label: string;
  description: string;
  category: ChannelCategory;
  /** Semantic tag recipes match on, e.g. `pack_voltage`. */
  role?: string;
  /** Lower wins when several channels share a role (default 10). */
  roleRank?: number;
  /** The meaning is a best guess. */
  uncertain?: boolean;
  /** False when the code isn't in the dictionary at all. */
  known: boolean;
}

interface Entry {
  label: string;
  description: string;
  category: ChannelCategory;
  role?: string;
  roleRank?: number;
  uncertain?: boolean;
  /** Extra spellings matched after normalising (case, spaces, _ and -). */
  aliases?: string[];
  /** Overrides when the same code means different things on each car. */
  byCar?: Partial<Record<'ev' | 'ic', Partial<Omit<Entry, 'byCar' | 'aliases'>>>>;
}

const e = (category: ChannelCategory, label: string, description: string, extra: Partial<Entry> = {}): Entry =>
  ({ category, label, description, ...extra });

const fault = (label: string, description: string, extra: Partial<Entry> = {}) => e('Faults & Alarms', label, description, extra);
const alarm = (what: string) => fault(`${what} Alarm`, `Logger alarm that turns on when the "${what}" fault is active`);

// ─── EV (and shared logger / IMU / GPS) channels ────────────────────────────

const ENTRIES: Record<string, Entry> = {
  // Driver inputs
  Throttle_Pos: e('Driver Inputs', 'Throttle Position', 'Accelerator pedal position used by the car (%)', { role: 'throttle' }),
  TPS_1: e('Driver Inputs', 'Throttle Sensor 1', 'Accelerator pedal sensor 1 reading (%)'),
  TPS_2: e('Driver Inputs', 'Throttle Sensor 2', 'Accelerator pedal sensor 2 reading (%)'),
  TPS_1_Voltage: e('Driver Inputs', 'Throttle Sensor 1 Voltage', 'Raw voltage from accelerator pedal sensor 1'),
  TPS_2_Voltage: e('Driver Inputs', 'Throttle Sensor 2 Voltage', 'Raw voltage from accelerator pedal sensor 2'),
  BSE_Voltage: e('Brakes', 'Brake Pedal Sensor Voltage', 'Raw voltage from the brake system encoder (brake pedal sensor)'),
  Direction: e('Driver Inputs', 'Drive Direction', 'Motor direction: forward or reverse'),

  // Brakes
  FBrakePressure: e('Brakes', 'Front Brake Pressure', 'Hydraulic pressure in the front brake circuit', { role: 'brake_pressure_front', roleRank: 2 }),
  FBrakePressCorr: e('Brakes', 'Front Brake Pressure (corrected)', 'Front brake pressure after calibration correction', { role: 'brake_pressure_front', roleRank: 1 }),
  FrBrakePressure: e('Brakes', 'Front Brake Pressure', 'Hydraulic pressure in the front brake circuit (live stream)', { role: 'brake_pressure_front', roleRank: 2 }),
  RBrakePressCorr: e('Brakes', 'Rear Brake Pressure', 'Rear brake circuit pressure after calibration correction', { role: 'brake_pressure_rear', roleRank: 1 }),
  RBrakePressure: e('Brakes', 'Rear Brake Pressure (raw)', 'Uncorrected rear brake circuit pressure — prefer Rear Brake Pressure'),
  RBrkPressure: e('Brakes', 'Rear Brake Pressure', 'Hydraulic pressure in the rear brake circuit (live stream)', { role: 'brake_pressure_rear', roleRank: 2 }),
  BrakeBias: e('Brakes', 'Brake Bias', 'Share of braking on the front axle, calculated by the logger (%)'),
  Brake_Bias: e('Brakes', 'Brake Bias', 'Share of braking on the front axle, calculated by the logger (%)'),
  LVCU_brakes: e('Brakes', 'Brake Signal (LVCU)', 'Brake signal as seen by the low-voltage control unit', { uncertain: true }),
  LF_BRKSensorTemp: e('Temperatures', 'Left-Front Brake Sensor Temp', 'Temperature of the left-front brake temperature sensor body'),
  LF_BRKTempCH1: e('Temperatures', 'Left-Front Brake Temp 1', 'Left-front brake rotor temperature, sensor channel 1'),
  LF_BRKTempCH2: e('Temperatures', 'Left-Front Brake Temp 2', 'Left-front brake rotor temperature, sensor channel 2'),
  LF_BRKTempCH3: e('Temperatures', 'Left-Front Brake Temp 3', 'Left-front brake rotor temperature, sensor channel 3'),
  LF_BRKTempCH4: e('Temperatures', 'Left-Front Brake Temp 4', 'Left-front brake rotor temperature, sensor channel 4'),

  // Chassis / IMU (logger's built-in sensors)
  LateralAcc: e('Chassis & IMU', 'Lateral G', 'Sideways acceleration from the logger (cornering g)', { role: 'lat_accel' }),
  InlineAcc: e('Chassis & IMU', 'Longitudinal G', 'Forward/backward acceleration from the logger (accel and braking g)', { role: 'long_accel' }),
  VerticalAcc: e('Chassis & IMU', 'Vertical G', 'Up/down acceleration from the logger'),
  YawRate: e('Chassis & IMU', 'Yaw Rate', 'How fast the car is rotating left/right (deg/s)'),
  RollRate: e('Chassis & IMU', 'Roll Rate', 'How fast the car is rolling side to side (deg/s)'),
  PitchRate: e('Chassis & IMU', 'Pitch Rate', 'How fast the car is pitching nose up/down (deg/s)'),

  // Wheels & speed
  LFspeed: e('Wheels & Speed', 'Left-Front Wheel Speed', 'Speed measured at the left-front wheel', { role: 'wheel_speed' }),
  RPM: e('Motor & Inverter', 'RPM', 'Rotational speed (motor on the EV, engine on the IC car)', {
    byCar: {
      ev: { label: 'Motor RPM', description: 'Electric motor speed', role: 'motor_rpm', category: 'Motor & Inverter' },
      ic: { label: 'Engine RPM', description: 'Engine speed', role: 'engine_rpm', category: 'Engine' },
    },
  }),

  // GPS
  'GPS Speed': e('GPS', 'GPS Speed', 'Vehicle speed from GPS', { role: 'gps_speed' }),
  'GPS Latitude': e('GPS', 'GPS Latitude', 'North/south position'),
  'GPS Longitude': e('GPS', 'GPS Longitude', 'East/west position'),
  'GPS Altitude': e('GPS', 'GPS Altitude', 'Height above sea level'),
  GPS_Fix: e('GPS', 'GPS Fix', 'Quality of the GPS position lock'),
  GPS_Satellites: e('GPS', 'GPS Satellites', 'Number of satellites in view'),
  GPS_pDOP: e('GPS', 'GPS Precision (PDOP)', 'Position dilution of precision — lower is more accurate'),
  GPS_Position_Accuracy: e('GPS', 'GPS Position Accuracy', 'Estimated position error'),
  GPS_Velocity_Accuracy: e('GPS', 'GPS Speed Accuracy', 'Estimated speed error'),
  GPS_InlineAcc: e('GPS', 'GPS Longitudinal G', 'Forward/backward acceleration calculated from GPS'),
  GPS_LateralAcc: e('GPS', 'GPS Lateral G', 'Sideways acceleration calculated from GPS'),
  GPS_Yaw_Rate: e('GPS', 'GPS Yaw Rate', 'Turning rate calculated from GPS'),

  // Battery (BMS)
  Pack_Voltage: e('Battery', 'Battery Voltage', 'High-voltage battery pack voltage', { role: 'pack_voltage' }),
  Pack_Current: e('Battery', 'Battery Current', 'Current flowing out of the high-voltage battery pack', { role: 'pack_current' }),
  Pack_Temp: e('Battery', 'Battery Temperature', 'High-voltage battery pack temperature'),
  State_of_Charge: e('Battery', 'State of Charge', 'Battery charge remaining, reported by the BMS (%)'),
  Min_Cell_Voltage: e('Battery', 'Lowest Cell Voltage', 'Voltage of the weakest cell in the pack'),
  BMS_Disch_Lim: e('Battery', 'Discharge Current Limit', 'Maximum current the BMS currently allows out of the pack'),
  BMS_Disch_Enable: e('Battery', 'Discharge Enabled', 'BMS allows the pack to discharge (on/off)'),
  BMS_LV_input: e('Battery', 'BMS Low-Voltage Supply', 'Low-voltage supply measured at the BMS', { uncertain: true }),
  Active_DCL: e('Battery', 'Active Discharge Limit', 'Discharge current limit currently being applied'),
  Cell_DCL: e('Battery', 'Cell-Voltage Discharge Limit', 'Discharge limit set by cell voltage'),
  SoC_DCL: e('Battery', 'Charge-Level Discharge Limit', 'Discharge limit set by state of charge'),
  DCL_Source: e('Battery', 'Discharge Limit Source', 'Which limit is currently setting the discharge current limit'),
  Derate_Tune: e('Battery', 'Derate Tune', 'Discharge derating setting', { uncertain: true }),
  Cumulative_Charg: e('Battery', 'Cumulative Charge', 'Total charge drawn from the pack (amp-hours)', { uncertain: true }),
  KF_SOC: e('Battery', 'Estimated State of Charge', 'State of charge from the team\'s estimator (Kalman filter)'),
  KF_BMS_Live: e('Status', 'SOC Estimator: BMS Live', 'Estimator is receiving BMS data', { uncertain: true }),
  KF_Clamped: e('Status', 'SOC Estimator: Clamped', 'Estimator output is being clamped', { uncertain: true }),
  KF_Frozen: e('Status', 'SOC Estimator: Frozen', 'Estimator output is frozen', { uncertain: true }),
  KF_Gated: e('Status', 'SOC Estimator: Gated', 'Estimator rejected a measurement', { uncertain: true }),
  KF_Init: e('Status', 'SOC Estimator: Initialised', 'Estimator has started', { uncertain: true }),
  KF_OCV_init: e('Status', 'SOC Estimator: Voltage Init', 'Estimator started from resting cell voltage', { uncertain: true }),
  KF_V_Bad: e('Status', 'SOC Estimator: Bad Voltage', 'Estimator saw an implausible voltage', { uncertain: true }),
  Innovation_001: e('Status', 'SOC Estimator Innovation', 'Estimator correction term', { uncertain: true }),

  // Motor & inverter (MCU)
  Motor_Temp: e('Temperatures', 'Motor Temperature', 'Electric motor temperature'),
  Torque_Command: e('Motor & Inverter', 'Torque Command', 'Torque requested from the motor'),
  Torque_Feedback: e('Motor & Inverter', 'Torque Delivered', 'Torque the inverter reports the motor is producing'),
  MCU_Torque_Limit: e('Motor & Inverter', 'Inverter Torque Limit', 'Maximum torque the inverter currently allows'),
  LVCU_Torque_Req: e('Motor & Inverter', 'Torque Request (LVCU)', 'Torque requested by the low-voltage control unit'),
  MCU_DC_Current: e('Motor & Inverter', 'Inverter DC Current', 'DC current measured by the inverter'),
  Phase_A_Current: e('Motor & Inverter', 'Phase A Current', 'Motor phase A current', { role: 'phase_current_a' }),
  Phase_B_Current: e('Motor & Inverter', 'Phase B Current', 'Motor phase B current', { role: 'phase_current_b' }),
  Phase_C_Current: e('Motor & Inverter', 'Phase C Current', 'Motor phase C current', { role: 'phase_current_c' }),
  Id_Feeback: e('Motor & Inverter', 'D-Axis Current', 'Motor current on the d-axis (field), as measured by the inverter'),
  Iq_Feedback: e('Motor & Inverter', 'Q-Axis Current', 'Motor current on the q-axis (torque-producing)'),
  Flux_Command: e('Motor & Inverter', 'Flux Command', 'Motor magnetic flux requested by the inverter'),
  Flux_Feedback: e('Motor & Inverter', 'Flux Feedback', 'Motor magnetic flux estimated by the inverter'),
  InverterEnable: e('Motor & Inverter', 'Inverter Enabled', 'Inverter is enabled (on/off)'),
  Coolant_Temps: e('Temperatures', 'Coolant Temperature', 'Cooling loop temperature reported by the inverter'),
  Gate_Temp: e('Temperatures', 'Inverter Gate Driver Temp', 'Inverter gate driver board temperature'),
  Hot_Spot: e('Temperatures', 'Inverter Hot Spot Temp', 'Hottest point inside the inverter'),
  Phase_A_Temp: e('Temperatures', 'Inverter Phase A Temp', 'Inverter power module temperature, phase A'),
  Phase_B_Temp: e('Temperatures', 'Inverter Phase B Temp', 'Inverter power module temperature, phase B'),
  Phase_C_Temp: e('Temperatures', 'Inverter Phase C Temp', 'Inverter power module temperature, phase C'),
  LVCU_Status: e('Status', 'LVCU Status', 'Low-voltage control unit state'),
  Loop_dt_Max: e('Status', 'Max Control Loop Time', 'Longest control loop time seen', { uncertain: true }),
  Version_Hi: e('Status', 'Firmware Version (high)', 'Firmware version number', { uncertain: true }),
  Version_Lo: e('Status', 'Firmware Version (low)', 'Firmware version number', { uncertain: true }),
  Version_Flags: e('Status', 'Firmware Version Flags', 'Firmware build flags', { uncertain: true }),
  Flags: e('Status', 'Flags', 'Status flag word', { uncertain: true }),
  lc_enabled: e('Status', 'Launch Control Enabled', 'Launch control is armed'),
  lc_sensor_health: e('Status', 'Launch Control Sensor Health', 'Launch control sensors are working'),
  cut_rate_active: e('Status', 'Torque Cut Active', 'Launch/traction control is cutting torque', { uncertain: true }),

  // Faults (from the car) and the logger alarms that mirror them
  APPS_Dist_Fault: fault('Throttle Sensor Disagreement', 'The two accelerator pedal sensors disagree (APPS implausibility)'),
  APPS_Dist_Alarm: alarm('Throttle Sensor Disagreement'),
  BSE_Fault: fault('Brake Sensor Fault', 'Brake pedal sensor reading is out of range'),
  BSE_Alarm: alarm('Brake Sensor Fault'),
  TPS1_OOR_Fault: fault('Throttle Sensor 1 Out of Range', 'Accelerator pedal sensor 1 reads outside its valid range'),
  TPS1_OOR_Alarm: alarm('Throttle Sensor 1 Out of Range'),
  TPS2_OOR_Fault: fault('Throttle Sensor 2 Out of Range', 'Accelerator pedal sensor 2 reads outside its valid range'),
  TPS2_OOR_Alarm: alarm('Throttle Sensor 2 Out of Range'),
  RTD_Fault: fault('Ready-to-Drive Fault', 'Ready-to-drive sequence fault'),
  RTD_Alarm: alarm('Ready-to-Drive Fault'),
  CANCommandLost: fault('Inverter Lost CAN Commands', 'Inverter stopped receiving command messages over CAN'),
  CANCmdLost_Alarm: alarm('Inverter Lost CAN Commands'),
  DC_Undervoltage: fault('DC Bus Undervoltage', 'Inverter DC bus voltage is too low'),
  DC_UnderVolt_Alarm: alarm('DC Bus Undervoltage'),
  HWOverCurrent: fault('Inverter Hardware Overcurrent', 'Inverter hardware overcurrent trip'),
  HW_Overcurrent_Alarm: alarm('Inverter Hardware Overcurrent'),
  InvOverVolt: fault('Inverter Overvoltage', 'Inverter DC bus voltage is too high'),
  InvOverVolt_Alarm: alarm('Inverter Overvoltage'),
  InverterTempHi: fault('Inverter Over-Temperature', 'Inverter is too hot'),
  InverterTempHi_Alarm: alarm('Inverter Over-Temperature'),
  InverterTempLo: fault('Inverter Under-Temperature', 'Inverter is too cold'),
  InverterTempLo_Alarm: alarm('Inverter Under-Temperature'),
  MCU_LV_Out_of_Range: fault('Inverter Low-Voltage Supply Out of Range', 'Inverter 12 V supply is outside its valid range'),
  MCU_LV_OOR_Alarm: alarm('Inverter Low-Voltage Supply Out of Range'),
  MotorOverSpeed: fault('Motor Overspeed', 'Motor exceeded its speed limit'),
  MotorOverSpeed_Alarm: alarm('Motor Overspeed'),
  MotorOverTemp: fault('Motor Over-Temperature', 'Motor is too hot'),
  MotorOverTemp_Alarm: alarm('Motor Over-Temperature'),
  InvRunFaultB4: fault('Inverter Run Fault Byte 4', 'Inverter run-fault bits (byte 4) — see inverter manual', { uncertain: true }),
  InvRunFaultB5: fault('Inverter Run Fault Byte 5', 'Inverter run-fault bits (byte 5) — see inverter manual', { uncertain: true }),
  InvRunFaultB6: fault('Inverter Run Fault Byte 6', 'Inverter run-fault bits (byte 6) — see inverter manual', { uncertain: true }),
  InvRunFaultB7: fault('Inverter Run Fault Byte 7', 'Inverter run-fault bits (byte 7) — see inverter manual', { uncertain: true }),
  PostFaultB0: fault('Inverter Startup Fault Byte 0', 'Inverter power-on self-test fault bits (byte 0)', { uncertain: true }),
  PostFaultB1: fault('Inverter Startup Fault Byte 1', 'Inverter power-on self-test fault bits (byte 1)', { uncertain: true }),
  PostFaultB2: fault('Inverter Startup Fault Byte 2', 'Inverter power-on self-test fault bits (byte 2)', { uncertain: true }),
  PostFaultB3: fault('Inverter Startup Fault Byte 3', 'Inverter power-on self-test fault bits (byte 3)', { uncertain: true }),

  // Logger
  'External Voltage': e('Logger', 'Logger Supply Voltage', 'Voltage powering the logger (12 V low-voltage system)', { role: 'lv_voltage' }),
  'Logger Temperature': e('Logger', 'Logger Temperature', 'Temperature inside the data logger'),
  StartRec: e('Logger', 'Recording', 'Logger is recording'),
  loggingActive: e('Logger', 'Logging Active', 'Logger is logging'),

  // ─── IC car: ECU block from the live layout (S8_*) ────────────────────────
  S8_RPM: e('Engine', 'Engine RPM', 'Engine speed from the ECU', { role: 'engine_rpm' }),
  S8_gear: e('Engine', 'Gear', 'Current gear from the ECU', { role: 'gear' }),
  S8_tps1: e('Driver Inputs', 'Throttle Position', 'Throttle position from the ECU (%)', { role: 'throttle' }),
  S8_map1: e('Engine', 'Manifold Pressure (MAP)', 'Intake manifold air pressure'),
  S8_ect1: e('Temperatures', 'Coolant Temperature', 'Engine coolant temperature'),
  S8_eot: e('Temperatures', 'Oil Temperature', 'Engine oil temperature'),
  S8_eop: e('Engine', 'Oil Pressure', 'Engine oil pressure'),
  S8_fp1: e('Fuel', 'Fuel Pressure', 'Fuel rail pressure'),
  S8_lam1: e('Fuel', 'Lambda', 'Air-fuel mixture (1.0 = ideal; below is rich, above is lean)', { role: 'lambda' }),
  S8_vbat: e('Logger', 'ECU Battery Voltage', 'Battery voltage at the ECU (12 V system)', { role: 'lv_voltage' }),
  S8_ignFinal1: e('Engine', 'Ignition Timing', 'Final ignition advance (degrees)'),
  S8_fuelFinalPri1: e('Fuel', 'Injector Pulse Width', 'Final primary injector open time (ms)', { role: 'injector_pw' }),
  S8_engineEnable: e('Status', 'Engine Enabled', 'ECU allows the engine to run'),
  S8_LaunchSwitch: e('Status', 'Launch Switch', 'Launch control switch is on'),
  S8_revLimitActiv: fault('Rev Limiter Active', 'Engine is on the rev limiter'),
  S8_revCutActive: fault('Rev Cut Active', 'ECU is cutting to limit revs'),
  S8_limpmode: fault('Limp Mode', 'ECU is in limp (protection) mode'),
  S8_lfSpeed: e('Wheels & Speed', 'Left-Front Wheel Speed', 'Speed measured at the left-front wheel', { role: 'wheel_speed' }),
  S8_rfspeed: e('Wheels & Speed', 'Right-Front Wheel Speed', 'Speed measured at the right-front wheel', { role: 'wheel_speed' }),
  S8_lrSpeed: e('Wheels & Speed', 'Left-Rear Wheel Speed', 'Speed measured at the left-rear wheel', { role: 'wheel_speed' }),
  S8_rrSpeed: e('Wheels & Speed', 'Right-Rear Wheel Speed', 'Speed measured at the right-rear wheel', { role: 'wheel_speed' }),
  '0TC01': e('Temperatures', 'Tire Temp 1', 'Tire temperature, thermocouple 1 (corner not known)', { uncertain: true }),
  '0TC02': e('Temperatures', 'Tire Temp 2', 'Tire temperature, thermocouple 2 (corner not known)', { uncertain: true }),
  '0TC03': e('Temperatures', 'Tire Temp 3', 'Tire temperature, thermocouple 3 (corner not known)', { uncertain: true }),
  '0TC04': e('Temperatures', 'Tire Temp 4', 'Tire temperature, thermocouple 4 (corner not known)', { uncertain: true }),

  // ─── IC car: common AiM / ECU names (matched loosely) ─────────────────────
  'Engine RPM': e('Engine', 'Engine RPM', 'Engine speed', { role: 'engine_rpm', aliases: ['EngineSpeed', 'Engine Speed', 'ERPM'] }),
  Lambda: e('Fuel', 'Lambda', 'Air-fuel mixture (1.0 = ideal; below is rich, above is lean)', { role: 'lambda', aliases: ['Lambda1', 'Lambda 1', 'Lam1', 'LambdaAvg'] }),
  AFR: e('Fuel', 'Air-Fuel Ratio', 'Mass of air per mass of fuel (about 14.7 is ideal for gasoline)', { aliases: ['AirFuelRatio', 'AFR1'] }),
  'Oil Pressure': e('Engine', 'Oil Pressure', 'Engine oil pressure', { aliases: ['OilPress', 'OilP', 'EOP'] }),
  'Oil Temp': e('Temperatures', 'Oil Temperature', 'Engine oil temperature', { aliases: ['OilTemp', 'EOT', 'Oil Temperature'] }),
  'Water Temp': e('Temperatures', 'Coolant Temperature', 'Engine coolant temperature', { aliases: ['WaterTemp', 'ECT', 'CoolantTemp', 'Coolant Temp', 'Engine Temp'] }),
  'Fuel Pressure': e('Fuel', 'Fuel Pressure', 'Fuel rail pressure', { aliases: ['FuelPress', 'FuelP', 'Fuel Press'] }),
  'Fuel Flow': e('Fuel', 'Fuel Flow', 'Fuel flow rate', { role: 'fuel_flow', aliases: ['FuelFlow', 'Fuel Rate', 'FuelRate'] }),
  'Fuel Used': e('Fuel', 'Fuel Used', 'Fuel used so far', { aliases: ['FuelUsed', 'Fuel Consumed'] }),
  'Fuel Level': e('Fuel', 'Fuel Level', 'Fuel remaining in the tank', { aliases: ['FuelLevel'] }),
  Gear: e('Engine', 'Gear', 'Current gear', { role: 'gear', aliases: ['GearPos', 'Gear Position'] }),
  MAP: e('Engine', 'Manifold Pressure (MAP)', 'Intake manifold air pressure', { aliases: ['Manifold Pressure', 'ManifoldPress'] }),
  IAT: e('Temperatures', 'Intake Air Temperature', 'Temperature of the air entering the engine', { aliases: ['Air Temp', 'AirTemp', 'Intake Air Temp', 'MAT'] }),
  'Ignition Angle': e('Engine', 'Ignition Timing', 'Ignition advance (degrees)', { aliases: ['IgnAngle', 'Ign Angle', 'Ignition Timing', 'IgnTiming'] }),
  'Injector PW': e('Fuel', 'Injector Pulse Width', 'Injector open time (ms)', { role: 'injector_pw', aliases: ['InjPW', 'Inj PW', 'Injector Pulse Width'] }),
  'Battery Voltage': e('Logger', 'Low-Voltage Battery', 'The car\'s 12 V battery voltage (not the HV pack)', { role: 'lv_voltage', aliases: ['Battery', 'Batt Volt', 'BattVolt', 'VBat', 'Batt'] }),
  TPS: e('Driver Inputs', 'Throttle Position', 'Throttle position (%)', { role: 'throttle', aliases: ['Throttle', 'Throttle Position'] }),
};

// Unlabeled analog inputs (Channel01 … Channel99).
const PATTERNS: { re: RegExp; make: (m: RegExpMatchArray) => Entry }[] = [
  {
    re: /^Channel(\d+)$/,
    make: (m) => e('Other', `Unlabeled Input ${Number(m[1])}`, `Analog input ${Number(m[1])} with no name set in the logger configuration`, { uncertain: true }),
  },
];

const normalize = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, '');

const NORMALIZED = new Map<string, string>();
for (const [code, entry] of Object.entries(ENTRIES)) {
  for (const k of [code, ...(entry.aliases ?? [])]) {
    const n = normalize(k);
    if (!NORMALIZED.has(n)) NORMALIZED.set(n, code);
  }
}

function lookup(code: string): Entry | undefined {
  const exact = ENTRIES[code];
  if (exact) return exact;
  const viaNorm = NORMALIZED.get(normalize(code));
  if (viaNorm) return ENTRIES[viaNorm];
  for (const p of PATTERNS) {
    const m = code.match(p.re);
    if (m) return p.make(m);
  }
  return undefined;
}

/** Plain-English info for a channel code. `overrides` are the user's own
 *  renames (code → label); a non-blank one wins over the built-in label. */
export function describeChannel(code: string, car: CarType, overrides?: Record<string, string>): ChannelInfo {
  const entry = lookup(code);
  let info: ChannelInfo;
  if (!entry) {
    info = { code, label: code, description: '', category: 'Other', known: false };
  } else {
    const { aliases: _a, byCar, ...base } = entry;
    const carSpecific = car !== 'unknown' ? byCar?.[car] : undefined;
    info = { code, ...base, ...carSpecific, known: true };
  }
  // Brackets delimit channel names in formulas, so a label can't contain them.
  const rename = overrides?.[code]?.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (rename) {
    info.label = rename;
    delete info.uncertain;
  }
  return info;
}

const EV_MARKERS = ['Pack_Voltage', 'Pack_Current', 'State_of_Charge', 'InverterEnable', 'Motor_Temp', 'Torque_Command', 'MCU_DC_Current']
  .map(normalize);
const IC_MARKERS = ['Lambda', 'Lambda1', 'AFR', 'OilPress', 'Oil Pressure', 'OilTemp', 'Oil Temp', 'FuelPress', 'Fuel Pressure',
  'FuelFlow', 'Fuel Flow', 'WaterTemp', 'Water Temp', 'ECT', 'InjPW', 'Engine RPM'].map(normalize);

/** Which car a set of channel codes came from, judged by channels only one
 *  of the cars has; the vehicle name (e.g. "CT16-EV", "UConn-IC") breaks ties. */
export function inferCarType(codes: Iterable<string>, vehicle?: string): CarType {
  let ic = false;
  for (const code of codes) {
    const n = normalize(code);
    if (EV_MARKERS.includes(n)) return 'ev';
    if (code.startsWith('S8_') || IC_MARKERS.includes(n)) ic = true;
  }
  if (ic) return 'ic';
  if (/(^|[^a-z])ev([^a-z]|$)/i.test(vehicle ?? '')) return 'ev';
  if (/(^|[^a-z])ic([^a-z]|$)/i.test(vehicle ?? '')) return 'ic';
  return 'unknown';
}

/** A copy of the session whose channels' `longName` is the plain-English
 *  label (with the user's renames), for display in channel lists. */
export function withFriendlyNames(session: XRKSession, overrides: Record<string, string>): XRKSession {
  const codes = Array.from(session.channels.values(), ch => ch.shortName);
  const car = inferCarType(codes, session.metadata?.vehicle);
  const channels = new Map<number, ChannelDef>();
  for (const [idx, ch] of session.channels) {
    channels.set(idx, { ...ch, longName: describeChannel(ch.shortName, car, overrides).label });
  }
  return { ...session, channels };
}
