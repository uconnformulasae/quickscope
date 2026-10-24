// @vitest-environment jsdom
import { fakeLayout, makeSession, ramp } from '../test/dom-setup';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TableView } from './TableView';

describe('TableView', () => {
  it('renders the visible rows of the active channels', () => {
    fakeLayout({ width: 800, height: 600 });
    const session = makeSession({ 1: { name: 'RPM', samples: ramp(5000) } });
    render(<TableView session={session} activeChannels={[{ channelId: 1, color: '#f00' }]} />);
    expect(screen.getByText('5,000 rows')).toBeTruthy();
    expect(screen.getByText('0.000')).toBeTruthy();   // first timestamp cell
    expect(screen.queryByText('49.990')).toBeNull();  // far off-screen row isn't rendered
  });

  it('survives the table shrinking under the virtualizer (session switch / channel toggle)', () => {
    fakeLayout({ width: 800, height: 600 });
    const big = makeSession({ 1: { name: 'RPM', samples: ramp(5000) } });
    const small = makeSession({ 1: { name: 'RPM', samples: ramp(3) } });
    const active = [{ channelId: 1, color: '#f00' }];
    const { rerender } = render(<TableView session={big} activeChannels={active} />);
    expect(() => rerender(<TableView session={small} activeChannels={active} />)).not.toThrow();
    expect(screen.getByText('3 rows')).toBeTruthy();
    expect(screen.getByText('0.020')).toBeTruthy();
  });

  it('shows the empty state with no channels', () => {
    render(<TableView session={makeSession({})} activeChannels={[]} />);
    expect(screen.getByText(/Select channels/)).toBeTruthy();
  });
});
