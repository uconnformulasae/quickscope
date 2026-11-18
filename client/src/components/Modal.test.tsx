// @vitest-environment jsdom
import '../test/dom-setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

describe('Modal', () => {
  it('closes on Escape and on a click on the scrim', () => {
    const onClose = vi.fn();
    const { container } = render(<Modal onClose={onClose}><p>body</p></Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    const scrim = container.firstChild as Element;
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('stays open when a drag that started inside ends on the scrim', () => {
    const onClose = vi.fn();
    const { container } = render(<Modal onClose={onClose}><input data-testid="field" /></Modal>);
    fireEvent.mouseDown(screen.getByTestId('field'));
    fireEvent.click(container.firstChild as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('can leave Escape alone, and passes other props to the panel', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} closeOnEscape={false} role="dialog" aria-label="Edit" className="w-10">x</Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    const panel = screen.getByRole('dialog', { name: 'Edit' });
    expect(panel.className).toContain('qs-dialog');
    expect(panel.className).toContain('w-10');
  });
});
