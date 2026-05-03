/**
 * Tests for formula-engine: calculus + bitwise operators (and a few
 * regression checks for the existing operators).
 *
 * Run: npx tsx --test client/src/lib/formula-engine.test.ts
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { evaluateFormula, extractChannelNames, type ChannelMap } from './formula-engine';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function evalOK(expr: string, channels: ChannelMap = {}) {
  const r = evaluateFormula(expr, channels);
  if (typeof r === 'string') {
    throw new Error(`Expected success, got error: ${r}`);
  }
  return r;
}

function evalErr(expr: string, channels: ChannelMap = {}) {
  const r = evaluateFormula(expr, channels);
  if (typeof r !== 'string') {
    throw new Error(`Expected error, got success with ${r.values.length} samples`);
  }
  return r;
}

/** Build a channel with timestamps in ms, values supplied. */
function ch(timestamps: number[], values: number[]) {
  return { timestamps, values };
}

/** Constant channel from t=0 to t=durationMs at given step. */
function constCh(value: number, durationMs: number, stepMs = 100) {
  const ts: number[] = [];
  const vs: number[] = [];
  for (let t = 0; t <= durationMs; t += stepMs) {
    ts.push(t);
    vs.push(value);
  }
  return ch(ts, vs);
}

/** Linear ramp from v0 at t=0 to v1 at t=durationMs. */
function rampCh(v0: number, v1: number, durationMs: number, stepMs = 10) {
  const ts: number[] = [];
  const vs: number[] = [];
  for (let t = 0; t <= durationMs; t += stepMs) {
    ts.push(t);
    vs.push(v0 + (v1 - v0) * (t / durationMs));
  }
  return ch(ts, vs);
}

const eps = 1e-9;
const aboutEq = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// ─── Regression: existing operators must still work ───────────────────────────

test('regression: scalar arithmetic', () => {
  assert.deepEqual(evalOK('2 + 3'), { timestamps: [0], values: [5] });
  assert.deepEqual(evalOK('10 - 4'), { timestamps: [0], values: [6] });
  assert.deepEqual(evalOK('6 * 7'), { timestamps: [0], values: [42] });
  assert.deepEqual(evalOK('20 / 4'), { timestamps: [0], values: [5] });
});

test('regression: ^ is power, right-associative', () => {
  assert.equal(evalOK('2^3').values[0], 8);
  assert.equal(evalOK('2^3^2').values[0], 512); // 2^(3^2) = 2^9 = 512
});

test('regression: channel arithmetic', () => {
  const c = constCh(5, 1000);
  const r = evalOK('A * 2', { A: c });
  assert.ok(r.values.every(v => v === 10));
});

test('regression: existing signal funcs survive', () => {
  const c = rampCh(0, 100, 1000, 100); // 11 samples, 0..100 linearly
  const d = evalOK('diff(A)', { A: c });
  // d should be ~100/sec at every interior sample (Δ=10 per 100ms = 100/s)
  assert.ok(d.values.length > 0);
  for (const v of d.values) assert.ok(aboutEq(v, 100, 0.1));
});

// ─── Calculus: derivative + derivative2 ───────────────────────────────────────

test('derivative(ch) is alias for diff(ch)', () => {
  const c = rampCh(0, 100, 1000, 100);
  const a = evalOK('diff(A)', { A: c });
  const b = evalOK('derivative(A)', { A: c });
  assert.deepEqual(a.timestamps, b.timestamps);
  for (let i = 0; i < a.values.length; i++) {
    assert.ok(aboutEq(a.values[i], b.values[i]), `diff[${i}]=${a.values[i]} vs derivative[${i}]=${b.values[i]}`);
  }
});

test('derivative2(ch) of quadratic 0.5*t^2 (t in s) → constant 1.0', () => {
  // t in ms; value = 0.5 * (t/1000)^2; second derivative w.r.t. t (s) is 1.0
  const ts: number[] = [];
  const vs: number[] = [];
  for (let t = 0; t <= 2000; t += 10) {
    ts.push(t);
    vs.push(0.5 * (t / 1000) ** 2);
  }
  const r = evalOK('derivative2(A)', { A: ch(ts, vs) });
  assert.ok(r.values.length > 10, 'should produce many samples');
  // Trim ends because numerical second-difference is unstable at edges
  const interior = r.values.slice(5, -5);
  for (const v of interior) {
    assert.ok(aboutEq(v, 1.0, 0.05), `expected ~1.0, got ${v}`);
  }
});

