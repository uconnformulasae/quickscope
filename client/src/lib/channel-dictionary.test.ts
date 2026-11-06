import { describe, expect, it } from 'vitest';
import { describeChannel, inferCarType, withFriendlyNames } from './channel-dictionary';
import { makeChannel, makeSession } from '../test-fixtures';

/** Every channel code seen in the repo's EV sessions (.xrk/.xrz) and in the
 *  live-stream layouts for both cars (live/live-channels.ts). */
const KNOWN_CODES = [
  '0TC01',
  '0TC02',
  '0TC03',
  '0TC04',
  'APPS_Dist_Alarm',
  'APPS_Dist_Fault',
  'Active_DCL',
  'BMS_Disch_Enable',
  'BMS_Disch_Lim',
  'BMS_LV_input',
  'BSE_Alarm',
  'BSE_Fault',
  'BSE_Voltage',
  'BrakeBias',
  'Brake_Bias',
  'CANCmdLost_Alarm',
  'CANCommandLost',
  'Cell_DCL',
  'Channel01',
  'Channel04',
  'Channel05',
  'Channel06',
  'Channel07',
  'Channel08',
  'Coolant_Temps',
  'Cumulative_Charg',
  'DCL_Source',
  'DC_UnderVolt_Alarm',
  'DC_Undervoltage',
  'Derate_Tune',
  'Direction',
  'External Voltage',
  'FBrakePressCorr',
  'FBrakePressure',
  'Flags',
  'Flux_Command',
  'Flux_Feedback',
  'FrBrakePressure',
  'GPS Altitude',
  'GPS Latitude',
  'GPS Longitude',
  'GPS Speed',
  'GPS_Fix',
  'GPS_InlineAcc',
  'GPS_LateralAcc',
  'GPS_Position_Accuracy',
  'GPS_Satellites',
  'GPS_Velocity_Accuracy',
  'GPS_Yaw_Rate',
  'GPS_pDOP',
  'Gate_Temp',
  'HWOverCurrent',
  'HW_Overcurrent_Alarm',
  'Hot_Spot',
  'Id_Feeback',
  'InlineAcc',
  'Innovation_001',
  'InvOverVolt',
  'InvOverVolt_Alarm',
  'InvRunFaultB4',
  'InvRunFaultB5',
  'InvRunFaultB6',
  'InvRunFaultB7',
  'InverterEnable',
  'InverterTempHi',
  'InverterTempHi_Alarm',
  'InverterTempLo',
  'InverterTempLo_Alarm',
  'Iq_Feedback',
  'KF_BMS_Live',
  'KF_Clamped',
  'KF_Frozen',
  'KF_Gated',
  'KF_Init',
  'KF_OCV_init',
  'KF_SOC',
  'KF_V_Bad',
  'LF_BRKSensorTemp',
  'LF_BRKTempCH1',
  'LF_BRKTempCH2',
  'LF_BRKTempCH3',
  'LF_BRKTempCH4',
  'LFspeed',
  'LVCU_Status',
  'LVCU_Torque_Req',
  'LVCU_brakes',
  'LateralAcc',
  'Logger Temperature',
  'Loop_dt_Max',
  'MCU_DC_Current',
  'MCU_LV_OOR_Alarm',
  'MCU_LV_Out_of_Range',
  'MCU_Torque_Limit',
  'Min_Cell_Voltage',
  'MotorOverSpeed',
  'MotorOverSpeed_Alarm',
  'MotorOverTemp',
  'MotorOverTemp_Alarm',
  'Motor_Temp',
  'Pack_Current',
  'Pack_Temp',
  'Pack_Voltage',
  'Phase_A_Current',
  'Phase_A_Temp',
  'Phase_B_Current',
  'Phase_B_Temp',
  'Phase_C_Current',
  'Phase_C_Temp',
  'PitchRate',
  'PostFaultB0',
  'PostFaultB1',
  'PostFaultB2',
  'PostFaultB3',
  'RBrakePressCorr',
  'RBrakePressure',
  'RBrkPressure',
  'RPM',
  'RTD_Alarm',
  'RTD_Fault',
  'RollRate',
  'S8_LaunchSwitch',
  'S8_RPM',
  'S8_ect1',
  'S8_engineEnable',
  'S8_eop',
  'S8_eot',
  'S8_fp1',
  'S8_fuelFinalPri1',
  'S8_gear',
  'S8_ignFinal1',
  'S8_lam1',
  'S8_lfSpeed',
  'S8_limpmode',
  'S8_lrSpeed',
  'S8_map1',
  'S8_revCutActive',
  'S8_revLimitActiv',
  'S8_rfspeed',
  'S8_rrSpeed',
  'S8_tps1',
  'S8_vbat',
  'SoC_DCL',
  'StartRec',
  'State_of_Charge',
  'TPS1_OOR_Alarm',
  'TPS1_OOR_Fault',
  'TPS2_OOR_Alarm',
  'TPS2_OOR_Fault',
  'TPS_1',
  'TPS_1_Voltage',
  'TPS_2',
  'TPS_2_Voltage',
  'Throttle_Pos',
  'Torque_Command',
  'Torque_Feedback',
  'Version_Flags',
  'Version_Hi',
  'Version_Lo',
  'VerticalAcc',
  'YawRate',
  'cut_rate_active',
  'lc_enabled',
  'lc_sensor_health',
  'loggingActive',
];

