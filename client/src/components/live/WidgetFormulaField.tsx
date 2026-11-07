/**
 * Formula field for a live-dashboard widget channel. Same readable editor as
 * the derived-channel dialog (plain-English names, suggestions, plain-language
 * problems) but no recipes or preview chart: live formulas are evaluated one
 * snapshot at a time against whatever the car is streaming.
 */
import { useMemo } from 'react';
import { describeChannel, inferCarType } from '../../lib/channel-dictionary';
import { buildLabelIndex } from '../../lib/formula-text';
import { usePreferences } from '../../lib/usePreferences';
import { FormulaInput } from '../formula/FormulaInput';
import type { ChannelSources } from './ChannelPicker';

export function WidgetFormulaField({ value, onChange, sources }: {
  value: string | undefined;
  onChange: (expr: string | undefined) => void;
  sources: ChannelSources;
}) {
  const { prefs } = usePreferences();
  const labels = prefs.channelLabels;
  const codes = useMemo(
    () => [...new Set([...sources.live, ...sources.seen, ...sources.builtin])],
    [sources.live, sources.seen, sources.builtin],
  );
  const car = useMemo(() => inferCarType(codes, sources.vehicleLabel), [codes, sources.vehicleLabel]);
  const channels = useMemo(() => codes.map(c => describeChannel(c, car, labels)), [codes, car, labels]);
  const labelIndex = useMemo(() => {
    const byCode = new Map(channels.map(c => [c.code, c]));
    return buildLabelIndex(codes, c => byCode.get(c)!);
  }, [codes, channels]);

  return (
    <FormulaInput
      value={value ?? ''}
      onChange={(s) => onChange(s.trim() ? s : undefined)}
      channels={channels}
      labelIndex={labelIndex}
      rows={1}
      unitsOf={(c) => sources.units[c] ?? ''}
      placeholder="e.g. type battery, brake, speed…"
      testId="widget-formula"
    />
  );
}
