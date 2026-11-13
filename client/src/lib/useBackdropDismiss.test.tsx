// @vitest-environment jsdom
import '../test/dom-setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBackdropDismiss } from './useBackdropDismiss';

function Dialog({ onClose }: { onClose: () => void }) {
  const backdrop = useBackdropDismiss(onClose);
  return (
    <div data-testid="backdrop" {...backdrop}>
      <input data-testid="field" defaultValue="Spd1 * 0.621371" />
    </div>
  );
}

describe('useBackdropDismiss', () => {
  it('closes on a click that starts and ends on the backdrop', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open when a text selection drag ends on the backdrop', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    // Press inside the field, release outside: the browser sends the click to
    // the common ancestor, which is the backdrop.
    fireEvent.mouseDown(screen.getByTestId('field'));
    fireEvent.click(screen.getByTestId('backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores clicks inside the dialog, and recovers for the next real click', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    const field = screen.getByTestId('field');
    fireEvent.mouseDown(field);
    fireEvent.click(field);
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
