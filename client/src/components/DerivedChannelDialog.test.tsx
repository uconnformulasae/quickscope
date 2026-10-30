// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});

const session = makeSession({
  channels: new Map([
    [1, makeChannel(1, 'Spd1', { fileSampleCount: 10 })],
    [2, makeChannel(2, 'LatA', { fileSampleCount: 10 })],
    [3, makeChannel(3, 'Silent', { fileSampleCount: 0 })],
  ]),
});

function renderDialog(overrides: Partial<Parameters<typeof DerivedChannelDialog>[0]> = {}) {
  const props = {
    session,
    onClose: vi.fn(),
    onPreview: vi.fn(async () => ({ timestamps: [0, 1000, 2000], values: [1, 2, 3] })),
    onSubmit: vi.fn(async () => ({ id: 10000 }) as { id: number } | { error: string }),
    ...overrides,
  };
  render(<DerivedChannelDialog {...props} />);
  return props;
}

const nameInput = () => screen.getByTestId('input-derived-name');
const exprInput = () => screen.getByTestId('textarea-expression') as HTMLTextAreaElement;

describe('DerivedChannelDialog', () => {
  it('starts in create mode with actions disabled until name and expression are set', () => {
    renderDialog();
    expect(screen.getByText('Create Derived Channel')).toBeTruthy();
    expect((screen.getByTestId('btn-preview') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('btn-create-derived') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(nameInput(), { target: { value: 'Mph' } });
    fireEvent.change(exprInput(), { target: { value: 'Spd1 * 0.621371' } });
    expect((screen.getByTestId('btn-preview') as HTMLButtonElement).disabled).toBe(false);
  });

  it('fills the expression from an example', () => {
    renderDialog();
    fireEvent.click(screen.getByText('Total G'));
    expect(exprInput().value).toBe('sqrt(InlA^2 + LatA^2)');
  });

  it('lists only channels with file data and inserts them into the expression', () => {
    renderDialog();
    fireEvent.click(screen.getByText(/Available channels \(2\)/));
    expect(screen.queryByText('Silent')).toBeNull();

    fireEvent.click(screen.getByText('Spd1'));
    fireEvent.click(screen.getByText('LatA'));
    expect(exprInput().value).toBe('Spd1 LatA');

    fireEvent.change(screen.getByTestId('input-channel-search'), { target: { value: 'lat' } });
    expect(screen.getByText(/Available channels \(1\/2\)/)).toBeTruthy();
    expect(screen.queryByText('Spd1')).toBeNull();

    fireEvent.change(screen.getByTestId('input-channel-search'), { target: { value: 'zzz' } });
    expect(screen.getByText('No channels match "zzz"')).toBeTruthy();
  });

  it('previews a formula and shows the sample count', async () => {
    const props = renderDialog();
    fireEvent.change(nameInput(), { target: { value: ' Mph ' } });
    fireEvent.change(screen.getByTestId('input-derived-units'), { target: { value: 'mph' } });
    fireEvent.change(exprInput(), { target: { value: 'Spd1 * 0.621371' } });
    fireEvent.click(screen.getByTestId('btn-preview'));

    expect(await screen.findByText('3 samples computed')).toBeTruthy();
    expect(props.onPreview).toHaveBeenCalledWith({ name: 'Mph', units: 'mph', mode: 'formula', expression: 'Spd1 * 0.621371' });
  });

  it('shows preview errors', async () => {
    renderDialog({ onPreview: vi.fn(async () => 'Unknown channel: Nope') });
    fireEvent.change(nameInput(), { target: { value: 'X' } });
    fireEvent.change(exprInput(), { target: { value: 'Nope' } });
    fireEvent.click(screen.getByTestId('btn-preview'));
    expect(await screen.findByText('Unknown channel: Nope')).toBeTruthy();
  });

  it('shows "No preview data" for a single-sample result', async () => {
    renderDialog({ onPreview: vi.fn(async () => ({ timestamps: [0], values: [1] })) });
    fireEvent.change(nameInput(), { target: { value: 'X' } });
    fireEvent.change(exprInput(), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('btn-preview'));
    expect(await screen.findByText('No preview data')).toBeTruthy();
  });

  it('switching to Python on an empty expression loads the template', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('btn-mode-python'));
    expect(exprInput().value).toContain("result = {'timestamps'");
    expect(screen.getByText('Python Script')).toBeTruthy();
    expect(screen.queryByText('Total G')).toBeNull();
  });

  it('keeps a typed expression when switching modes', () => {
    renderDialog();
    fireEvent.change(exprInput(), { target: { value: 'Spd1' } });
    fireEvent.click(screen.getByTestId('btn-mode-python'));
    expect(exprInput().value).toBe('Spd1');
  });

  it('creates the channel and closes on success', async () => {
    const props = renderDialog();
    fireEvent.change(nameInput(), { target: { value: 'Mph' } });
    fireEvent.change(exprInput(), { target: { value: 'Spd1 * 0.621371' } });
    fireEvent.click(screen.getByTestId('btn-create-derived'));

    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(props.onSubmit).toHaveBeenCalledWith({ name: 'Mph', units: '', mode: 'formula', expression: 'Spd1 * 0.621371' });
  });

  it('shows submit errors and stays open', async () => {
    const props = renderDialog({ onSubmit: vi.fn(async () => ({ error: 'Division by zero' })) });
    fireEvent.change(nameInput(), { target: { value: 'X' } });
    fireEvent.change(exprInput(), { target: { value: '1/0' } });
    fireEvent.click(screen.getByTestId('btn-create-derived'));

    expect(await screen.findByText('Division by zero')).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('pre-fills fields when editing', () => {
    const editing: DerivedChannel = { id: 10000, name: 'Py', units: 'kW', mode: 'python', expression: 'result = x', color: '#fff' };
    renderDialog({ editing });
    expect(screen.getByText('Edit Derived Channel')).toBeTruthy();
    expect((nameInput() as HTMLInputElement).value).toBe('Py');
    expect(exprInput().value).toBe('result = x');
    expect(screen.getByText('Update Channel')).toBeTruthy();
  });

  it('closes from Cancel and the backdrop only', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByText('Create Derived Channel'));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    const backdrop = screen.getByRole('dialog').parentElement as Element;
    fireEvent.mouseDown(backdrop);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
