// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetFormulaField } from './WidgetFormulaField';
import type { ChannelSources } from './ChannelPicker';

afterEach(cleanup);

const sources: ChannelSources = {
  live: ['Pack_Voltage'],
  seen: ['Pack_Current'],
  builtin: ['Pack_Voltage', 'FrBrakePressure', 'RPM'],
  units: { Pack_Voltage: 'V' },
  vehicleLabel: 'UConn-EV',
};

function Harness({ initial, onChange }: { initial?: string; onChange: (v: string | undefined) => void }) {
  const [v, setV] = useState(initial);
  return <WidgetFormulaField value={v} onChange={(x) => { setV(x); onChange(x); }} sources={sources} />;
}

const box = () => screen.getByTestId('widget-formula') as HTMLTextAreaElement;

describe('WidgetFormulaField', () => {
  it('shows live channels by plain-English name', () => {
    render(<Harness initial="Pack_Voltage * Pack_Current / 1000" onChange={vi.fn()} />);
    expect(box().value).toBe('[Battery Voltage] * [Battery Current] / 1000');
  });

  it('labels RPM as the motor on the EV', () => {
    render(<Harness initial="RPM" onChange={vi.fn()} />);
    expect(box().value).toBe('[Motor RPM]');
  });

  it('saves raw codes, and clears the formula when emptied', () => {
    const onChange = vi.fn();
    render(<Harness initial="RPM" onChange={onChange} />);
    fireEvent.change(box(), { target: { value: '[Front Brake Pressure] * 2' } });
    expect(onChange).toHaveBeenLastCalledWith('FrBrakePressure * 2');
    fireEvent.change(box(), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
