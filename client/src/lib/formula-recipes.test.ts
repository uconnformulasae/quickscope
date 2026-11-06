import { describe, expect, it } from 'vitest';
import { describeChannel, type CarType } from './channel-dictionary';
import { availableRecipes, prefillSlots, RECIPES } from './formula-recipes';

const infos = (codes: string[], car: CarType) => codes.map(c => describeChannel(c, car));
const EV = infos(['FBrakePressure', 'RBrakePressure', 'RBrakePressCorr', 'Pack_Voltage', 'Pack_Current', 'LateralAcc',
  'InlineAcc', 'RPM', 'GPS Speed', 'Phase_A_Current', 'Phase_B_Current', 'Phase_C_Current'], 'ev');
const IC = infos(['S8_RPM', 'S8_lam1', 'S8_lfSpeed', 'GPS Speed', 'Fuel Flow', 'FBrakePressCorr', 'RBrakePressCorr'], 'ic');
const ids = (list: { id: string }[]) => list.map(r => r.id);
const recipe = (id: string) => RECIPES.find(r => r.id === id)!;
const label = (code: string) => describeChannel(code, 'ev').label;

describe('availableRecipes', () => {
  it('shows battery and brake recipes on an EV log but no gas recipes', () => {
    const got = ids(availableRecipes(EV));
    expect(got).toEqual(expect.arrayContaining(['battery-power', 'power-500ms', 'brake-balance', 'combined-g', 'phase-current-rms']));
    expect(got).not.toContain('afr');
    expect(got).not.toContain('gear-ratio');
    expect(got).not.toContain('fuel-flow-convert');
  });

  it('shows gas recipes on an IC log but no battery recipes', () => {
    const got = ids(availableRecipes(IC));
    expect(got).toEqual(expect.arrayContaining(['afr', 'gear-ratio', 'fuel-flow-convert', 'brake-balance']));
    expect(got).not.toContain('battery-power');
  });

  it('offers only the generic recipes when nothing is recognised', () => {
    expect(ids(availableRecipes([]))).toEqual(['convert', 'difference', 'ratio', 'smooth', 'rate']);
  });
});

describe('recipe formulas', () => {
  it('brake balance stays near 0 instead of exploding when off the brakes', async () => {
    const { evaluateFormula } = await import('./formula-engine');
    const r = recipe('brake-balance');
    const expr = r.build(prefillSlots(r, EV), label).expression;
    const ch = (vals: number[]) => ({ timestamps: vals.map((_, i) => i * 100), values: vals });
    const out = evaluateFormula(expr, { FBrakePressure: ch([0.01, 30]), RBrakePressCorr: ch([-0.009, 20]) });
    expect(typeof out).not.toBe('string');
    const vals = (out as { values: number[] }).values;
    expect(Math.abs(vals[0])).toBeLessThan(1);
    expect(vals[1]).toBeCloseTo(60);
  });

  it('brake balance uses the front and corrected rear pressure', () => {
    const r = recipe('brake-balance');
    expect(r.build(prefillSlots(r, EV), label)).toMatchObject({
      expression: 'FBrakePressure / max(FBrakePressure + RBrakePressCorr, 2) * 100', units: '%',
    });
  });

  it('prefers the corrected front pressure when the log has it', () => {
    const r = recipe('brake-balance');
    const withCorr = [...EV, describeChannel('FBrakePressCorr', 'ev')];
    expect(prefillSlots(r, withCorr).front).toBe('FBrakePressCorr');
  });

  it('battery power is volts times amps in kW', () => {
    const r = recipe('battery-power');
    expect(r.build(prefillSlots(r, EV), label)).toEqual({
      expression: 'Pack_Voltage * Pack_Current / 1000', name: 'Battery Power', units: 'kW',
    });
  });

  it('unit conversion quotes channels with spaces', () => {
    const r = recipe('convert');
    const out = r.build({ ...prefillSlots(r, EV), channel: 'GPS Speed', conversion: 'kmh_mph' }, label);
    expect(out).toEqual({ expression: '[GPS Speed] * 0.621371', name: 'GPS Speed (mph)', units: 'mph' });
  });

  it('celsius to fahrenheit adds the offset', () => {
    const r = recipe('convert');
    expect(r.build({ channel: 'Motor_Temp', conversion: 'c_f' }, label).expression).toBe('Motor_Temp * 1.8 + 32');
  });

  it('smoothing uses a time window in milliseconds', () => {
    const r = recipe('smooth');
    expect(prefillSlots(r, EV).window).toBe('200');
    expect(r.build({ channel: 'LateralAcc', window: '500' }, label).expression).toBe('mavg(LateralAcc, 500)');
  });

  it('leaves channel slots empty when no channel has the role', () => {
    expect(prefillSlots(recipe('difference'), EV)).toEqual({ a: '', b: '' });
  });

  it('gear ratio pairs engine RPM with a wheel speed', () => {
    const r = recipe('gear-ratio');
    expect(r.build(prefillSlots(r, IC), label).expression).toBe('S8_RPM / max(S8_lfSpeed, 5)');
  });

  it('builds nothing while a channel slot is empty', () => {
    const r = recipe('difference');
    expect(r.build({ a: 'Pack_Voltage', b: '' }, label).expression).toBe('');
  });
});
