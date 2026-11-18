// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DerivedChannelDialog } from './DerivedChannelDialog';
import { makeChannel, makeSession } from '../test-fixtures';
import type { DerivedChannel } from '../lib/useXRKStore';

beforeEach(() => {
  // jsdom has no canvas; the mini preview chart skips drawing when getContext returns null.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const evSession = makeSession({
  channels: new Map([
    [1, makeChannel(1, 'Pack_Voltage', { fileSampleCount: 10, units: 'V' })],
    [2, makeChannel(2, 'Pack_Current', { fileSampleCount: 10, units: 'A' })],
    [3, makeChannel(3, 'FBrakePressure', { fileSampleCount: 10, units: 'bar' })],
    [4, makeChannel(4, 'RBrakePressCorr', { fileSampleCount: 10, units: 'bar' })],
    [5, makeChannel(5, 'GPS Speed', { fileSampleCount: 10, units: 'km/h' })],
    [6, makeChannel(6, 'Silent', { fileSampleCount: 0 })],
  ]),
});

const plainSession = makeSession({
  channels: new Map([
    [1, makeChannel(1, 'Spd1', { fileSampleCount: 10 })],
    [2, makeChannel(2, 'LatA', { fileSampleCount: 10 })],
  ]),
});

function renderDialog(overrides: Partial<Parameters<typeof DerivedChannelDialog>[0]> = {}) {
  const props = {
    session: evSession,
    onClose: vi.fn(),
    onPreview: vi.fn(async () => ({ timestamps: [0, 1000, 2000], values: [1, 2, 3] })),
    onSubmit: vi.fn(async () => ({ id: 10000 }) as { id: number } | { error: string }),
    ...overrides,
  };
  render(<DerivedChannelDialog {...props} />);
  return props;
}

const nameInput = () => screen.getByTestId('input-derived-name') as HTMLInputElement;
const unitsInput = () => screen.getByTestId('input-derived-units') as HTMLInputElement;
const exprInput = () => screen.getByTestId('textarea-expression') as HTMLTextAreaElement;
const typeFormula = (text: string) => {
  fireEvent.change(exprInput(), { target: { value: text } });
  exprInput().setSelectionRange(text.length, text.length);
  fireEvent.select(exprInput());
};

