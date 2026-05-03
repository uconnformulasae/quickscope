/**
 * QuickScope Formula Engine
 * Evaluates math expressions and JS expressions against channel data.
 *
 * Formula mode supports:
 *   - Arithmetic operators: +, -, *, /, ^ (power, right-associative), ()
 *   - Bitwise operators: &, |, <<, >>, >>> (zero-fill), unary ~
 *                        (32-bit signed; floats truncated via |0; `>>>` returns
 *                         an unsigned 32-bit value)
 *   - Math functions: abs, sqrt, min, max, sin, cos, log, exp, pow, xor
 *   - Signal functions: diff(ch), derivative(ch), derivative2(ch),
 *                       integral(ch), integral(ch, t_lo_ms, t_hi_ms),
 *                       smooth(ch, window), mavg(ch, window_ms), delay(ch, samples)
 *   - Channel names (resolved to sample arrays)
 *   - Numeric literals: decimal (`12`, `0.5`) and hex (`0xFF`, `0xff`, `0x1A2B`)
 *   - Scalar constants (e, pi)
 *
 * Precedence (loose → tight):
 *   |  →  &  →  << >> >>>  →  + -  →  * /  →  ^ (right-assoc)  →  unary - + ~
 *
 * JavaScript mode: user writes a function body that receives `channels`
 * and `interpolate` helpers and returns { timestamps, values }.
 */

export interface ChannelData {
  timestamps: number[];
  values: number[];
}

export type ChannelMap = Record<string, ChannelData>;

// ─── Interpolation helper ─────────────────────────────────────────────────────

