// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { IconButton } from './Button';
import { SegmentedControl } from './SegmentedControl';
import { ContextMenu, Menu, MenuButton } from './Menu';
import { Sheet } from './Sheet';

afterEach(cleanup);

describe('SegmentedControl', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Gamma' },
  ];
  it('marks the value as checked and reports clicks', () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="a" options={options} onChange={onChange} ariaLabel="Pick" />);
    expect(screen.getByRole('radiogroup', { name: 'Pick' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Alpha' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Beta' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
  it('wraps ArrowRight from the last option to the first', () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="c" options={options} onChange={onChange} ariaLabel="Pick" />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Gamma' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('a');
  });
  it('moves back with ArrowLeft', () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="a" options={options} onChange={onChange} ariaLabel="Pick" />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('c');
  });
});

describe('IconButton', () => {
  it('sets aria-label, title and aria-pressed', () => {
    render(<IconButton label="Zoom" active>x</IconButton>);
    const b = screen.getByRole('button', { name: 'Zoom' });
    expect(b.getAttribute('title')).toBe('Zoom');
    expect(b.getAttribute('aria-pressed')).toBe('true');
  });
  it('omits aria-pressed when active is undefined', () => {
    render(<IconButton label="Zoom">x</IconButton>);
    expect(screen.getByRole('button').hasAttribute('aria-pressed')).toBe(false);
  });
});

describe('Menu', () => {
  it('calls onSelect then onClose', () => {
    const order: string[] = [];
    render(<Menu items={[{ label: 'One', onSelect: () => order.push('select') }]} onClose={() => order.push('close')} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'One' }));
    expect(order).toEqual(['select', 'close']);
  });
  it('ArrowDown + Enter selects the second item', () => {
    const a = vi.fn();
    const b = vi.fn();
    render(<Menu items={[{ label: 'A', onSelect: a }, { label: 'B', onSelect: b }]} onClose={() => {}} />);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(b).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });
  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<Menu items={[{ label: 'A', onSelect: () => {} }]} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
  it('renders separators and ignores disabled items', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Menu items={[{ label: 'A', onSelect, disabled: true }, 'separator', { label: 'B', onSelect: () => {} }]} onClose={onClose} />);
    expect(screen.getByRole('separator')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'A' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('closes on an outside mousedown', () => {
    const onClose = vi.fn();
    render(<Menu items={[{ label: 'A', onSelect: () => {} }]} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('MenuButton', () => {
  it('toggles the menu when the trigger is clicked', () => {
    render(<MenuButton label="More" icon={<span>i</span>} items={[{ label: 'A', onSelect: () => {} }]} />);
    const trigger = screen.getByRole('button', { name: 'More' });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ContextMenu', () => {
  it('clamps to the viewport', () => {
    render(<ContextMenu x={10000} y={10000} items={[{ label: 'A', onSelect: () => {} }]} onClose={() => {}} />);
    const menu = screen.getByRole('menu');
    expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(window.innerHeight);
  });
});

describe('Sheet', () => {
  it('has dialog role named by title and focuses inside', () => {
    render(<Sheet title="Settings" onClose={() => {}}><button>inner</button></Sheet>);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
  it('closes on Escape and backdrop, not on inside click', () => {
    const onClose = vi.fn();
    render(<Sheet title="T" onClose={onClose}><button>inner</button></Sheet>);
    fireEvent.click(screen.getByText('inner'));
    fireEvent.mouseDown(screen.getByText('inner'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog.parentElement!);
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('does not close on backdrop when closeOnBackdrop is false', () => {
    const onClose = vi.fn();
    render(<Sheet title="T" onClose={onClose} closeOnBackdrop={false}>x</Sheet>);
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog.parentElement!);
    fireEvent.click(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });
  it('renders a Close button that closes', () => {
    const onClose = vi.fn();
    render(<Sheet title="T" onClose={onClose}>x</Sheet>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
  it('wraps Tab from the last focusable to the first', () => {
    render(<Sheet title="T" footer={<button>last</button>}><button>first-body</button></Sheet>);
    screen.getByText('last').focus();
    fireEvent.keyDown(screen.getByText('last'), { key: 'Tab' });
    const dialog = screen.getByRole('dialog');
    const focusables = dialog.querySelectorAll('button');
    expect(document.activeElement).toBe(focusables[0]);
  });
  it('restores focus on unmount', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && <Sheet title="T" onClose={() => setOpen(false)}>x</Sheet>}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).not.toBe(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });
});