describe('DerivedChannelDialog', () => {
  it('starts in create mode with Create disabled until name and formula are set', () => {
    renderDialog();
    expect(screen.getByText('Create Derived Channel')).toBeTruthy();
    const create = () => screen.getByTestId('btn-create-derived') as HTMLButtonElement;
    expect(create().disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: 'Mph' } });
    typeFormula('[GPS Speed] * 0.621371');
    expect(create().disabled).toBe(false);
  });

  describe('recipes', () => {
    it('shows battery recipes only when the log has battery channels', () => {
      renderDialog({ session: plainSession });
      expect(screen.queryByRole('button', { name: 'Battery power' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Convert units' })).toBeTruthy();
      cleanup();
      renderDialog();
      expect(screen.getByRole('button', { name: 'Battery power' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Air-fuel ratio' })).toBeNull();
    });

    it('fills the formula, name and units from a recipe', async () => {
      const props = renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Battery power' }));
      expect(exprInput().value).toBe('[Battery Voltage] * [Battery Current] / 1000');
      expect(nameInput().value).toBe('Battery Power');
      expect(unitsInput().value).toBe('kW');
      fireEvent.click(screen.getByTestId('btn-create-derived'));
      await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({
        name: 'Battery Power', units: 'kW', mode: 'formula', expression: 'Pack_Voltage * Pack_Current / 1000',
      }));
    });

    it('rewrites the formula when a recipe channel is changed', () => {
      renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Convert units' }));
      fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'GPS Speed' } });
      expect(exprInput().value).toBe('[GPS Speed] * 0.621371');
      expect(nameInput().value).toBe('GPS Speed (mph)');
      fireEvent.change(screen.getByLabelText('Conversion'), { target: { value: 'mph_kmh' } });
      expect(exprInput().value).toBe('[GPS Speed] * 1.609344');
      expect(nameInput().value).toBe('GPS Speed (km/h)');
    });

    it('keeps a name the user typed', () => {
      renderDialog();
      fireEvent.change(nameInput(), { target: { value: 'My Power' } });
      fireEvent.click(screen.getByRole('button', { name: 'Battery power' }));
      expect(nameInput().value).toBe('My Power');
    });

    it('detaches the recipe once the formula is edited by hand', () => {
      renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Brake balance' }));
      typeFormula(exprInput().value + ' + 1');
      expect((screen.getByLabelText('Front pressure') as HTMLSelectElement).disabled).toBe(true);
      fireEvent.click(screen.getByText('Start over from recipe'));
      expect(exprInput().value).toBe('[Front Brake Pressure] / max([Front Brake Pressure] + [Rear Brake Pressure], 2) * 100');
    });
  });

  it('lists only channels with file data, by plain name, and inserts at the caret', () => {
    renderDialog();
    fireEvent.click(screen.getByText(/Browse channels \(5\)/));
    const list = screen.getByTestId('channel-browser');
    expect(within(list).queryByText('Silent')).toBeNull();
    expect(within(list).getByText('Battery Voltage')).toBeTruthy();

    typeFormula(' * 2');
    exprInput().setSelectionRange(0, 0);
    fireEvent.select(exprInput());
    fireEvent.click(within(list).getByText('Battery Voltage'));
    expect(exprInput().value).toBe('[Battery Voltage] * 2');

    fireEvent.change(screen.getByTestId('input-channel-search'), { target: { value: 'brake' } });
    expect(within(list).queryByText('Battery Voltage')).toBeNull();
    expect(within(list).getByText('Front Brake Pressure')).toBeTruthy();
    fireEvent.change(screen.getByTestId('input-channel-search'), { target: { value: 'zzz' } });
    expect(within(list).getByText('No channels match "zzz"')).toBeTruthy();
  });

  it('lets the user rename a channel', () => {
    renderDialog();
    fireEvent.click(screen.getByText(/Browse channels/));
    fireEvent.click(screen.getByLabelText('Rename Battery Voltage'));
    const input = screen.getByTestId('input-rename-channel');
    fireEvent.change(input, { target: { value: 'HV Volts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(within(screen.getByTestId('channel-browser')).getByText('HV Volts')).toBeTruthy();
  });

  it('previews automatically without needing a name', async () => {
    const props = renderDialog();
    typeFormula('[GPS Speed] * 0.621371');
    expect(await screen.findByText('3 samples computed')).toBeTruthy();
    expect(props.onPreview).toHaveBeenCalledWith({ name: 'Preview', units: '', mode: 'formula', expression: '[GPS Speed] * 0.621371' });
  });

  it('does not preview a formula with a problem', async () => {
    vi.useFakeTimers();
    const props = renderDialog();
    typeFormula('[GPS Speed] *');
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(props.onPreview).not.toHaveBeenCalled();
    expect(screen.getByTestId('textarea-expression-problem').textContent).toBe("Missing something after the '*'");
  });

  it('shows preview errors', async () => {
    renderDialog({ onPreview: vi.fn(async () => 'Something went wrong') });
    typeFormula('[GPS Speed]');
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
  });

  it('shows "No preview data" for a single-sample result', async () => {
    renderDialog({ onPreview: vi.fn(async () => ({ timestamps: [0], values: [1] })) });
    typeFormula('1');
    expect(await screen.findByText('No preview data')).toBeTruthy();
  });

  describe('Python (advanced)', () => {
    it('is behind an Advanced link and loads the template on an empty formula', () => {
      renderDialog();
      fireEvent.click(screen.getByTestId('btn-mode-python'));
      expect(exprInput().value).toContain("result = {'timestamps'");
      expect(screen.getByText('Python Script')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Battery power' })).toBeNull();
      fireEvent.click(screen.getByTestId('btn-mode-formula'));
      expect(screen.getByRole('button', { name: 'Battery power' })).toBeTruthy();
    });

    it('keeps a typed formula when switching modes', () => {
      renderDialog({ session: plainSession });
      typeFormula('Spd1');
      fireEvent.click(screen.getByTestId('btn-mode-python'));
      expect(exprInput().value).toBe('Spd1');
    });

    it('previews Python with the manual button', async () => {
      const props = renderDialog();
      fireEvent.click(screen.getByTestId('btn-mode-python'));
      fireEvent.click(screen.getByTestId('btn-preview'));
      expect(await screen.findByText('3 samples computed')).toBeTruthy();
      expect(props.onPreview).toHaveBeenCalledWith(expect.objectContaining({ mode: 'python' }));
    });
  });

  it('creates the channel with raw codes and closes on success', async () => {
    const props = renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'Mph' } });
    typeFormula('[GPS Speed] * 0.621371');
    fireEvent.click(screen.getByTestId('btn-create-derived'));

    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(props.onSubmit).toHaveBeenCalledWith({ name: 'Mph', units: '', mode: 'formula', expression: '[GPS Speed] * 0.621371' });
  });

  it('shows submit errors and stays open', async () => {
    const props = renderDialog({ onSubmit: vi.fn(async () => ({ error: 'Division by zero' })) });
    fireEvent.change(nameInput(), { target: { value: 'X' } });
    typeFormula('1/0');
    fireEvent.click(screen.getByTestId('btn-create-derived'));

    expect(await screen.findByText('Division by zero')).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('opens an existing formula channel with friendly names', () => {
    const editing: DerivedChannel = { id: 10000, name: 'Bal', units: '%', mode: 'formula', expression: 'FBrakePressure - RBrakePressCorr', color: '#fff' };
    renderDialog({ editing });
    expect(exprInput().value).toBe('[Front Brake Pressure] - [Rear Brake Pressure]');
    fireEvent.click(screen.getByLabelText('Show codes'));
    expect(exprInput().value).toBe('FBrakePressure - RBrakePressCorr');
  });

  it('pre-fills fields when editing a Python channel', () => {
    const editing: DerivedChannel = { id: 10000, name: 'Py', units: 'kW', mode: 'python', expression: 'result = x', color: '#fff' };
    renderDialog({ editing });
    expect(screen.getByText('Edit Derived Channel')).toBeTruthy();
    expect(nameInput().value).toBe('Py');
    expect(exprInput().value).toBe('result = x');
    expect(screen.getByText('Update Channel')).toBeTruthy();
  });

  it('lists the user\'s other derived channels as usable channels', () => {
    const other: DerivedChannel = { id: 10001, name: 'MyPower', units: 'kW', mode: 'formula', expression: '1', color: '#fff' };
    renderDialog({ derivedChannels: [other] });
    fireEvent.click(screen.getByText(/Browse channels/));
    expect(within(screen.getByTestId('channel-browser')).getByText('MyPower')).toBeTruthy();
  });

  it('closes from Cancel and the backdrop only', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByText('Create Derived Channel'));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    const backdrop = document.querySelector('[data-backdrop]') as Element;
    fireEvent.click(backdrop);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
