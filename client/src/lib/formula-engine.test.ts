import { describe, expect, it } from 'vitest';
import { evaluateFormula, extractChannelNames, type ChannelMap } from './formula-engine';

const ch = (timestamps: number[], values: number[]) => ({ timestamps, values });

const channels: ChannelMap = {
  A: ch([0, 1000, 2000], [1, 2, 3]),
  B: ch([0, 1000, 2000], [10, 20, 30]),
  Slow: ch([0, 2000], [0, 100]),
  RPM: ch([0, 1000, 2000], [100, 200, 300]),
  Speed: ch([0, 1000, 2000], [10, 20, 30]),
  Throttle: ch([0, 1000, 2000], [1, 2, 3]),
};

function ok(expr: string, map: ChannelMap = channels) {
  const out = evaluateFormula(expr, map);
  if (typeof out === 'string') throw new Error(`expected success, got error: ${out}`);
  return out;
}

describe('scalar arithmetic', () => {
  it.each([
    ['1 + 2', 3],
    ['7 - 10', -3],
    ['3 * 4', 12],
    ['9 / 2', 4.5],
    ['2 ^ 10', 1024],
    ['-5 + 2', -3],
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['2 ^ 3 ^ 2', 512],
    ['sqrt(16)', 4],
    ['abs(-3.5)', 3.5],
    ['min(3, 9)', 3],
    ['max(3, 9)', 9],
    ['pow(2, 5)', 32],
    ['  1+1  ', 2],
  ])('%s = %s', (expr, expected) => {
    expect(ok(expr).values).toEqual([expected]);
  });

  it('division by zero never yields Infinity', () => {
    expect(ok('1 / 0').values).not.toContain(Infinity);
  });
});

describe('channel arithmetic', () => {
  it('scales a channel', () => {
    expect(ok('A * 2')).toEqual(ch([0, 1000, 2000], [2, 4, 6]));
  });

  it('adds channels sample by sample', () => {
    expect(ok('A + B').values).toEqual([11, 22, 33]);
  });

  it('interpolates a slower channel onto the merged timeline', () => {
    const out = ok('A + Slow');
    expect(out.timestamps).toEqual([0, 1000, 2000]);
    expect(out.values).toEqual([1, 52, 103]);
  });

  it('unary minus negates channels', () => {
    expect(ok('-A').values).toEqual([-1, -2, -3]);
  });

  it('min/max of two channels is element-wise', () => {
    expect(ok('min(A, 2)').values).toEqual([1, 2, 2]);
    expect(ok('max(A, 2)').values).toEqual([2, 2, 3]);
  });

  it('applies math functions to channels', () => {
    expect(ok('sqrt(A * A)').values).toEqual([1, 2, 3]);
  });

  it('resolves function names case-insensitively', () => {
    expect(ok('SQRT(16)').values).toEqual([4]);
  });

  it('drops non-finite samples from channel results', () => {
    const out = ok('1 / (A - 2)');
    expect(out.timestamps).toEqual([0, 2000]);
    expect(out.values).toEqual([-1, 1]);
  });
});

describe('signal functions', () => {
  it('diff() returns the rate of change per second', () => {
    const out = ok('diff(A)');
    expect(out.timestamps).toEqual([1000, 2000]);
    expect(out.values).toEqual([1, 1]);
  });

  it('diff() of a single sample is empty', () => {
    expect(ok('diff(X)', { X: ch([0], [5]) })).toEqual({ timestamps: [], values: [] });
  });

  it('smooth() keeps length and flattens a spike', () => {
    const spiky: ChannelMap = { S: ch([0, 1, 2, 3, 4], [0, 0, 10, 0, 0]) };
    const out = ok('smooth(S, 3)', spiky);
    expect(out.values).toHaveLength(5);
    expect(Math.max(...out.values)).toBeLessThan(10);
    expect(out.values.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('mavg() ramps up from zero at the start of the session (FSAE EV.3.4.1.a)', () => {
    const flat: ChannelMap = { F: ch([0, 100, 200, 300, 400, 500], [4, 4, 4, 4, 4, 4]) };
    const { values } = ok('mavg(F, 200)', flat);
    expect(values[0]).toBeLessThan(4);
    expect(values[1]).toBeGreaterThan(values[0]);
  });

  it('smooth() of a constant signal is that constant', () => {
    const flat: ChannelMap = { F: ch([0, 100, 200, 300], [4, 4, 4, 4]) };
    expect(ok('smooth(F, 3)', flat).values).toEqual([4, 4, 4, 4]);
  });

  it('delay() with zero samples is the identity', () => {
    expect(ok('delay(A, 0)')).toEqual(channels.A);
  });
});

describe('errors', () => {
  it.each([
    ['Missing * 2', /Unknown channel: 'Missing'/],
    ['nope(1)', /Unknown function/],
    ['diff()', /takes 1 argument/],
    ['smooth(A)', /takes 2 arguments/],
    ['pow(1)', /takes 2 arguments/],
    ['(1 + 2', /./],
    ['1 +', /./],
    ['', /./],
  ])('%s -> error string', (expr, pattern) => {
    const out = evaluateFormula(expr, channels);
    expect(typeof out).toBe('string');
    expect(out as string).toMatch(pattern);
  });

  it('never throws', () => {
    expect(() => evaluateFormula('@@@', channels)).not.toThrow();
  });
});

describe('extractChannelNames', () => {
  it('returns distinct channel identifiers, not functions', () => {
    expect(extractChannelNames('sqrt(A) + A * B - diff(Slow)').sort()).toEqual(['A', 'B', 'Slow']);
  });

  it('returns [] for unparseable input', () => {
    expect(extractChannelNames('((')).toEqual([]);
  });

  it('allows channel names with underscores and digits', () => {
    expect(extractChannelNames('Pack_Voltage1 * 2')).toEqual(['Pack_Voltage1']);
  });
});

// ─── Known bugs (audit §1.2, §1.3) ───────────────────────────────────────────
// `it.fails` passes while the bug exists and starts failing the moment it is
// fixed, which tells you to flip it to a plain `it`.

describe('known bugs', () => {
  it('delay() shifts values later in time instead of truncating the start', () => {
    const out = ok('delay(A, 1)');
    // value[0]=1 should now appear at t=1000, and the series keeps its start time
    expect(out.timestamps).toEqual([0, 1000]);
    expect(out.values).toEqual([1, 2]);
  });

  it('subtraction without spaces is not read as one identifier (RPM-100)', () => {
    expect(ok('RPM-100').values).toEqual([0, 100, 200]);
  });

  it('channel-minus-channel without spaces works (Speed-Throttle)', () => {
    expect(ok('Speed-Throttle').values).toEqual([9, 18, 27]);
  });

  it.fails('mavg() of a constant signal settles at that constant', () => {
    // Window is inclusive of both ends (3 samples at 100 ms spacing for a 200 ms
    // window) but the divisor counts 2, so a constant 4 settles at 6.
    const flat: ChannelMap = { F: ch([0, 100, 200, 300, 400, 500], [4, 4, 4, 4, 4, 4]) };
    expect(ok('mavg(F, 200)', flat).values.at(-1)).toBeCloseTo(4);
  });

  it.fails('a scalar divide-by-zero is reported, not returned as NaN', () => {
    // Channel results drop non-finite samples; scalar results skip that filter.
    const out = evaluateFormula('1 / 0', channels);
    expect(typeof out === 'string' || out.values.every(v => Number.isFinite(v))).toBe(true);
  });

  it('subtraction WITH spaces works today (workaround)', () => {
    expect(ok('RPM - 100').values).toEqual([0, 100, 200]);
  });
});