function interpolateAt(ch: ChannelData, t: number): number {
  if (ch.timestamps.length === 0) return 0;
  if (t <= ch.timestamps[0]) return ch.values[0];
  if (t >= ch.timestamps[ch.timestamps.length - 1]) return ch.values[ch.timestamps.length - 1];

  // Binary search
  let lo = 0;
  let hi = ch.timestamps.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (ch.timestamps[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = ch.timestamps[lo];
  const t1 = ch.timestamps[hi];
  const frac = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return ch.values[lo] + frac * (ch.values[hi] - ch.values[lo]);
}

/** Merge multiple timestamp arrays into a single sorted unique array */
function mergeTimestamps(arrays: number[][]): number[] {
  const set = new Set<number>();
  for (const arr of arrays) for (const t of arr) set.add(t);
  return Array.from(set).sort((a, b) => a - b);
}

// ─── Signal processing functions ──────────────────────────────────────────────

function applyDiff(ch: ChannelData): ChannelData {
  if (ch.timestamps.length < 2) return { timestamps: [], values: [] };
  const timestamps: number[] = [];
  const values: number[] = [];
  for (let i = 1; i < ch.timestamps.length; i++) {
    const dt = ch.timestamps[i] - ch.timestamps[i - 1];
    if (dt === 0) continue;
    timestamps.push(ch.timestamps[i]);
    values.push((ch.values[i] - ch.values[i - 1]) / (dt / 1000)); // per second
  }
  return { timestamps, values };
}

function applySmooth(ch: ChannelData, window: number): ChannelData {
  const n = ch.values.length;
  if (n === 0) return ch;
  const half = Math.floor(window / 2);
  const values = new Array<number>(n);
  // Sliding window: maintain running sum
  let sum = 0;
  for (let i = 0; i < Math.min(half + 1, n); i++) sum += ch.values[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    // Expand window right
    if (i + half < n && i > 0) sum += ch.values[i + half];
    // Shrink window left
    if (i - half - 1 >= 0) sum -= ch.values[i - half - 1];
    values[i] = sum / (hi - lo + 1);
  }
  return { timestamps: ch.timestamps, values };
}

function applyMavg(ch: ChannelData, windowMs: number): ChannelData {
  const n = ch.timestamps.length;
  if (n === 0 || windowMs <= 0) return ch;

  // Expected sample count for a fully-populated window — used as the
  // constant divisor so under-filled windows are zero-padded (FSAE EV.3.4.1.a:
  // before the session starts, power = 0, so MAVG should ramp from 0).
  const totalDuration = ch.timestamps[n - 1] - ch.timestamps[0];
  const meanDt = totalDuration > 0 ? totalDuration / (n - 1) : windowMs;
  const expectedCount = Math.max(1, Math.round(windowMs / meanDt));

  const values = new Array<number>(n);
  let sum = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const t = ch.timestamps[i];
    sum += ch.values[i];
    while (lo < i && ch.timestamps[lo] < t - windowMs) {
      sum -= ch.values[lo];
      lo++;
    }
    values[i] = sum / expectedCount;
  }
  return { timestamps: ch.timestamps, values };
}

/**
 * Running cumulative trapezoidal integral. Output value at sample i is the
 * area under the curve from t[0] to t[i]. Time is converted ms → seconds so
 * `integral(Power_W)` yields Joules.
 */
function applyIntegral(ch: ChannelData): ChannelData {
  const n = ch.timestamps.length;
  if (n < 2) return { timestamps: [], values: [] };
  const timestamps: number[] = new Array(n);
  const values: number[] = new Array(n);
  timestamps[0] = ch.timestamps[0];
  values[0] = 0;
  let acc = 0;
  for (let i = 1; i < n; i++) {
    const dtSec = (ch.timestamps[i] - ch.timestamps[i - 1]) / 1000;
    // Trapezoidal: (v_prev + v_curr)/2 * dt
    acc += 0.5 * (ch.values[i - 1] + ch.values[i]) * dtSec;
    timestamps[i] = ch.timestamps[i];
    values[i] = acc;
  }
  return { timestamps, values };
}

/**
 * Definite trapezoidal integral over [t_lo_ms, t_hi_ms]. Endpoints are
 * resolved by linear interpolation; output is in (channel units) × seconds.
 * Returns 0 for a zero-length window. Window is clamped to channel range.
 */
function applyDefiniteIntegral(ch: ChannelData, tLoMs: number, tHiMs: number): number {
  if (ch.timestamps.length < 2 || tHiMs === tLoMs) return 0;
  const lo = Math.min(tLoMs, tHiMs);
  const hi = Math.max(tLoMs, tHiMs);
  const sign = tHiMs >= tLoMs ? 1 : -1;

  const tFirst = ch.timestamps[0];
  const tLast = ch.timestamps[ch.timestamps.length - 1];
  const a = Math.max(lo, tFirst);
  const b = Math.min(hi, tLast);
  if (b <= a) return 0;

  // Walk samples between a and b, summing trapezoids using interpolated endpoints.
  const vA = interpolateAt(ch, a);
  const vB = interpolateAt(ch, b);

  // Find the first index strictly greater than a.
  let i = 0;
  while (i < ch.timestamps.length && ch.timestamps[i] <= a) i++;
  // Now ch.timestamps[i-1] <= a < ch.timestamps[i] (or i out of range).

  let acc = 0;
  let prevT = a;
  let prevV = vA;
  while (i < ch.timestamps.length && ch.timestamps[i] < b) {
    const t = ch.timestamps[i];
    const v = ch.values[i];
    const dtSec = (t - prevT) / 1000;
    acc += 0.5 * (prevV + v) * dtSec;
    prevT = t;
    prevV = v;
    i++;
  }
  // Final trapezoid up to b.
  acc += 0.5 * (prevV + vB) * ((b - prevT) / 1000);
  return sign * acc;
}

function applyDelay(ch: ChannelData, samples: number): ChannelData {
  const s = Math.floor(Math.abs(samples));
  if (s === 0 || s >= ch.timestamps.length) return ch;
  // Delay shifts values forward: value at timestamp[i+s] gets value[i]
  return {
    timestamps: ch.timestamps.slice(s),
    values: ch.values.slice(s),
  };
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type TokenType =
  | 'number'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(', pos: i }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')', pos: i }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ',', pos: i }); i++; continue; }
    if (ch === '<' && expr[i + 1] === '<') { tokens.push({ type: 'op', value: '<<', pos: i }); i += 2; continue; }
    // Order matters: '>>>' must be checked before '>>'.
    if (ch === '>' && expr[i + 1] === '>' && expr[i + 2] === '>') { tokens.push({ type: 'op', value: '>>>', pos: i }); i += 3; continue; }
    if (ch === '>' && expr[i + 1] === '>') { tokens.push({ type: 'op', value: '>>', pos: i }); i += 2; continue; }
    if ('+-*/^&|~'.includes(ch)) { tokens.push({ type: 'op', value: ch, pos: i }); i++; continue; }
    // Hex literal: 0x[0-9a-fA-F]+ — must be checked before the decimal branch
    // because hex starts with '0'. At least one hex digit is required.
    if (ch === '0' && (expr[i + 1] === 'x' || expr[i + 1] === 'X')) {
      let j = i + 2;
      const isHexDigit = (c: string) =>
        (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
      while (j < expr.length && isHexDigit(expr[j])) j++;
      if (j === i + 2) {
        throw new Error(`Malformed hex literal at position ${i}: expected hex digit after '0x'`);
      }
      tokens.push({ type: 'number', value: expr.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      // number literal
      let j = i;
      while (j < expr.length && (expr[j] >= '0' && expr[j] <= '9' || expr[j] === '.')) j++;
      tokens.push({ type: 'number', value: expr.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i;
      while (j < expr.length && (
        (expr[j] >= 'a' && expr[j] <= 'z') ||
        (expr[j] >= 'A' && expr[j] <= 'Z') ||
        (expr[j] >= '0' && expr[j] <= '9') ||
        expr[j] === '_' || expr[j] === '-'
      )) j++;
      tokens.push({ type: 'ident', value: expr.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({ type: 'eof', value: '', pos: expr.length });
  return tokens;
}

// ─── AST types ────────────────────────────────────────────────────────────────

type ASTNode =
  | { kind: 'number'; value: number }
  | { kind: 'channel'; name: string }
  | { kind: 'binop'; op: string; left: ASTNode; right: ASTNode }
  | { kind: 'unary'; op: string; arg: ASTNode }
  | { kind: 'call'; name: string; args: ASTNode[] };

// ─── Parser (recursive descent) ───────────────────────────────────────────────

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private consume(): Token { return this.tokens[this.pos++]; }

  private expect(type: TokenType): Token {
    const t = this.consume();
    if (t.type !== type) throw new Error(`Expected ${type} but got '${t.value}' (${t.type})`);
    return t;
  }

  parse(): ASTNode {
    const node = this.parseExpr();
    if (this.peek().type !== 'eof') {
      throw new Error(`Unexpected token '${this.peek().value}'`);
    }
    return node;
  }

  private parseExpr(): ASTNode { return this.parseBitOr(); }

  private parseBitOr(): ASTNode {
    let left = this.parseBitAnd();
    while (this.peek().type === 'op' && this.peek().value === '|') {
      const op = this.consume().value;
      const right = this.parseBitAnd();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }

  private parseBitAnd(): ASTNode {
    let left = this.parseShift();
    while (this.peek().type === 'op' && this.peek().value === '&') {
      const op = this.consume().value;
      const right = this.parseShift();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }

  private parseShift(): ASTNode {
    let left = this.parseAddSub();
    while (this.peek().type === 'op' && (
      this.peek().value === '<<' ||
      this.peek().value === '>>' ||
      this.peek().value === '>>>'
    )) {
      const op = this.consume().value;
      const right = this.parseAddSub();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }

  private parseAddSub(): ASTNode {
    let left = this.parseMulDiv();
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.consume().value;
      const right = this.parseMulDiv();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parsePow();
    while (this.peek().type === 'op' && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.consume().value;
      const right = this.parsePow();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }

  /** Parse ^ as right-associative: a^b^c = a^(b^c) */
  private parsePow(): ASTNode {
    const base = this.parseUnary();
    if (this.peek().type === 'op' && this.peek().value === '^') {
      this.consume();
      const exponent = this.parsePow(); // right-recursive for right-associativity
      return { kind: 'binop', op: '^', left: base, right: exponent };
    }
    return base;
  }

  private parseUnary(): ASTNode {
    if (this.peek().type === 'op' && this.peek().value === '-') {
      this.consume();
      return { kind: 'unary', op: '-', arg: this.parseUnary() };
    }
    if (this.peek().type === 'op' && this.peek().value === '+') {
      this.consume();
      return this.parseUnary();
    }
    if (this.peek().type === 'op' && this.peek().value === '~') {
      this.consume();
      return { kind: 'unary', op: '~', arg: this.parseUnary() };
    }
    return this.parseAtom();
  }

  private parseAtom(): ASTNode {
    const t = this.peek();

    if (t.type === 'number') {
      this.consume();
      // Number() handles both decimal floats ("0.5") and hex ints ("0xFF").
      return { kind: 'number', value: Number(t.value) };
    }

    if (t.type === 'lparen') {
      this.consume();
      const inner = this.parseExpr();
      this.expect('rparen');
      return inner;
    }

    if (t.type === 'ident') {
      this.consume();
      // Check for function call
      if (this.peek().type === 'lparen') {
        this.consume(); // consume '('
        const args: ASTNode[] = [];
        if (this.peek().type !== 'rparen') {
          args.push(this.parseExpr());
          while (this.peek().type === 'comma') {
            this.consume();
            args.push(this.parseExpr());
          }
        }
        this.expect('rparen');
        return { kind: 'call', name: t.value, args };
      }
      // Channel name or bare number like 'e' constant
      if (t.value === 'e') return { kind: 'number', value: Math.E };
      if (t.value === 'pi' || t.value === 'PI') return { kind: 'number', value: Math.PI };
      return { kind: 'channel', name: t.value };
    }

    throw new Error(`Unexpected token '${t.value}' at position ${t.pos}`);
  }
}

// ─── Evaluator ────────────────────────────────────────────────────────────────

/**
 * Evaluate an AST node. Returns either:
 * - a scalar number (for constant subtrees)
 * - a ChannelData (timestamps + values array)
 */
type EvalResult = number | ChannelData;

const MATH_FUNCS: Record<string, (x: number) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
};

function scalarToChannel(value: number, ts: number[]): ChannelData {
  return { timestamps: ts, values: ts.map(() => value) };
}

function ensureChannel(v: EvalResult, referenceTs?: number[]): ChannelData {
  if (typeof v === 'number') {
    const ts = referenceTs || [0];
    return scalarToChannel(v, ts);
  }
  return v;
}

function applyBinop(op: string, a: EvalResult, b: EvalResult): EvalResult {
  // Scalar × scalar
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b !== 0 ? a / b : NaN;
      case '^': return Math.pow(a, b);
      // Bitwise: JS engine truncates to 32-bit signed via |0; NaN/Inf → 0.
      // `>>>` is JS's unsigned/zero-fill right shift — output is in
      // [0, 2^32-1] so high-bit values come back positive.
      case '&':   return (a | 0) & (b | 0);
      case '|':   return (a | 0) | (b | 0);
      case '<<':  return (a | 0) << (b | 0);
      case '>>':  return (a | 0) >> (b | 0);
      case '>>>': return (a | 0) >>> (b | 0);
    }
  }

  // At least one is a channel — interpolate to merged timestamps
  const aCh = ensureChannel(a);
  const bCh = ensureChannel(b);
  const ts = mergeTimestamps([aCh.timestamps, bCh.timestamps]);
  const values = ts.map(t => {
    const av = typeof a === 'number' ? a : interpolateAt(aCh, t);
    const bv = typeof b === 'number' ? b : interpolateAt(bCh, t);
    switch (op) {
      case '+': return av + bv;
      case '-': return av - bv;
      case '*': return av * bv;
      case '/': return bv !== 0 ? av / bv : NaN;
      case '^': return Math.pow(av, bv);
      case '&':   return (av | 0) & (bv | 0);
      case '|':   return (av | 0) | (bv | 0);
      case '<<':  return (av | 0) << (bv | 0);
      case '>>':  return (av | 0) >> (bv | 0);
      case '>>>': return (av | 0) >>> (bv | 0);
      default: return NaN;
    }
  });
  return { timestamps: ts, values };
}

function evalNode(node: ASTNode, channels: ChannelMap): EvalResult {
  switch (node.kind) {
    case 'number':
      return node.value;

    case 'channel': {
      const ch = channels[node.name];
      if (!ch) throw new Error(`Unknown channel: '${node.name}'`);
      return ch;
    }

    case 'unary': {
      const v = evalNode(node.arg, channels);
      if (node.op === '~') {
        if (typeof v === 'number') return ~(v | 0);
        return { timestamps: v.timestamps, values: v.values.map(x => ~(x | 0)) };
      }
      // '-' (unary plus is dropped at parse time)
      if (typeof v === 'number') return -v;
      return { timestamps: v.timestamps, values: v.values.map(x => -x) };
    }

    case 'binop': {
      const left = evalNode(node.left, channels);
      const right = evalNode(node.right, channels);
      return applyBinop(node.op, left, right);
    }

    case 'call': {
      const name = node.name.toLowerCase();

      // Signal functions with ChannelData arguments
      if (name === 'diff' || name === 'derivative') {
        if (node.args.length !== 1) throw new Error(`${name}() takes 1 argument`);
        const arg = evalNode(node.args[0], channels);
        const ch = ensureChannel(arg);
        return applyDiff(ch);
      }

      if (name === 'derivative2') {
        if (node.args.length !== 1) throw new Error('derivative2() takes 1 argument');
        const arg = evalNode(node.args[0], channels);
        const ch = ensureChannel(arg);
        return applyDiff(applyDiff(ch));
      }

      if (name === 'integral') {
        if (node.args.length === 1) {
          const arg = evalNode(node.args[0], channels);
          const ch = ensureChannel(arg);
          return applyIntegral(ch);
        }
        if (node.args.length === 3) {
          const arg = evalNode(node.args[0], channels);
          const lo = evalNode(node.args[1], channels);
          const hi = evalNode(node.args[2], channels);
          if (typeof lo !== 'number' || typeof hi !== 'number') {
            throw new Error('integral() window bounds must be numbers (milliseconds)');
          }
          const ch = ensureChannel(arg);
          return applyDefiniteIntegral(ch, lo, hi);
        }
        throw new Error('integral() takes 1 argument (running) or 3 arguments (channel, t_lo_ms, t_hi_ms)');
      }

      if (name === 'xor') {
        if (node.args.length !== 2) throw new Error('xor() takes 2 arguments');
        const a = evalNode(node.args[0], channels);
        const b = evalNode(node.args[1], channels);
        if (typeof a === 'number' && typeof b === 'number') return (a | 0) ^ (b | 0);
        const aCh = ensureChannel(a);
        const bCh = ensureChannel(b);
        const ts = mergeTimestamps([aCh.timestamps, bCh.timestamps]);
        return {
          timestamps: ts,
          values: ts.map(t => {
            const av = typeof a === 'number' ? a : interpolateAt(aCh, t);
            const bv = typeof b === 'number' ? b : interpolateAt(bCh, t);
            return (av | 0) ^ (bv | 0);
          }),
        };
      }

      if (name === 'smooth') {
        if (node.args.length !== 2) throw new Error('smooth() takes 2 arguments');
        const arg = evalNode(node.args[0], channels);
        const win = evalNode(node.args[1], channels);
        if (typeof win !== 'number') throw new Error('smooth() window must be a number');
        const ch = ensureChannel(arg);
        return applySmooth(ch, Math.round(win));
      }

      if (name === 'mavg') {
        if (node.args.length !== 2) throw new Error('mavg() takes 2 arguments: expression, window_ms');
        const arg = evalNode(node.args[0], channels);
        const win = evalNode(node.args[1], channels);
        if (typeof win !== 'number') throw new Error('mavg() window must be a number (milliseconds)');
        const ch = ensureChannel(arg);
        return applyMavg(ch, win);
      }

      if (name === 'delay') {
        if (node.args.length !== 2) throw new Error('delay() takes 2 arguments');
        const arg = evalNode(node.args[0], channels);
        const samples = evalNode(node.args[1], channels);
        if (typeof samples !== 'number') throw new Error('delay() samples must be a number');
        const ch = ensureChannel(arg);
        return applyDelay(ch, samples);
      }

      // min/max with 2 args (scalar or channel)
      if (name === 'min' && node.args.length === 2) {
        const a = evalNode(node.args[0], channels);
        const b = evalNode(node.args[1], channels);
        if (typeof a === 'number' && typeof b === 'number') return Math.min(a, b);
        const aCh = ensureChannel(a);
        const bCh = ensureChannel(b);
        const ts = mergeTimestamps([aCh.timestamps, bCh.timestamps]);
        return { timestamps: ts, values: ts.map(t => Math.min(interpolateAt(aCh, t), interpolateAt(bCh, t))) };
      }

      if (name === 'max' && node.args.length === 2) {
        const a = evalNode(node.args[0], channels);
        const b = evalNode(node.args[1], channels);
        if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
        const aCh = ensureChannel(a);
        const bCh = ensureChannel(b);
        const ts = mergeTimestamps([aCh.timestamps, bCh.timestamps]);
        return { timestamps: ts, values: ts.map(t => Math.max(interpolateAt(aCh, t), interpolateAt(bCh, t))) };
      }

      // pow(a, b) - 2 args
      if (name === 'pow') {
        if (node.args.length !== 2) throw new Error('pow() takes 2 arguments');
        const a = evalNode(node.args[0], channels);
        const b = evalNode(node.args[1], channels);
        return applyBinop('^', a, b);
      }

      // Single-arg math functions
      const mathFn = MATH_FUNCS[name];
      if (mathFn) {
        if (node.args.length !== 1) throw new Error(`${name}() takes 1 argument`);
        const arg = evalNode(node.args[0], channels);
        if (typeof arg === 'number') return mathFn(arg);
        return { timestamps: arg.timestamps, values: arg.values.map(mathFn) };
      }

      throw new Error(`Unknown function: '${node.name}'`);
    }
  }
}

// ─── AST helpers ──────────────────────────────────────────────────────────────

function walkChannelNames(node: ASTNode, out: Set<string>): void {
  switch (node.kind) {
    case 'channel': out.add(node.name); return;
    case 'unary': walkChannelNames(node.arg, out); return;
    case 'binop':
      walkChannelNames(node.left, out);
      walkChannelNames(node.right, out);
      return;
    case 'call':
      for (const a of node.args) walkChannelNames(a, out);
      return;
  }
}

/** Extract identifiers the parser treats as channel references.
 *  Returns [] if the expression doesn't parse — caller can ignore and let
 *  the real evaluator surface the syntax error later. */
export function extractChannelNames(expression: string): string[] {
  try {
    const tokens = tokenize(expression.trim());
    const ast = new Parser(tokens).parse();
    const names = new Set<string>();
    walkChannelNames(ast, names);
    return Array.from(names);
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a math formula expression.
 * Returns { timestamps, values } on success, or an error string.
 */
export function evaluateFormula(
  expression: string,
  channels: ChannelMap,
): { timestamps: number[]; values: number[] } | string {
  try {
    const tokens = tokenize(expression.trim());
    const ast = new Parser(tokens).parse();
    const result = evalNode(ast, channels);
    if (typeof result === 'number') {
      // Scalar result — no timestamps
      return { timestamps: [0], values: [result] };
    }
    // Filter NaN values
    const clean: { timestamps: number[]; values: number[] } = { timestamps: [], values: [] };
    for (let i = 0; i < result.timestamps.length; i++) {
      if (isFinite(result.values[i])) {
        clean.timestamps.push(result.timestamps[i]);
        clean.values.push(result.values[i]);
      }
    }
    return clean;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