test('derivative2 of <3-sample channel → empty', () => {
  const c = ch([0, 100], [1, 2]); // 2 samples
  const r = evalOK('derivative2(A)', { A: c });
  assert.equal(r.values.length, 0);
});

// ─── Calculus: integral (running) ─────────────────────────────────────────────

test('integral of constant 5 over 1s → 5 (V·s = J)', () => {
  // 5 W constant for 1 s should integrate to 5 J at t=1000ms
  const c = constCh(5, 1000, 100);
  const r = evalOK('integral(A)', { A: c });
  // Final value should be ~5
  assert.ok(aboutEq(r.values[r.values.length - 1], 5, 1e-9), `final=${r.values[r.values.length - 1]}`);
  // First value at t=0 should be 0
  assert.equal(r.values[0], 0);
});

test('integral of linear ramp 0→1 over 1s → 0.5 (trapezoidal exact)', () => {
  const c = rampCh(0, 1, 1000, 10); // dense ramp
  const r = evalOK('integral(A)', { A: c });
  assert.ok(aboutEq(r.values[r.values.length - 1], 0.5, 1e-9), `final=${r.values[r.values.length - 1]}`);
});

test('integral output timestamps match input timestamps', () => {
  const c = constCh(2, 500, 50);
  const r = evalOK('integral(A)', { A: c });
  assert.deepEqual(r.timestamps, c.timestamps);
});

test('integral of single-sample channel → empty', () => {
  const c = ch([0], [5]);
  const r = evalOK('integral(A)', { A: c });
  assert.equal(r.values.length, 0);
});

test('integral of empty channel → empty', () => {
  const c = ch([], []);
  const r = evalOK('integral(A)', { A: c });
  assert.equal(r.values.length, 0);
});

test('Energy formula: integral(V*I) / 3600 → Wh story', () => {
  // 12 V, 10 A constant for 1 s = 120 J = 120/3600 Wh
  const v = constCh(12, 1000, 100);
  const i = constCh(10, 1000, 100);
  const r = evalOK('integral(VBAT * IBAT) / 3600', { VBAT: v, IBAT: i });
  assert.ok(aboutEq(r.values[r.values.length - 1], 120 / 3600, 1e-9));
});

// ─── Calculus: definite integral ──────────────────────────────────────────────

test('integral(ch, t_lo, t_hi) of constant returns scalar', () => {
  const c = constCh(3, 2000, 50);
  // Window is in ms (matching channel timestamps); integral of 3 over 1 s = 3
  const r = evalOK('integral(A, 500, 1500)', { A: c });
  // Definite integral is a scalar → returned as 1-sample output by evaluateFormula
  assert.equal(r.values.length, 1);
  assert.ok(aboutEq(r.values[0], 3, 1e-6), `got ${r.values[0]}`);
});

test('integral(ch, t_lo, t_hi) over zero-length window → 0', () => {
  const c = constCh(7, 1000, 50);
  const r = evalOK('integral(A, 500, 500)', { A: c });
  assert.equal(r.values.length, 1);
  assert.equal(r.values[0], 0);
});

test('integral(ch, t_lo, t_hi) of linear ramp 0→2 over [0, 1000ms] → 1.0', () => {
  const c = rampCh(0, 2, 1000, 5);
  const r = evalOK('integral(A, 0, 1000)', { A: c });
  assert.ok(aboutEq(r.values[0], 1.0, 1e-9), `got ${r.values[0]}`);
});

// ─── Bitwise: scalars ─────────────────────────────────────────────────────────

test('bitwise scalars: AND, OR, shifts', () => {
  assert.equal(evalOK('5 & 3').values[0], 1);
  assert.equal(evalOK('5 | 3').values[0], 7);
  assert.equal(evalOK('1 << 3').values[0], 8);
  assert.equal(evalOK('16 >> 2').values[0], 4);
  assert.equal(evalOK('-1 >> 1').values[0], -1); // sign-extending
});

