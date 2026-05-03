import { useMemo } from 'react';
import { Search, X, Plus, FlaskConical, Pencil, Trash2 } from 'lucide-react';
import type { XRKSession, ChannelDef } from '../lib/xrk-parser';
import type { ActiveChannel, DerivedChannel, ChartMode } from '../lib/useXRKStore';

interface ChannelSidebarProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  derivedChannels: DerivedChannel[];
  derivedSamplesMap: Map<number, { timestamp: number; value: number }[]>;
  onToggleChannel: (id: number, color: string) => void;
  onRemoveDerived: (id: number) => void;
  onEditDerived: (dc: DerivedChannel) => void;
  onCreateDerived: () => void;
  search: string;
  onSearchChange: (s: string) => void;
  showOnlyWithData: boolean;
  onShowOnlyWithDataChange: (v: boolean) => void;
  chartMode: ChartMode;
  onChartModeChange: (mode: ChartMode) => void;
}

function formatSampleCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M pts`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K pts`;
  if (count > 0) return `${count} pts`;
  return '';
}

export function ChannelSidebar({
  session,
  activeChannels,
  derivedChannels,
  derivedSamplesMap,
  onToggleChannel,
  onRemoveDerived,
  onEditDerived,
  onCreateDerived,
  search,
  onSearchChange,
  showOnlyWithData,
  onShowOnlyWithDataChange,
  chartMode,
  onChartModeChange,
}: ChannelSidebarProps) {
  const activeSet = useMemo(() => new Set(activeChannels.map(c => c.channelId)), [activeChannels]);

  // Sorted flat list of session channels
  const sortedChannels = useMemo(() => {
    return Array.from(session.channels.values()).sort((a, b) =>
      a.shortName.localeCompare(b.shortName)
    );
  }, [session.channels]);

  // Filtered list
  const filteredChannels = useMemo(() => {
    let channels = sortedChannels;

    // Search filter
    if (search) {
      const q = search.toLowerCase();
      channels = channels.filter(c =>
        c.shortName.toLowerCase().includes(q) ||
        c.longName.toLowerCase().includes(q)
      );
    }

    // Has data filter — use fileSampleCount (backend) so unloaded channels aren't hidden
    if (showOnlyWithData) {
      channels = channels.filter(c => (c.fileSampleCount ?? (session.samples.get(c.index) || []).length) > 0);
    }

    return channels;
  }, [sortedChannels, search, showOnlyWithData, session.samples]);

  // Filtered derived channels
  const filteredDerived = useMemo(() => {
    if (!search) return derivedChannels;
    const q = search.toLowerCase();
    return derivedChannels.filter(d => d.name.toLowerCase().includes(q));
  }, [derivedChannels, search]);

  const totalActive = activeChannels.length;

  return (
    <div className="flex flex-col h-full bg-card border-r border-border overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-2 py-2 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Channels</h2>

          <div className="flex items-center gap-2">
            <span className="text-xs text-primary font-medium tabular">
              {totalActive} active
            </span>
            <button
              onClick={onCreateDerived}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/15 border border-primary/30 text-primary hover:bg-primary/25 transition-colors text-xs"
              title="Create derived channel"
              data-testid="btn-create-derived-open"
            >
              <Plus className="w-3 h-3" />
              <FlaskConical className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Chart mode toggle */}
        <div className="flex gap-1 mb-2">
          <button
            onClick={() => onChartModeChange('separate')}
            className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              chartMode === 'separate'
                ? 'bg-primary/20 text-primary border border-primary/40'
                : 'text-muted-foreground border border-border hover:text-foreground hover:border-muted-foreground/40'
            }`}
          >
            Separate
          </button>
          <button
            onClick={() => onChartModeChange('overlay')}
            className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              chartMode === 'overlay'
                ? 'bg-primary/20 text-primary border border-primary/40'
                : 'text-muted-foreground border border-border hover:text-foreground hover:border-muted-foreground/40'
            }`}
          >
            Overlay
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search channels..."
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 bg-muted/50 border border-border rounded-md text-xs text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="input-channel-search"
          />
          {search && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Has data toggle */}
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => onShowOnlyWithDataChange(!showOnlyWithData)}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border transition-colors ${
              showOnlyWithData
                ? 'bg-primary/20 border-primary/40 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40'
            }`}
            data-testid="btn-has-data-toggle"
          >
            Has data
          </button>
          <span className="text-xs text-muted-foreground/50">
            {filteredChannels.length} channels
          </span>
        </div>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {/* Derived channels section */}
        {filteredDerived.length > 0 && (
          <div className="border-b border-border/50">
            <div className="px-3 py-1.5 flex items-center gap-1.5">
              <FlaskConical className="w-3 h-3 text-primary/70" />
              <span className="text-xs font-medium text-muted-foreground/70">Derived</span>
              <span className="text-xs text-muted-foreground/40">{filteredDerived.length}</span>
            </div>
            {filteredDerived.some(d => d.mode === 'python') && (
              <p className="px-3 pb-1 text-[10px] text-muted-foreground/70 italic">
                Python-mode derived channels are primary-only (overlays use formula-mode only).
              </p>
            )}
            {filteredDerived.map(dc => {
              const isActive = activeSet.has(dc.id);
              const sampleCount = (derivedSamplesMap.get(dc.id) || []).length;
              return (
                <DerivedChannelRow
                  key={dc.id}
                  dc={dc}
                  isActive={isActive}
                  sampleCount={sampleCount}
                  onToggle={() => onToggleChannel(dc.id, dc.color)}
                  onEdit={() => onEditDerived(dc)}
                  onRemove={() => onRemoveDerived(dc.id)}
                />
              );
            })}
          </div>
        )}

        {/* Session channels */}
        {filteredChannels.map(chan => {
          const isActive = activeSet.has(chan.index);
          const sampleCount = (session.samples.get(chan.index) || []).length;
          return (
            <ChannelRow
              key={chan.index}
              chan={chan}
              isActive={isActive}
              sampleCount={sampleCount}
              onToggle={() => onToggleChannel(chan.index, chan.color)}
            />
          );
        })}

        {filteredChannels.length === 0 && filteredDerived.length === 0 && (
          <div className="p-4 text-center text-muted-foreground text-xs">
            No channels match your search
          </div>
        )}
      </div>

      {/* Active channels quick view */}
      {totalActive > 0 && (
        <div className="flex-shrink-0 border-t border-border p-2">
          <p className="text-xs text-muted-foreground mb-1.5 px-1">Active channels</p>
          <div className="flex flex-wrap gap-1">
            {activeChannels.map(ac => {
              // Check session channels first, then derived
              const sessionChan = session.channels.get(ac.channelId);
              const derivedChan = derivedChannels.find(d => d.id === ac.channelId);
              const label = sessionChan?.shortName ?? derivedChan?.name ?? `#${ac.channelId}`;
              return (
                <button
                  key={ac.channelId}
                  onClick={() => onToggleChannel(ac.channelId, ac.color)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors hover:opacity-80"
                  style={{ borderColor: ac.color + '60', background: ac.color + '20', color: ac.color }}
                >
                  {derivedChan && <FlaskConical className="w-2.5 h-2.5" />}
                  {label}
                  <X className="w-2.5 h-2.5" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ChannelRow ────────────────────────────────────────────────────────────────

interface ChannelRowProps {
  chan: ChannelDef;
  isActive: boolean;
  sampleCount: number;
  onToggle: () => void;
}

function ChannelRow({ chan, isActive, sampleCount, onToggle }: ChannelRowProps) {
  // Use fileSampleCount (from backend) to determine if the file has data for this channel.
  // sampleCount is 0 for channels not yet lazy-loaded, even if the file has data.
  const fileHasData = (chan.fileSampleCount ?? sampleCount) > 0;
  const displayCount = chan.fileSampleCount ?? sampleCount;
  return (
    <button
      onClick={onToggle}
      className={`
        flex items-center gap-2 w-full px-2 py-1 text-left
        hover:bg-muted/30 transition-colors group
        ${isActive ? 'bg-muted/20' : ''}
        ${!fileHasData ? 'opacity-50' : ''}
      `}
      data-testid={`channel-row-${chan.index}`}
      title={!fileHasData ? 'No data recorded for this channel in this session' : undefined}
    >
      {/* Color swatch */}
      <div
        className="w-3 h-3 rounded-sm flex-shrink-0 transition-all"
        style={{
          background: isActive ? chan.color : 'transparent',
          border: `1.5px solid ${isActive ? chan.color : 'hsl(var(--border))'}`,
        }}
      />

      {/* Name */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-medium truncate ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
            {chan.shortName}
          </span>
          {chan.units && (
            <span className="text-xs text-muted-foreground/50 flex-shrink-0">{chan.units}</span>
          )}
        </div>
        {chan.longName && chan.longName !== chan.shortName && (
          <p className="text-xs text-muted-foreground/50 truncate leading-tight">{chan.longName}</p>
        )}
      </div>

      {/* Data indicator */}
      <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
        {fileHasData ? (
          <span className="text-xs text-muted-foreground/40 tabular">
            {formatSampleCount(displayCount)}
          </span>
        ) : (
          <span className="text-xs px-1 py-0.5 rounded bg-muted/60 text-muted-foreground/50 leading-none">
            No data
          </span>
        )}
        {fileHasData && chan.sampleRateHz > 0 && (
          <span className="text-xs text-muted-foreground/30 tabular">
            {chan.sampleRateHz}Hz
          </span>
        )}
      </div>
    </button>
  );
}

// ─── DerivedChannelRow ────────────────────────────────────────────────────────

interface DerivedChannelRowProps {
  dc: DerivedChannel;
  isActive: boolean;
  sampleCount: number;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function DerivedChannelRow({ dc, isActive, sampleCount, onToggle, onEdit, onRemove }: DerivedChannelRowProps) {
  return (
    <div
      className={`
        flex items-center gap-2 w-full px-2 py-1 group
        hover:bg-muted/30 transition-colors
        ${isActive ? 'bg-muted/20' : ''}
      `}
      data-testid={`channel-row-derived-${dc.id}`}
    >
      {/* Toggle / color swatch */}
      <button
        onClick={onToggle}
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
      >
        <div
          className="w-3 h-3 rounded-sm flex-shrink-0 transition-all"
          style={{
            background: isActive ? dc.color : 'transparent',
            border: `1.5px solid ${isActive ? dc.color : 'hsl(var(--border))'}`,
          }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <FlaskConical className="w-2.5 h-2.5 text-primary/60 flex-shrink-0" />
            <span className={`text-xs font-medium truncate ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
              {dc.name}
            </span>
            {dc.units && (
              <span className="text-xs text-muted-foreground/50 flex-shrink-0">{dc.units}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground/40 leading-tight">
            {sampleCount > 0 ? formatSampleCount(sampleCount) : 'No data'}
          </p>
        </div>
      </button>

      {/* Edit / delete — visible on hover */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={e => { e.stopPropagation(); onEdit(); }}
          className="p-1 rounded text-muted-foreground/60 hover:text-primary transition-colors"
          title="Edit"
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className="p-1 rounded text-muted-foreground/60 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          title="Delete"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
