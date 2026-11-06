// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeChannel } from '../../lib/channel-dictionary';
import { buildLabelIndex } from '../../lib/formula-text';
import { FormulaInput, type FormulaInputHandle } from './FormulaInput';

afterEach(cleanup);

const codes = ['FBrakePressure', 'RBrakePressCorr', 'Pack_Voltage', 'GPS Speed'];
const channels = codes.map(c => describeChannel(c, 'ev'));
const labelIndex = buildLabelIndex(codes, c => describeChannel(c, 'ev'));

function Harness({ initial = '', onChange = vi.fn(), showCodes = false, handle }: {
  initial?: string; onChange?: (s: string) => void; showCodes?: boolean; handle?: React.Ref<FormulaInputHandle>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <FormulaInput
      ref={handle}
      value={value}
      onChange={(s) => { setValue(s); onChange(s); }}
      channels={channels}
      labelIndex={labelIndex}
      showCodes={showCodes}
      testId="formula"
    />
  );
}

const box = () => screen.getByTestId('formula') as HTMLTextAreaElement;
const type = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  box().setSelectionRange(text.length, text.length);
  fireEvent.select(box());
};

describe('FormulaInput', () => {
  it('shows channels by their plain-English names', () => {
    render(<Harness initial="FBrakePressure - RBrakePressCorr" />);
    expect(box().value).toBe('[Front Brake Pressure] - [Rear Brake Pressure]');
  });

  it('shows raw codes when asked', () => {
    render(<Harness initial="FBrakePressure - RBrakePressCorr" showCodes />);
    expect(box().value).toBe('FBrakePressure - RBrakePressCorr');
  });

  it('suggests channels by any word and inserts the picked one', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type('brake');
    expect(screen.getByRole('option', { name: /Front Brake Pressure/ })).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('[Front Brake Pressure]');
    expect(onChange).toHaveBeenLastCalledWith('FBrakePressure');
  });

  it('finds channels by description and category too', () => {
    render(<Harness />);
    type('battery');
    expect(screen.getByRole('option', { name: /Battery Voltage/ })).toBeTruthy();
  });

  it('suggests functions with their plain description', () => {
    render(<Harness />);
    type('mav');
    const opt = screen.getByRole('option', { name: /mavg/ });
    expect(opt.textContent).toContain('Moving average');
    fireEvent.click(opt);
    expect(box().value).toBe('mavg(');
  });

  it('closes suggestions with Escape', () => {
    render(<Harness />);
    type('brake');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('deletes a whole channel name with one Backspace', () => {
    const onChange = vi.fn();
    render(<Harness initial="Pack_Voltage * FBrakePressure" onChange={onChange} />);
    const end = box().value.length;
    box().setSelectionRange(end, end);
    fireEvent.keyDown(box(), { key: 'Backspace' });
    expect(box().value).toBe('[Battery Voltage] * ');
    expect(onChange).toHaveBeenLastCalledWith('Pack_Voltage * ');
  });

  it('explains problems in plain language', () => {
    render(<Harness initial="Pack_Voltage FBrakePressure" />);
    expect(screen.getByTestId('formula-problem').textContent)
      .toBe('Add an operator (+ − × ÷) between [Battery Voltage] and [Front Brake Pressure]');
  });

  it('says nothing while the formula is empty', () => {
    render(<Harness />);
    expect(screen.queryByTestId('formula-problem')).toBeNull();
  });

  it('inserts a channel at the caret', () => {
    const handle = createRef<FormulaInputHandle>();
    const onChange = vi.fn();
    render(<Harness initial="Pack_Voltage * 2" onChange={onChange} handle={handle} />);
    box().setSelectionRange(0, 0);
    fireEvent.select(box());
    handle.current!.insertChannel('GPS Speed');
    expect(onChange).toHaveBeenLastCalledWith('[GPS Speed]Pack_Voltage * 2');
  });
});
