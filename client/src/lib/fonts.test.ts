import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { UI_FONT, MONO_FONT } from './fonts';
import { MONO_FONT as C } from './chart-utils';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.resolve(root, p), 'utf8');

describe('fonts', () => {
  it('uses the system font stacks', () => {
    expect(UI_FONT.startsWith('-apple-system, BlinkMacSystemFont, "SF Pro Text"')).toBe(true);
    expect(UI_FONT).toContain('"Segoe UI Variable Text"');
    expect(MONO_FONT.startsWith('ui-monospace, "SF Mono"')).toBe(true);
    expect(MONO_FONT).toContain('"Cascadia Mono"');
  });

  it('does not load web fonts', () => {
    expect(read('client/index.html')).not.toContain('fonts.googleapis');
    const css = read('client/src/index.css');
    expect(css).not.toContain('DM Sans');
    expect(css).not.toContain('JetBrains');
  });

  it('re-exports MONO_FONT from chart-utils', () => {
    expect(C).toBe(MONO_FONT);
  });
});
