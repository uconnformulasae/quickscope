/**
 * FormulaInput — a formula box that shows channels by plain-English name.
 *
 * The parent owns the *stored* formula (raw channel codes). This component
 * edits a *display* form where each channel appears as `[Friendly Label]`,
 * drawn as a tinted tag by an overlay behind a transparent-text textarea.
 * The overlay draws the same characters as the textarea, so caret positions
 * stay exact and ordinary keyboard editing, copy and paste all work.
 */
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChannelInfo } from '../../lib/channel-dictionary';
import { checkFormula, formatChannelRef, FUNCTION_HELP } from '../../lib/formula-engine';
import { displayToStored, storedToDisplay, type LabelIndex } from '../../lib/formula-text';

export interface FormulaInputHandle {
  /** Insert a channel at the caret (or where the caret last was). */
  insertChannel(code: string): void;
  focus(): void;
}

interface FormulaInputProps {
  /** Stored formula (raw codes). */
  value: string;
  onChange(stored: string): void;
  channels: ChannelInfo[];
  labelIndex: LabelIndex;
  /** Show and edit the raw stored text instead of friendly names. */
  showCodes?: boolean;
  rows?: number;
  testId?: string;
  /** Units per channel code, shown in suggestions. */
  unitsOf?(code: string): string;
  placeholder?: string;
}

type Suggestion =
  | { kind: 'channel'; info: ChannelInfo }
  | { kind: 'function'; name: string; signature: string; description: string };

const MAX_SUGGESTIONS = 8;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/** The partial word being typed just before the caret, if any. */
function wordAtCaret(text: string, caret: number): { start: number; query: string; bracket: boolean } | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf('[');
  if (open >= 0 && before.indexOf(']', open) < 0) {
    return { start: open, query: before.slice(open + 1), bracket: true };
  }
  let i = caret;
  while (i > 0 && IDENT_CHAR.test(text[i - 1])) i--;
  if (i > 0 && text[i - 1] === ']') return null;
  const query = text.slice(i, caret);
  if (query.length < 2 || /^[0-9]/.test(query)) return null;
  return { start: i, query, bracket: false };
}

