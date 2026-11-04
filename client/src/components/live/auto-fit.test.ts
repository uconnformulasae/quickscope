// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fittedGrid, rowsForHeight } from './auto-fit';
import { CLICKABLE } from './widgets';
import { gridStyle } from './WidgetRenderer';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { Panel } from './widgets';

describe('rowsForHeight', () => {
  // rows of 24 px with 12 px gaps: h rows span h*24 + (h-1)*12 px
  it('returns the fewest grid rows that fit the height', () => {
    expect(rowsForHeight(24, 24, 12)).toBe(1);
    expect(rowsForHeight(60, 24, 12)).toBe(2);
    expect(rowsForHeight(61, 24, 12)).toBe(3);
  });
});

describe('fittedGrid', () => {
  const grid = [{ i: 'a', x: 0, y: 0, w: 6, h: 4 }, { i: 'b', x: 6, y: 0, w: 6, h: 4 }];

  it('grows a widget whose content needs more rows, never shrinks below the saved size', () => {
    const out = fittedGrid(grid, { a: 7, b: 2 }, false);
    expect(out[0].h).toBe(7);
    expect(out[1].h).toBe(4);
  });

  it('uses the saved layout exactly while editing', () => {
    expect(fittedGrid(grid, { a: 7 }, true)).toBe(grid);
  });
});

describe('tile sizing', () => {
  it('never lets a tile be wider than its panel', () => {
    expect(String(gridStyle(4, 140).gridTemplateColumns)).toContain('min(100%');
    expect(String(gridStyle(undefined, 140).gridTemplateColumns)).toContain('min(100%');
  });

  it('draws the click highlight inside the tile so panels cannot clip it', () => {
    expect(CLICKABLE).toContain('ring-inset');
  });
});

describe('Panel content measuring', () => {
  it('marks normal panels for measuring and leaves fill-the-panel widgets out', () => {
    const { container, rerender } = render(createElement(Panel, { title: 'T' }, 'x'));
    expect(container.querySelector('[data-panel-content]')).not.toBeNull();
    rerender(createElement(Panel, { title: 'T', fill: true }, 'x'));
    expect(container.querySelector('[data-panel-content]')).toBeNull();
  });
});
