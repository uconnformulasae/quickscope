import { useEffect, useRef, useState } from 'react';
import type { XRKSession, ChannelSample } from '../../lib/xrk-parser';
import type { ActiveChannel, DerivedChannel } from '../../lib/useXRKStore';
import { resolveChannel, resolveSamples, ensurePlotly } from './analysis-helpers';

export function HistogramTab({ session, activeChannels, channelId, onChannelChange, derivedChannels, derivedSamplesMap }: {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  channelId: number | null;
  onChannelChange: (id: number | null) => void;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);

  const activeChannelIdsWithData = activeChannels
    .filter(ac => resolveSamples(ac.channelId, session, derivedSamplesMap).length > 0)
    .map(ac => ac.channelId);
  const hasValidSelectedChannel = channelId != null && activeChannelIdsWithData.includes(channelId);
  const effectiveChannelId = hasValidSelectedChannel ? channelId : activeChannelIdsWithData[0] ?? null;
  const chan = effectiveChannelId != null ? resolveChannel(effectiveChannelId, session, derivedChannels) : null;
  const activeChan = activeChannels.find(ac => ac.channelId === effectiveChannelId);

  const sampleCount = chan ? resolveSamples(chan.index, session, derivedSamplesMap).length : 0;
  const hasData = sampleCount > 0;

  useEffect(() => {
    if (!chartRef.current || !chan || !activeChan || !hasData) return;

    const render = () => {
      const Plotly = (window as any).Plotly;
      if (!Plotly || !chartRef.current) return;

      const samples = resolveSamples(chan.index, session, derivedSamplesMap);
      const values = samples.map(s => s.value);

      const trace = {
        type: 'histogram',
        x: values,
        nbinsx: 50,
        marker: { color: activeChan.color, opacity: 0.8, line: { width: 0 } },
        name: chan.shortName,
      };

      const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        xaxis: {
          title: `${chan.shortName}${chan.units ? ` (${chan.units})` : ''}`,
          tickfont: { size: 10, color: '#8b93a8', family: 'JetBrains Mono' },
          gridcolor: 'rgba(255,255,255,0.05)',
        },
        yaxis: {
          title: 'Count',
          tickfont: { size: 10, color: '#8b93a8', family: 'JetBrains Mono' },
          gridcolor: 'rgba(255,255,255,0.05)',
        },
        margin: { l: 45, r: 15, t: 15, b: 45 },
        bargap: 0.05,
        font: { family: 'DM Sans', color: '#8b93a8', size: 11 },
      };

      Plotly.react(chartRef.current, [trace], layout, {
        responsive: true, displayModeBar: false, displaylogo: false,
      });
      setIsReady(true);
    };

    ensurePlotly(render);
  }, [session, chan, activeChan]);

  return (
    <div className="p-2 flex flex-col gap-2 h-full">
      <select
        value={effectiveChannelId ?? ''}
        onChange={e => onChannelChange(e.target.value ? Number(e.target.value) : null)}
        className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="">Select channel...</option>
        {activeChannels.map(ac => {
          const c = resolveChannel(ac.channelId, session, derivedChannels);
          const count = resolveSamples(ac.channelId, session, derivedSamplesMap).length;
          if (!c) return null;
          return (
            <option key={ac.channelId} value={ac.channelId} disabled={count === 0}>
              {c.shortName}{c.units ? ` (${c.units})` : ''}{count === 0 ? ' — no data' : ''}
            </option>
          );
        })}
      </select>

      {chan && !hasData ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground/50 text-xs italic">
          No data recorded for {chan.shortName} in this session
        </div>
      ) : (
        <div ref={chartRef} className="flex-1 min-h-0" style={{ minHeight: '280px' }} />
      )}

      {!chan && (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
          Select an active channel to view distribution
        </div>
      )}
    </div>
  );
}
