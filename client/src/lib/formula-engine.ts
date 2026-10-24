/**
 * QuickScope Formula Engine
 * Evaluates math expressions against channel data.
 *
 * Supports:
 *   - Standard operators: +, -, *, /, ^, ()
 *   - Math functions: abs, sqrt, min, max, sin, cos, log, exp, pow
 *   - Signal functions: diff(ch), smooth(ch, window), mavg(ch, window_ms), delay(ch, samples)
 *   - Channel names (resolved to sample arrays)
 *   - Scalar constants (pi, e)
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

  // Time-weighted average over the trailing window [t - windowMs, t]: the
  // trapezoidal integral of the signal divided by the window length. Time
  // before the channel's first sample counts as 0, so the average ramps up
  // from 0 at the start of the session (FSAE EV.3.4.1.a: before the session
  // starts, power = 0). Integrating over time rather than counting samples
  // keeps the result correct when the sample rate varies or the log pauses.
  const ts = ch.timestamps;
  const vs = ch.values;
  // prefix[i] = integral of the signal from ts[0] to ts[i]
  const prefix = new Array<number>(n);
  prefix[0] = 0;
  for (let i = 1; i < n; i++) {
    prefix[i] = prefix[i - 1] + ((vs[i] + vs[i - 1]) / 2) * (ts[i] - ts[i - 1]);
  }

  const values = new Array<number>(n);
  let k = 0; // last index with ts[k] <= window start
  for (let i = 0; i < n; i++) {
    const start = ts[i] - windowMs;
    let integral: number;
    if (start <= ts[0]) {
      integral = prefix[i];
    } else {
      while (k + 1 < i && ts[k + 1] <= start) k++;
      const t0 = ts[k];
      const t1 = ts[k + 1];
      const vAtStart = t1 === t0 ? vs[k] : vs[k] + ((start - t0) / (t1 - t0)) * (vs[k + 1] - vs[k]);
      // Integral from ts[k] to the window start, removed from the prefix.
      const head = ((vs[k] + vAtStart) / 2) * (start - t0);
      integral = prefix[i] - prefix[k] - head;
    }
    values[i] = integral / windowMs;
  }
  return { timestamps: ts, values };
}

function applyDelay(ch: ChannelData, samples: number): ChannelData {
  const s = Math.floor(samples);
  const n = ch.timestamps.length;
  if (s === 0 || Math.abs(s) >= n) return ch;
  if (s > 0) {
    // Delay: value[i] shifts forward in time to timestamp[i + s]
    return {
      timestamps: ch.timestamps.slice(s),
      values: ch.values.slice(0, n - s),
    };
  } else {
    // Lead (negative delay): value[i] shifts backward in time to timestamp[i - |s|]
    const absS = Math.abs(s);
    return {
      timestamps: ch.timestamps.slice(0, n - absS),
      values: ch.values.slice(absS),
    };
  }
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
    if ('+-*/^'.includes(ch)) { tokens.push({ type: 'op', value: ch, pos: i }); i++; continue; }
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
        expr[j] === '_'
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

  private parseExpr(): ASTNode { return this.parseAddSub(); }

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
    return this.parseAtom();
  }

  private parseAtom(): ASTNode {
    const t = this.peek();

    if (t.type === 'number') {
      this.consume();
      return { kind: 'number', value: parseFloat(t.value) };
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
      // Channel identifier (falls back to e/pi constant if channel not present)
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

/** Timestamps for combining two operands, at least one of them a channel.
 *  A scalar takes on the channel's timestamps; it must never add samples of
 *  its own (that would fabricate a point at t=0 before the channel starts). */
function combinedTimestamps(a: EvalResult, b: EvalResult): number[] {
  if (typeof a === 'number') return (b as ChannelData).timestamps;
  if (typeof b === 'number') return a.timestamps;
  return mergeTimestamps([a.timestamps, b.timestamps]);
}

/** Pointwise f over two operands on their combined timestamps. */
function combine(a: EvalResult, b: EvalResult, f: (x: number, y: number) => number): ChannelData {
  const ts = combinedTimestamps(a, b);
  const values = ts.map(t => {
    const av = typeof a === 'number' ? a : interpolateAt(a, t);
    const bv = typeof b === 'number' ? b : interpolateAt(b, t);
    return f(av, bv);
  });
  return { timestamps: ts, values };
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
    }
  }

  // At least one is a channel — interpolate onto the combined timestamps
  return combine(a, b, (av, bv) => {
    switch (op) {
      case '+': return av + bv;
      case '-': return av - bv;
      case '*': return av * bv;
      case '/': return bv !== 0 ? av / bv : NaN;
      case '^': return Math.pow(av, bv);
      default: return NaN;
    }
  });
}

function evalNode(node: ASTNode, channels: ChannelMap): EvalResult {
  switch (node.kind) {
    case 'number':
      return node.value;

    case 'channel': {
      const ch = channels[node.name];
      if (!ch) {
        if (node.name === 'e') return Math.E;
        if (node.name === 'pi' || node.name === 'PI') return Math.PI;
        throw new Error(`Unknown channel: '${node.name}'`);
      }
      return ch;
    }

    case 'unary': {
      const v = evalNode(node.arg, channels);
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
      if (name === 'diff') {
        if (node.args.length !== 1) throw new Error('diff() takes 1 argument');
        const arg = evalNode(node.args[0], channels);
        const ch = ensureChannel(arg);
        return applyDiff(ch);
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
        return combine(a, b, Math.min);
      }

      if (name === 'max' && node.args.length === 2) {
        const a = evalNode(node.args[0], channels);
        const b = evalNode(node.args[1], channels);
        if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
        return combine(a, b, Math.max);
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
      if (!Number.isFinite(result)) {
        return 'Expression evaluated to non-finite result (division by zero)';
      }
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

