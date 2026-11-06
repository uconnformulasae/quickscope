import { describe, expect, it } from 'vitest';
import { describeChannel } from './channel-dictionary';
import { buildLabelIndex, displayToStored, storedToDisplay } from './formula-text';

const codes = ['FBrakePressure', 'RBrakePressCorr', 'GPS Speed', 'Pack_Voltage', 'MyDerived'];
const idx = buildLabelIndex(codes, c => describeChannel(c, 'ev'));

describe('storedToDisplay / displayToStored', () => {
  it('shows channels by their friendly label', () => {
    expect(storedToDisplay('FBrakePressure - RBrakePressCorr', idx)).toBe('[Front Brake Pressure] - [Rear Brake Pressure]');
  });

  it.each([
    'FBrakePressure - RBrakePressCorr',
    '[GPS Speed] * 0.621',
    'MyDerived * 2',
    'mavg(Pack_Voltage, 500)',
    'Spd1 +',
    '(FBrakePressure',
    '',
  ])('round-trips %j', (stored) => {
    expect(displayToStored(storedToDisplay(stored, idx), idx)).toBe(stored);
  });

  it('accepts raw codes and labels typed in any case', () => {
    expect(displayToStored('[front brake pressure] + Pack_Voltage', idx)).toBe('FBrakePressure + Pack_Voltage');
  });

  it('quotes codes that are not plain identifiers', () => {
    expect(displayToStored('[GPS Speed]', idx)).toBe('[GPS Speed]');
  });

  it('leaves unresolved names as typed', () => {
    expect(displayToStored('[Nope] + x', idx)).toBe('[Nope] + x');
  });

  it('keeps the e and pi constants', () => {
    expect(displayToStored('Pack_Voltage * pi', idx)).toBe('Pack_Voltage * pi');
  });
});

describe('buildLabelIndex', () => {
  it('makes duplicate labels unique so each still maps to its own code', () => {
    const dup = buildLabelIndex(['A', 'B'], c => ({ ...describeChannel(c, 'ev'), label: 'Same' }));
    expect(dup.labelOf('A')).toBe('Same');
    expect(dup.labelOf('B')).toBe('Same (B)');
    expect(dup.codeOf('Same (B)')).toBe('B');
    expect(displayToStored(storedToDisplay('A - B', dup), dup)).toBe('A - B');
  });

  it('never lets a label shadow a different channel\'s code', () => {
    const tricky = buildLabelIndex(['A', 'B'], c => ({ ...describeChannel(c, 'ev'), label: c === 'A' ? 'B' : 'Bee' }));
    expect(tricky.codeOf('B')).toBe('B');
    expect(displayToStored(storedToDisplay('A + B', tricky), tricky)).toBe('A + B');
  });
});