describe('describeChannel', () => {
  it('gives plain names and roles to the brake channels', () => {
    const f = describeChannel('FBrakePressure', 'ev');
    expect(f.label).toBe('Front Brake Pressure');
    expect(f.role).toBe('brake_pressure_front');
    expect(describeChannel('RBrakePressCorr', 'ev').role).toBe('brake_pressure_rear');
    expect(describeChannel('RBrakePressure', 'ev').label).toBe('Rear Brake Pressure (raw)');
    expect(describeChannel('RBrakePressure', 'ev').role).toBeUndefined();
  });

  it('uses Pack_Current, not the inverter current, for pack power', () => {
    expect(describeChannel('Pack_Current', 'ev').role).toBe('pack_current');
    expect(describeChannel('MCU_DC_Current', 'ev').label).toBe('Inverter DC Current');
    expect(describeChannel('MCU_DC_Current', 'ev').role).toBeUndefined();
  });

  it('labels RPM by car type', () => {
    expect(describeChannel('RPM', 'ev')).toMatchObject({ label: 'Motor RPM', role: 'motor_rpm' });
    expect(describeChannel('RPM', 'ic')).toMatchObject({ label: 'Engine RPM', role: 'engine_rpm' });
    const unknown = describeChannel('RPM', 'unknown');
    expect(unknown.label).toBe('RPM');
    expect(unknown.role).toBeUndefined();
  });

  it('flags channels whose meaning is a guess', () => {
    expect(describeChannel('Channel01', 'ev').uncertain).toBe(true);
    expect(describeChannel('FBrakePressure', 'ev').uncertain).toBeFalsy();
  });

  it('matches common IC names regardless of spacing and case', () => {
    expect(describeChannel('oil_press', 'ic').label).toBe('Oil Pressure');
    expect(describeChannel('Oil Pressure', 'ic').label).toBe('Oil Pressure');
    expect(describeChannel('Lambda1', 'ic').role).toBe('lambda');
    expect(describeChannel('S8_lam1', 'ic').role).toBe('lambda');
    expect(describeChannel('S8_RPM', 'ic').role).toBe('engine_rpm');
  });

  it('keeps unknown codes usable under their own name', () => {
    expect(describeChannel('Mystery', 'ev')).toMatchObject({ code: 'Mystery', label: 'Mystery', known: false, category: 'Other' });
  });

  it('lets a user rename win and clears the guess flag', () => {
    const r = describeChannel('Channel01', 'ev', { Channel01: 'Steering Angle' });
    expect(r.label).toBe('Steering Angle');
    expect(r.uncertain).toBeFalsy();
  });

  it('strips brackets from renames so they cannot break formula tags', () => {
    expect(describeChannel('Channel01', 'ev', { Channel01: 'Steer [deg]' }).label).toBe('Steer deg');
  });

  it('ignores blank renames', () => {
    expect(describeChannel('FBrakePressure', 'ev', { FBrakePressure: '  ' }).label).toBe('Front Brake Pressure');
  });

  it('knows every channel the team\'s cars send', () => {
    const missing = KNOWN_CODES.filter(c => !describeChannel(c, 'ev').known && !describeChannel(c, 'ic').known);
    expect(missing).toEqual([]);
  });

  it('gives every known channel a description', () => {
    const blank = KNOWN_CODES.filter(c => !describeChannel(c, 'ev').description);
    expect(blank).toEqual([]);
  });
});

describe('inferCarType', () => {
  it('detects the EV from battery/inverter channels', () => {
    expect(inferCarType(['GPS Speed', 'Pack_Voltage'])).toBe('ev');
  });
  it('detects the IC car from ECU and engine channels', () => {
    expect(inferCarType(['S8_RPM'])).toBe('ic');
    expect(inferCarType(['RPM', 'Oil Pressure'])).toBe('ic');
  });
  it('falls back to the vehicle name when channels are ambiguous', () => {
    expect(inferCarType(['GPS Speed'], 'CT16-EV')).toBe('ev');
    expect(inferCarType(['GPS Speed'], 'UConn-IC')).toBe('ic');
    expect(inferCarType(['GPS Speed'], 'Civic')).toBe('unknown');
    expect(inferCarType(['Pack_Voltage'], 'UConn-IC')).toBe('ev');
  });
  it('is unknown when nothing car-specific is present', () => {
    expect(inferCarType(['GPS Speed', 'RPM'])).toBe('unknown');
  });
});

describe('withFriendlyNames', () => {
  const session = makeSession({
    channels: new Map([
      [1, makeChannel(1, 'Pack_Voltage')],
      [2, makeChannel(2, 'RPM')],
      [3, makeChannel(3, 'Mystery')],
    ]),
  });

  it('sets each channel\'s long name to its plain-English label', () => {
    const out = withFriendlyNames(session, {});
    expect(out.channels.get(1)!.longName).toBe('Battery Voltage');
    expect(out.channels.get(2)!.longName).toBe('Motor RPM');
    expect(out.channels.get(3)!.longName).toBe('Mystery');
    expect(out.channels.get(1)!.shortName).toBe('Pack_Voltage');
  });

  it('applies user renames', () => {
    expect(withFriendlyNames(session, { Pack_Voltage: 'HV' }).channels.get(1)!.longName).toBe('HV');
  });

  it('leaves the original session untouched', () => {
    withFriendlyNames(session, {});
    expect(session.channels.get(1)!.longName).toBe('Pack_Voltage');
  });
});
