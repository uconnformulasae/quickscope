import { useEffect, useRef } from 'react';
import type { XRKSession, ChannelSample } from '../../lib/xrk-parser';
import { lttbDownsample } from '../../lib/xrk-parser';
import type { ActiveChannel, DerivedChannel } from '../../lib/useXRKStore';
import { resolveChannel, resolveSamples, ensurePlotly } from './analysis-helpers';

export function XYPlotTab({ session, activeChannels, xChannelId, yChannelId, onChannelChange, derivedChannels, derivedSamplesMap }: {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  xChannelId: number | null;
  yChannelId: number | null;
  onChannelChange: (xId: number | null, yId: number | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
}) {
  const chartRef = useRef<HTMLDivElement>(null);

  const activeChannelIdsWithData = activeChannels
    .filter(ac => resolveSamples(ac.channelId, session, derivedSamplesMap).length > 0)
    .map(ac => ac.channelId);
  const hasValidX = xChannelId != null && activeChannelIdsWithData.includes(xChannelId);
  const effectiveXId = hasValidX ? xChannelId : activeChannelIdsWithData[0] ?? null;
  const hasValidY = yChannelId != null && activeChannelIdsWithData.includes(yChannelId);
  const fallbackY = activeChannelIdsWithData.find(id => id !== effectiveXId) ?? null;
  const effectiveYId = hasValidY ? yChannelId : fallbackY;
  const xChan = effectiveXId != null ? resolveChannel(effectiveXId, session, derivedChannels) : null;
  const yChan = effectiveYId != null ? resolveChannel(effectiveYId, session, derivedChannels) : null;
  const yAc = activeChannels.find(ac => ac.channelId === effectiveYId);

  useEffect(() => {
    if (!chartRef.current || !xChan || !yChan) return;

    const render = () => {
      const Plotly = (window as any).Plotly;
      if (!Plotly || !chartRef.current) return;

      const xSamplesRaw = resolveSamples(xChan.index, session, derivedSamplesMap);
      const ySamplesRaw = resolveSamples(yChan.index, session, derivedSamplesMap);
      if (xSamplesRaw.length === 0 || ySamplesRaw.length === 0) return;

      const xSamples = lttbDownsample(xSamplesRaw, 3000);
      const ySamples = ySamplesRaw;

      const xs: number[] = [];
      const ys: number[] = [];

      for (const xs_sample of xSamples) {
        const ts = xs_sample.timestamp;
        let lo = 0, hi = ySamples.length - 1;
        while (lo < hi - 1) {
          const mid = (lo + hi) >> 1;
          if (ySamples[mid].timestamp <= ts) lo = mid;
          else hi = mid;
        }
        if (lo < ySamples.length) {
          xs.push(xs_sample.value);
          ys.push(ySamples[lo].value);
        }
      }

      const trace = {
        type: 'scattergl',
        mode: 'markers',
        x: xs,
        y: ys,
        marker: { color: yAc?.color || '#4361ee', size: 3, opacity: 0.6 },
        hovertemplate: `${xChan.shortName}: %{x:.2f}<br>${yChan.shortName}: %{y:.2f}<extra></extra>`,
      };

      const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        xaxis: {
          title: `${xChan.shortName}${xChan.units ? ` (${xChan.units})` : ''}`,
          tickfont: { size: 10, color: '#8b93a8', family: 'JetBrains Mono' },
          gridcolor: 'rgba(255,255,255,0.05)',
          zeroline: false,
        },
        yaxis: {
          title: `${yChan.shortName}${yChan.units ? ` (${yChan.units})` : ''}`,
          tickfont: { size: 10, color: '#8b93a8', family: 'JetBrains Mono' },
          gridcolor: 'rgba(255,255,255,0.05)',
          zeroline: false,
        },
        margin: { l: 50, r: 15, t: 15, b: 50 },
        font: { family: 'DM Sans', color: '#8b93a8', size: 11 },
      };

      Plotly.react(chartRef.current, [trace], layout, {
        responsive: true, displayModeBar: false, displaylogo: false,
      });
    };

    ensurePlotly(render);
  }, [session, xChan, yChan, yAc]);

  const chanOptions = activeChannels.map(ac => {
    const c = resolveChannel(ac.channelId, session, derivedChannels);
    const count = resolveSamples(ac.channelId, session, derivedSamplesMap).length;
    if (!c) return null;
    return { id: ac.channelId, label: `${c.shortName}${c.units ? ` (${c.units})` : ''}${count === 0 ? ' \u2014 no data' : ''}`, disabled: count === 0 };
  }).filter(Boolean) as { id: number; label: string; disabled: boolean }[];

  const xHasData = effectiveXId != null ? resolveSamples(effectiveXId, session, derivedSamplesMap).length > 0 : false;
  const yHasData = effectiveYId != null ? resolveSamples(effectiveYId, session, derivedSamplesMap).length > 0 : false;

  return (
    <div className="p-2 flex flex-col gap-2 h-full">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">X Axis</label>
          <select
            value={effectiveXId ?? ''}
            onChange={e => onChannelChange(e.target.value ? Number(e.target.value) : null, effectiveYId)}
            className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Select...</option>
            {chanOptions.map(c => <option key={c.id} value={c.id} disabled={c.disabled}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Y Axis</label>
          <select
            value={effectiveYId ?? ''}
            onChange={e => onChannelChange(effectiveXId, e.target.value ? Number(e.target.value) : null)}
            className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Select...</option>
            {chanOptions.map(c => <option key={c.id} value={c.id} disabled={c.disabled}>{c.label}</option>)}
          </select>
        </div>
      </div>

      {xChan && yChan && (!xHasData || !yHasData) ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground/50 text-xs italic">
          {!xHasData && !yHasData
            ? `No data for ${xChan.shortName} or ${yChan.shortName}`
            : !xHasData
            ? `No data for X channel: ${xChan.shortName}`
            : `No data for Y channel: ${yChan.shortName}`}
        </div>
      ) : (
        <div ref={chartRef} className="flex-1 min-h-0" style={{ minHeight: '280px' }} />
      )}

      {(!xChan || !yChan) && (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
          Select two channels to compare
        </div>
      )}
    </div>
  );
}