test('xor() function', () => {
  assert.equal(evalOK('xor(5, 3)').values[0], 6);
  assert.equal(evalOK('xor(255, 15)').values[0], 240);
  assert.equal(evalOK('xor(xor(5, 3), 6)').values[0], 0); // associative
});

test('unary ~ (bitwise NOT)', () => {
  assert.equal(evalOK('~0').values[0], -1);
  assert.equal(evalOK('~5').values[0], -6);
  assert.equal(evalOK('~~5').values[0], 5);
});

test('bitwise truncates floats via |0 (32-bit signed)', () => {
  assert.equal(evalOK('7.9 | 0').values[0], 7);
  assert.equal(evalOK('(-7.9) | 0').values[0], -7);
});

test('bitwise on NaN → 0 (NaN|0 = 0)', () => {
  // 0/0 in our engine → NaN; NaN|0 = 0; 0 & anything = 0
  assert.equal(evalOK('(0/0) | 5').values[0], 5);
});

// ─── Bitwise: precedence ──────────────────────────────────────────────────────

test('precedence: + binds tighter than <<', () => {
  // C precedence: (1+2) << 3 = 3 << 3 = 24
  assert.equal(evalOK('1 + 2 << 3').values[0], 24);
});

test('precedence: << binds tighter than &', () => {
  // 1 << 2 & 6 = 4 & 6 = 4
  assert.equal(evalOK('1 << 2 & 6').values[0], 4);
});

test('precedence: & binds tighter than |', () => {
  // 1 | 2 & 0 = 1 | (2 & 0) = 1 | 0 = 1
  assert.equal(evalOK('1 | 2 & 0').values[0], 1);
});

test('precedence: ^ (power) binds tighter than bitwise', () => {
  // 2^3 & 7 = 8 & 7 = 0
  assert.equal(evalOK('2^3 & 7').values[0], 0);
});

// ─── Bitwise: channels ────────────────────────────────────────────────────────

test('bitwise on channel & scalar', () => {
  const status = ch([0, 100, 200], [0b0101, 0b0110, 0b1100]);
  const r = evalOK('S & 4', { S: status });
  assert.deepEqual(r.values, [0b0100, 0b0100, 0b0100]);
});

test('bitwise on two channels (same timestamps)', () => {
  const a = ch([0, 100], [0b1100, 0b1010]);
  const b = ch([0, 100], [0b0110, 0b1100]);
  const r = evalOK('A | B', { A: a, B: b });
  assert.deepEqual(r.values, [0b1110, 0b1110]);
});

test('bitwise on two channels (different rates → interpolate then truncate)', () => {
  // A samples at 0, 100, 200 — values 0,2,4
  // B samples at 0, 200       — values 0, 8
  // At t=100, B interpolates to 4 (midpoint 0..8). 2 & 4 = 0.
  const a = ch([0, 100, 200], [0, 2, 4]);
  const b = ch([0, 200], [0, 8]);
  const r = evalOK('A & B', { A: a, B: b });
  // Merged timestamps: [0, 100, 200]
  assert.deepEqual(r.timestamps, [0, 100, 200]);
  // 0&0=0, 2&4=0, 4&8=0
  assert.deepEqual(r.values, [0, 0, 0]);
});

// ─── extractChannelNames covers new ops ───────────────────────────────────────

test('extractChannelNames discovers names through bitwise + integral', () => {
  const names = extractChannelNames('integral(VBAT * IBAT) + (StatusBits & 4) << 2');
  assert.deepEqual(new Set(names), new Set(['VBAT', 'IBAT', 'StatusBits']));
});

test('extractChannelNames through derivative/derivative2/xor', () => {
  const names = extractChannelNames('xor(derivative(A), derivative2(B))');
  assert.deepEqual(new Set(names), new Set(['A', 'B']));
});

// ─── Error cases ──────────────────────────────────────────────────────────────

test('error: integral with 0 args', () => {
  evalErr('integral()');
});

test('error: integral with 4 args', () => {
  evalErr('integral(A, 0, 100, 200)', { A: constCh(1, 100) });
});

test('error: derivative2 with 2 args', () => {
  evalErr('derivative2(A, 1)', { A: constCh(1, 100) });
});

test('error: bare > or < still rejected by tokenizer', () => {
  evalErr('5 < 3');
  evalErr('5 > 3');
});
