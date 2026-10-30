import { useMemo } from 'react';
import { Search, X, FlaskConical, Pencil, Trash2, ChevronRight } from 'lucide-react';
import { IconButton } from './ui/Button';
import { groupChannelsByPrefix, useCollapsedGroups } from '../lib/channel-groups';
import type { XRKSession, ChannelDef } from '../lib/xrk-parser';
import type { ActiveChannel, DerivedChannel } from '../lib/useXRKStore';

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
}: ChannelSidebarProps) {
  const activeSet = useMemo(() => new Set(activeChannels.map(c => c.channelId)), [activeChannels]);
  const { isCollapsed, toggle } = useCollapsedGroups();

  const sortedChannels = useMemo(() => {
    return Array.from(session.channels.values()).sort((a, b) =>
      a.shortName.localeCompare(b.shortName)
    );
  }, [session.channels]);

  const filteredChannels = useMemo(() => {
    let channels = sortedChannels;
    if (search) {
      const q = search.toLowerCase();
      channels = channels.filter(c =>
        c.shortName.toLowerCase().includes(q) ||
        c.longName.toLowerCase().includes(q)
      );
    }
    // Use fileSampleCount (backend) so unloaded channels aren't hidden
    if (showOnlyWithData) {
      channels = channels.filter(c => (c.fileSampleCount ?? (session.samples.get(c.index) || []).length) > 0);
    }
    return channels;
  }, [sortedChannels, search, showOnlyWithData, session.samples]);

  const groups = useMemo(() => groupChannelsByPrefix(filteredChannels), [filteredChannels]);

  const filteredDerived = useMemo(() => {
    if (!search) return derivedChannels;
    const q = search.toLowerCase();
    return derivedChannels.filter(d => d.name.toLowerCase().includes(q));
  }, [derivedChannels, search]);

  const totalActive = activeChannels.length;

  return (
    <div className="flex flex-col h-full bg-card border-r border-separator overflow-hidden">
      <div className="flex-shrink-0 px-2 pt-2 pb-1.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder={`Filter ${session.channels.size} channels`}
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full h-7 pl-8 pr-8 bg-muted rounded-md text-[13px] text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="input-channel-search"
          />
          {search && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <button
          onClick={() => onShowOnlyWithDataChange(!showOnlyWithData)}
          aria-pressed={showOnlyWithData}
          className={`mt-1.5 h-6 px-2 rounded-md text-[12px] transition-colors ${
            showOnlyWithData
              ? 'bg-primary/15 text-primary dark:text-[#8aa0ff]'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          data-testid="btn-has-data-toggle"
        >
          Has data
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain pb-2">
        {totalActive > 0 && (
          <div>
            <div className="flex items-center justify-between pl-3 pr-2 h-7">
              <span className="text-[11px] font-semibold text-label-3">{`Active · ${totalActive}`}</span>
              <IconButton
                label="Create derived channel"
                onClick={onCreateDerived}
                data-testid="btn-create-derived-open"
              >
                <FlaskConical className="w-3.5 h-3.5" />
              </IconButton>
            </div>
            {activeChannels.map(ac => {
              const sessionChan = session.channels.get(ac.channelId);
              const derivedChan = derivedChannels.find(d => d.id === ac.channelId);
              const label = sessionChan?.shortName ?? derivedChan?.name ?? `#${ac.channelId}`;
              const units = sessionChan?.units ?? derivedChan?.units;
              return (
                <div
                  key={ac.channelId}
                  className="group mx-1 flex h-[26px] items-center gap-2 rounded-md px-2 hover:bg-muted"
                  data-testid={`active-row-${ac.channelId}`}
                >
                  <span className="h-[9px] w-[9px] flex-shrink-0 rounded-full" style={{ background: ac.color }} />
                  <span className="flex-1 truncate text-[13px] text-foreground">{label}</span>
                  {units && <span className="flex-shrink-0 text-[11px] text-label-3">{units}</span>}
                  <button
                    title="Remove"
                    aria-label={`Remove ${label}`}
                    onClick={e => { e.stopPropagation(); onToggleChannel(ac.channelId, ac.color); }}
                    className="flex-shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {totalActive === 0 && (
          <div className="flex justify-end px-2 h-7 items-center">
            <IconButton
              label="Create derived channel"
              onClick={onCreateDerived}
              data-testid="btn-create-derived-open"
            >
              <FlaskConical className="w-3.5 h-3.5" />
            </IconButton>
          </div>
        )}

        {filteredDerived.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 pl-3 pr-2 h-7">
              <span className="text-[11px] font-semibold text-label-3">Derived</span>
              <span className="text-[11px] text-label-3">{filteredDerived.length}</span>
            </div>
            {filteredDerived.map(dc => (
              <DerivedChannelRow
                key={dc.id}
                dc={dc}
                isActive={activeSet.has(dc.id)}
                sampleCount={(derivedSamplesMap.get(dc.id) || []).length}
                onToggle={() => onToggleChannel(dc.id, dc.color)}
                onEdit={() => onEditDerived(dc)}
                onRemove={() => onRemoveDerived(dc.id)}
              />
            ))}
          </div>
        )}

        {groups.map(group => {
          const expanded = search !== '' || !isCollapsed(group.name);
          return (
            <div key={group.name}>
              <button
                onClick={() => toggle(group.name)}
                aria-expanded={expanded}
                className="flex h-7 w-full items-center gap-1 pl-2 pr-3 text-left hover:bg-muted/50"
              >
                <ChevronRight className={`h-3 w-3 text-label-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                <span className="text-[11px] font-semibold text-label-3">{group.name}</span>
                <span className="text-[11px] text-label-3">{group.channels.length}</span>
              </button>
              {expanded && group.channels.map(chan => (
                <ChannelRow
                  key={chan.index}
                  chan={chan}
                  isActive={activeSet.has(chan.index)}
                  onToggle={() => onToggleChannel(chan.index, chan.color)}
                />
              ))}
            </div>
          );
        })}

        {filteredChannels.length === 0 && filteredDerived.length === 0 && (
          <div className="p-4 text-center text-muted-foreground text-xs">
            No channels match your search
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ChannelRow ────────────────────────────────────────────────────────────────

interface ChannelRowProps {
  chan: ChannelDef;
  isActive: boolean;
  onToggle: () => void;
}

function ChannelRow({ chan, isActive, onToggle }: ChannelRowProps) {
  // fileSampleCount comes from the backend's channel list, so it is known even
  // for channels whose samples haven't been lazy-loaded yet.
  const displayCount = chan.fileSampleCount ?? 0;
  const fileHasData = displayCount > 0;
  const title = fileHasData
    ? [
        chan.longName && chan.longName !== chan.shortName ? chan.longName : '',
        formatSampleCount(displayCount),
        chan.sampleRateHz > 0 ? `${chan.sampleRateHz} Hz` : '',
      ].filter(Boolean).join(' · ')
    : 'No data recorded for this channel in this session';
  return (
    <button
      onClick={onToggle}
      className={`mx-1 flex h-[26px] w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-muted ${
        isActive ? 'bg-muted/60' : ''
      } ${!fileHasData ? 'opacity-50' : ''}`}
      data-testid={`channel-row-${chan.index}`}
      title={title}
    >
      <span
        className={`h-[9px] w-[9px] flex-shrink-0 rounded-full border ${isActive ? '' : 'border-label-4'}`}
        style={isActive ? { background: chan.color, borderColor: chan.color } : undefined}
      />
      <span className={`flex-1 truncate text-[13px] ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
        {chan.shortName}
      </span>
      {chan.units && <span className="flex-shrink-0 text-[11px] text-label-3">{chan.units}</span>}
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

      {/* Edit / delete — visible on hover (subtle on touch) */}
      <div className="flex items-center gap-0.5 opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity">
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
