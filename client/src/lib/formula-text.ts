/**
 * Converts formulas between the stored form (raw channel codes, e.g.
 * `FBrakePressure - RBrakePressCorr`) and the display form the editor shows
 * (`[Front Brake Pressure] - [Rear Brake Pressure]`).
 *
 * Both directions use a forgiving scanner instead of the formula parser, so
 * half-typed or invalid formulas convert without throwing or losing text.
 */
import type { ChannelInfo } from './channel-dictionary';
import { formatChannelRef } from './formula-engine';

export interface LabelIndex {
  /** Display label for a code (the code itself when it isn't indexed). */
  labelOf(code: string): string;
  /** Code for a display label or raw code, case-insensitive. */
  codeOf(label: string): string | undefined;
  /** True when the code is one of the indexed channels. */
  has(code: string): boolean;
}

export function buildLabelIndex(codes: string[], describe: (code: string) => ChannelInfo): LabelIndex {
  const codeSet = new Set(codes);
  const lowerCodes = new Map<string, string>();
  for (const c of codes) if (!lowerCodes.has(c.toLowerCase())) lowerCodes.set(c.toLowerCase(), c);

  const labelByCode = new Map<string, string>();
  const codeByLabel = new Map<string, string>();
  for (const code of codes) {
    let label = describe(code).label.trim() || code;
    const lower = label.toLowerCase();
    // A label must not collide with another label or with a different channel's code.
    const clashesCode = lowerCodes.has(lower) && lowerCodes.get(lower) !== code;
    if (codeByLabel.has(lower) || clashesCode) label = `${label} (${code})`;
    labelByCode.set(code, label);
    codeByLabel.set(label.toLowerCase(), code);
  }

  return {
    labelOf: (code) => labelByCode.get(code) ?? code,
    codeOf: (text) => {
      if (codeSet.has(text)) return text;
      const lower = text.trim().toLowerCase();
      return codeByLabel.get(lower) ?? lowerCodes.get(lower);
    },
    has: (code) => codeSet.has(code),
  };
}

type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'bracket'; inner: string }
  | { kind: 'ident'; name: string; call: boolean };

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/** Split a formula into channel-like pieces and everything else, verbatim. */
function scan(src: string): Piece[] {
  const out: Piece[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ kind: 'text', text }); text = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close < 0) { text += src.slice(i); break; }
      flush();
      out.push({ kind: 'bracket', inner: src.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      // Number literal; keep any letters glued to it (e.g. 1e5) as text too.
      let j = i;
      while (j < src.length && (IDENT_CHAR.test(src[j]) || src[j] === '.')) j++;
      text += src.slice(i, j);
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < src.length && IDENT_CHAR.test(src[j])) j++;
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      flush();
      out.push({ kind: 'ident', name: src.slice(i, j), call: src[k] === '(' });
      i = j;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

export function storedToDisplay(stored: string, idx: LabelIndex): string {
  return scan(stored).map(p => {
    if (p.kind === 'text') return p.text;
    if (p.kind === 'bracket') return idx.has(p.inner) ? `[${idx.labelOf(p.inner)}]` : `[${p.inner}]`;
    if (p.call || !idx.has(p.name)) return p.name;
    return `[${idx.labelOf(p.name)}]`;
  }).join('');
}

export function displayToStored(display: string, idx: LabelIndex): string {
  return scan(display).map(p => {
    if (p.kind === 'text') return p.text;
    if (p.kind === 'bracket') {
      const code = idx.codeOf(p.inner);
      return code !== undefined ? formatChannelRef(code) : `[${p.inner}]`;
    }
    if (p.call) return p.name;
    const code = idx.codeOf(p.name);
    return code !== undefined ? formatChannelRef(code) : p.name;
  }).join('');
}
