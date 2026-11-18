// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Presence, prefersReducedMotion } from './motion';

function stubMotion(reduce: boolean) {
  vi.stubEnv('MODE', 'development');
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: reduce, media: q, addEventListener() {}, removeEventListener() {},
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('prefersReducedMotion', () => {
  it('returns true in test mode', () => {
    expect(prefersReducedMotion()).toBe(true);
  });

  it('honors the media query', () => {
    stubMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    stubMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('Presence', () => {
  it('keeps children mounted for exitMs after show turns false', () => {
    stubMotion(false);
    vi.useFakeTimers();
    const { rerender } = render(<Presence show><p>Hi</p></Presence>);
    rerender(<Presence show={false}><p>Hi</p></Presence>);
    const wrapper = screen.getByText('Hi').parentElement!;
    expect(wrapper.getAttribute('data-presence')).toBe('closing');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    act(() => { vi.advanceTimersByTime(149); });
    expect(screen.queryByText('Hi')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Hi')).toBeNull();
  });

  it('renders the last children while closing', () => {
    stubMotion(false);
    vi.useFakeTimers();
    const { rerender } = render(<Presence show><p>Hi</p></Presence>);
    rerender(<Presence show={false}>{null}</Presence>);
    expect(screen.getByText('Hi')).toBeTruthy();
  });

  it('reopens mid-exit with one copy', () => {
    stubMotion(false);
    vi.useFakeTimers();
    const { rerender } = render(<Presence show><p>Hi</p></Presence>);
    rerender(<Presence show={false}><p>Hi</p></Presence>);
    act(() => { vi.advanceTimersByTime(50); });
    rerender(<Presence show><p>Hi2</p></Presence>);
    const all = screen.getAllByText(/Hi/);
    expect(all).toHaveLength(1);
    expect(all[0].textContent).toBe('Hi2');
    expect(all[0].parentElement!.getAttribute('data-presence')).toBe('open');
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByText('Hi2')).not.toBeNull();
  });

  it('unmounts immediately when reduced motion', () => {
    stubMotion(true);
    const { rerender } = render(<Presence show><p>Hi</p></Presence>);
    rerender(<Presence show={false}><p>Hi</p></Presence>);
    expect(screen.queryByText('Hi')).toBeNull();
  });

  it('renders nothing when never shown', () => {
    const { container } = render(<Presence show={false}><p>Hi</p></Presence>);
    expect(container.innerHTML).toBe('');
  });
});

describe('Presence (review fixes)', () => {
  it('makes the closing copy inert so keyboard focus and activation are blocked', () => {
    stubMotion(false);
    vi.useFakeTimers();
    const { rerender } = render(<Presence show><button>Go</button></Presence>);
    rerender(<Presence show={false}><button>Go</button></Presence>);
    const wrapper = screen.getByText('Go').parentElement!;
    expect(wrapper.hasAttribute('inert')).toBe(true);
  });

  it('remounts children when reopened mid-exit, so mount-time state resets', async () => {
    stubMotion(false);
    vi.useFakeTimers();
    const { useState } = await import('react');
    function Form({ initial }: { initial: string }) {
      const [v] = useState(initial); // like DerivedChannelDialog: seeded on mount only
      return <p>{v}</p>;
    }
    const { rerender } = render(<Presence show><Form initial="A" /></Presence>);
    rerender(<Presence show={false}><Form initial="A" /></Presence>);
    act(() => { vi.advanceTimersByTime(50); });
    rerender(<Presence show><Form initial="B" /></Presence>);
    expect(screen.getByText('B')).toBeTruthy();
  });
});