function rankChannel(info: ChannelInfo, label: string, q: string): number {
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 0;
  if (l.split(/[\s(-]+/).some(w => w.startsWith(q))) return 1;
  if (l.includes(q)) return 2;
  if (info.code.toLowerCase().includes(q)) return 3;
  if (info.category.toLowerCase().includes(q)) return 4;
  if (info.description.toLowerCase().includes(q)) return 5;
  return -1;
}

export const FormulaInput = forwardRef<FormulaInputHandle, FormulaInputProps>(function FormulaInput(
  { value, onChange, channels, labelIndex, showCodes = false, rows = 3, testId, unitsOf, placeholder },
  ref,
) {
  const toText = (stored: string) => (showCodes ? stored : storedToDisplay(stored, labelIndex));
  const toStored = (text: string) => (showCodes ? text : displayToStored(text, labelIndex));

  const [text, setText] = useState(() => toText(value));
  const lastEmitted = useRef(value);
  const caret = useRef(text.length);
  const pendingCaret = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<{ start: number; query: string; bracket: boolean } | null>(null);
  const [active, setActive] = useState(0);

  // Re-derive the text when the stored value changes from outside (a recipe,
  // switching "Show codes", a user rename) — but not for our own edits.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setText(toText(value));
      setQuery(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // Switching "Show codes" or renaming a channel redraws the text. (Parents
  // must memoise labelIndex; a new index object counts as a rename.)
  const shownWith = useRef({ showCodes, labelIndex });
  useEffect(() => {
    if (shownWith.current.showCodes === showCodes && shownWith.current.labelIndex === labelIndex) return;
    shownWith.current = { showCodes, labelIndex };
    setText(toText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCodes, labelIndex]);

  useEffect(() => {
    const ta = taRef.current;
    if (ta && pendingCaret.current !== null) {
      ta.setSelectionRange(pendingCaret.current, pendingCaret.current);
      caret.current = pendingCaret.current;
      pendingCaret.current = null;
    }
  }, [text]);

  const commit = (next: string, nextCaret?: number) => {
    setText(next);
    if (nextCaret !== undefined) pendingCaret.current = nextCaret;
    const stored = toStored(next);
    lastEmitted.current = stored;
    onChange(stored);
  };

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!query) return [];
    const q = query.query.trim().toLowerCase();
    if (!q) return [];
    const chans = channels
      .map(info => ({ info, r: rankChannel(info, labelIndex.labelOf(info.code), q) }))
      .filter(x => x.r >= 0)
      .sort((a, b) => a.r - b.r || labelIndex.labelOf(a.info.code).localeCompare(labelIndex.labelOf(b.info.code)))
      .map(x => ({ kind: 'channel' as const, info: x.info }));
    const fns = query.bracket ? [] : FUNCTION_HELP
      .filter(f => f.name.startsWith(q))
      .map(f => ({ kind: 'function' as const, ...f }));
    return [...fns, ...chans].slice(0, MAX_SUGGESTIONS);
  }, [query, channels, labelIndex]);

  useEffect(() => { setActive(0); }, [query?.query]);

  const refreshQuery = () => {
    const ta = taRef.current;
    if (!ta) return;
    caret.current = ta.selectionStart ?? ta.value.length;
    setQuery(ta.selectionStart === ta.selectionEnd ? wordAtCaret(ta.value, caret.current) : null);
  };

  const channelText = (code: string) => (showCodes ? formatChannelRef(code) : `[${labelIndex.labelOf(code)}]`);

  const accept = (s: Suggestion) => {
    if (!query) return;
    const insert = s.kind === 'channel' ? channelText(s.info.code) : `${s.name}(`;
    const end = caret.current;
    // Swallow a closing ']' the user already typed after the partial name.
    const tailStart = query.bracket && text[end] === ']' ? end + 1 : end;
    const next = text.slice(0, query.start) + insert + text.slice(tailStart);
    setQuery(null);
    commit(next, query.start + insert.length);
  };

  useImperativeHandle(ref, () => ({
    insertChannel(code: string) {
      const at = Math.min(caret.current, text.length);
      const insert = channelText(code);
      commit(text.slice(0, at) + insert + text.slice(at), at + insert.length);
      taRef.current?.focus();
    },
    focus() { taRef.current?.focus(); },
  }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(suggestions[Math.min(active, suggestions.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuery(null); return; }
    }
    if (e.key === 'Backspace' && !showCodes) {
      const ta = e.currentTarget;
      const at = ta.selectionStart;
      if (at === ta.selectionEnd && at > 0 && text[at - 1] === ']') {
        const open = text.lastIndexOf('[', at - 1);
        if (open >= 0) {
          e.preventDefault();
          commit(text.slice(0, open) + text.slice(at), open);
          setQuery(null);
        }
      }
    }
  };

  const isKnown = (name: string) => labelIndex.codeOf(name) !== undefined;
  const problem = text.trim() ? checkFormula(text, isKnown) : null;

  // Overlay: same characters as the textarea, with [channel] runs drawn as tags.
  const overlay: ReactNode[] = [];
  if (!showCodes) {
    let i = 0;
    let k = 0;
    while (i < text.length) {
      const open = text.indexOf('[', i);
      const close = open >= 0 ? text.indexOf(']', open + 1) : -1;
      if (open < 0 || close < 0) { overlay.push(text.slice(i)); break; }
      if (open > i) overlay.push(text.slice(i, open));
      const inner = text.slice(open + 1, close);
      const known = isKnown(inner);
      overlay.push(
        <span key={k++} className={known ? 'rounded-sm bg-primary/25 text-primary-text' : 'rounded-sm bg-red-500/20 text-red-400'}>
          <span className="opacity-0">[</span>{inner}<span className="opacity-0">]</span>
        </span>,
      );
      i = close + 1;
    }
  }

  const shared = 'w-full px-2.5 py-2 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words';
  const listId = `formula-suggestions-${useId()}`;

  return (
    <div>
      <div className="relative rounded border border-border bg-background focus-within:ring-1 focus-within:ring-primary">
        {!showCodes && (
          <div ref={overlayRef} aria-hidden className={`${shared} absolute inset-0 overflow-hidden pointer-events-none text-foreground`}>
            {overlay}
            {'​'}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          rows={rows}
          spellCheck={false}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          data-testid={testId}
          onChange={(e) => {
            caret.current = e.target.selectionStart ?? e.target.value.length;
            commit(e.target.value);
            setQuery(wordAtCaret(e.target.value, caret.current));
          }}
          onSelect={refreshQuery}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setQuery(null), 150)}
          onScroll={(e) => { if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop; }}
          className={`${shared} relative block bg-transparent resize-y focus:outline-none placeholder-muted-foreground/40 ${
            showCodes ? 'text-foreground' : 'text-transparent caret-foreground'
          }`}
        />
        {suggestions.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto rounded-md border border-border bg-card shadow-xl py-1"
          >
            {suggestions.map((s, idx) => (
              <li
                key={s.kind === 'channel' ? `c:${s.info.code}` : `f:${s.name}`}
                role="option"
                aria-selected={idx === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(s)}
                onMouseEnter={() => setActive(idx)}
                className={`px-2.5 py-1.5 cursor-pointer text-xs flex items-baseline gap-2 ${idx === active ? 'bg-primary/15' : ''}`}
              >
                {s.kind === 'channel' ? (
                  <>
                    <span className="text-foreground truncate">{labelIndex.labelOf(s.info.code)}</span>
                    {s.info.uncertain && <span className="text-amber-400" title="Meaning not certain">?</span>}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground shrink-0">
                      {s.info.code}{unitsOf?.(s.info.code) ? ` · ${unitsOf(s.info.code)}` : ''}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-mono text-primary-text shrink-0">{s.signature}</span>
                    <span className="text-muted-foreground truncate">{s.description}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {problem && (
        <p className="mt-1 text-xs text-red-400" data-testid={testId ? `${testId}-problem` : undefined}>
          {problem.message}
        </p>
      )}
    </div>
  );
});
