import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Search, X, FlaskConical, Pencil, Trash2, RotateCcw } from 'lucide-react';
import type { XRKSession, ChannelDef } from '../lib/xrk-parser';
import type { ActiveChannel, DerivedChannel, ChartMode } from '../lib/useXRKStore';
import { usePreferences } from '../lib/usePreferences';
import { convertibleUnits, resolveDisplayUnit } from '../lib/units';
import { effectiveChannelColor, type Theme } from '../lib/channelColors';
import { ChannelColorPicker } from './ChannelColorPicker';
import { Presence } from '../lib/motion';

/** Length of the Reset exit choreography (see .qs-resetting in index.css). */
const RESET_EXIT_MS = 320;
/** Chips after this many share the last stagger slot, so long lists don't drag. */
const MAX_STAGGERED_CHIPS = 6;

interface ChannelSidebarProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  derivedChannels: DerivedChannel[];
  derivedSamplesMap: Map<number, { timestamp: number; value: number }[]>;
  onToggleChannel: (id: number, color: string) => void;
  /** Deselect every channel on the chart. Called only after the user confirms. */
  onClearChannels?: () => void;
  onRemoveDerived: (id: number) => void;
  onEditDerived: (dc: DerivedChannel) => void;
  onCreateDerived: () => void;
  search: string;
  onSearchChange: (s: string) => void;
  showOnlyWithData: boolean;
  onShowOnlyWithDataChange: (v: boolean) => void;
  chartMode: ChartMode;
  onChartModeChange: (mode: ChartMode) => void;
  /** Current theme: custom channel colours are stored per theme. */
  theme?: Theme;
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
  onClearChannels,
  onRemoveDerived,
  onEditDerived,
  onCreateDerived,
  search,
  onSearchChange,
  showOnlyWithData,
  onShowOnlyWithDataChange,
  chartMode,
  onChartModeChange,
  theme = 'dark',
}: ChannelSidebarProps) {
  const { prefs, update } = usePreferences();
  const [colorFor, setColorFor] = useState<string | null>(null); // channel name whose picker is open
  const colorOf = (name: string, base: string) => effectiveChannelColor(name, base, theme, prefs.channelColors);
  const setChannelColor = (name: string, hex: string | null) => {
    const forTheme = { ...prefs.channelColors[theme] };
    if (hex) forTheme[name] = hex; else delete forTheme[name];
    update({ channelColors: { ...prefs.channelColors, [theme]: forTheme } });
  };
  const picker = (name: string, base: string) => colorFor === name && (
    <ChannelColorPicker
      name={name}
      theme={theme}
      current={colorOf(name, base)}
      custom={prefs.channelColors[theme][name] !== undefined}
      onPick={hex => { setChannelColor(name, hex); setColorFor(null); }}
      onReset={() => { setChannelColor(name, null); setColorFor(null); }}
      onClose={() => setColorFor(null)}
    />
  );
  const setUnitOverride = (shortName: string, unit: string) => {
    const next = { ...prefs.unitOverrides };
    if (unit) next[shortName] = unit; else delete next[shortName];
    update({ unitOverrides: next });
  };
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

  // True from a confirmed Reset until channels are selected again: picks the
  // Reset exit choreography over the plain fade used when the last chip is
  // removed by hand (a frequent action that shouldn't carry extra motion).
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    if (totalActive > 0) setResetting(false);
  }, [totalActive]);

  const handleReset = () => {
    if (totalActive === 0 || !onClearChannels) return;
    const what = totalActive === 1 ? '1 selected channel' : `${totalActive} selected channels`;
    if (window.confirm(`Remove all ${what} from the chart?`)) {
      setResetting(true);
      // The chart clears now; the footer animates out from a snapshot.
      onClearChannels();
    }
  };

  return (
    <div className="flex flex-col h-full bg-card border-r border-border overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-2 py-2 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Channels</h2>

          <div className="flex items-center gap-2">
            <span className="text-xs text-primary-text font-medium tabular whitespace-nowrap">
              {totalActive} active
            </span>
            <button
              onClick={onCreateDerived}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/15 border border-primary/30 text-primary-text hover:bg-primary/25 transition-colors text-xs"
              title="Create derived channel"
              data-testid="btn-create-derived-open"
            >
              <FlaskConical className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Chart mode toggle */}
        <div className="flex gap-1 mb-2">
          <button
            onClick={() => onChartModeChange('separate')}
            className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              chartMode === 'separate'
                ? 'bg-primary/20 text-primary-text border border-primary/40'
                : 'text-muted-foreground border border-border hover:text-foreground hover:border-muted-foreground/40'
            }`}
          >
            Separate
          </button>
          <button
            onClick={() => onChartModeChange('overlay')}
            className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              chartMode === 'overlay'
                ? 'bg-primary/20 text-primary-text border border-primary/40'
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
                ? 'bg-primary/20 border-primary/40 text-primary-text'
                : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40'
            }`}
            data-testid="btn-has-data-toggle"
          >
            Has data
          </button>
          <span className="text-xs text-muted-foreground">
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
              <FlaskConical className="w-3 h-3 text-primary-text/70" />
              <span className="text-xs font-medium text-muted-foreground">Derived</span>
              <span className="text-xs text-muted-foreground">{filteredDerived.length}</span>
            </div>
            {filteredDerived.map(dc => {
              const isActive = activeSet.has(dc.id);
              const sampleCount = (derivedSamplesMap.get(dc.id) || []).length;
              return (
                <div key={dc.id}>
                  <DerivedChannelRow
                    dc={dc}
                    color={colorOf(dc.name, dc.color)}
                    isActive={isActive}
                    sampleCount={sampleCount}
                    onToggle={() => onToggleChannel(dc.id, dc.color)}
                    onColor={() => setColorFor(colorFor === dc.name ? null : dc.name)}
                    onEdit={() => onEditDerived(dc)}
                    onRemove={() => onRemoveDerived(dc.id)}
                  />
                  {picker(dc.name, dc.color)}
                </div>
              );
            })}
          </div>
        )}

        {/* Session channels */}
        {filteredChannels.map(chan => {
          const isActive = activeSet.has(chan.index);
          return (
            <div key={chan.index}>
              <ChannelRow
                chan={chan}
                color={colorOf(chan.shortName, chan.color)}
                isActive={isActive}
                onToggle={() => onToggleChannel(chan.index, chan.color)}
                onColor={() => setColorFor(colorFor === chan.shortName ? null : chan.shortName)}
              />
              {picker(chan.shortName, chan.color)}
            </div>
          );
        })}

        {filteredChannels.length === 0 && filteredDerived.length === 0 && (
          <div className="p-4 text-center text-muted-foreground text-xs">
            No channels match your search
          </div>
        )}
      </div>

      {/* Active channels quick view */}
      <div className={`qs-active-footer flex-shrink-0 ${resetting ? 'qs-resetting' : ''}`} data-testid="active-channels-footer">
      <Presence show={totalActive > 0} exitMs={resetting ? RESET_EXIT_MS : 150}>
        <div className="qs-collapse">
        <div className="min-h-0 overflow-hidden border-t border-border p-2">
          <div className="flex items-center justify-between mb-1.5 px-1">
            <p className="text-xs text-muted-foreground">Active channels</p>
            {onClearChannels && (
              <button
                type="button"
                onClick={handleReset}
                aria-label="Reset selected channels"
                title="Reset selected channels"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <RotateCcw className="qs-reset-icon w-3 h-3" />
                Reset
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {activeChannels.map((ac, i) => {
              // Check session channels first, then derived
              const sessionChan = session.channels.get(ac.channelId);
              const derivedChan = derivedChannels.find(d => d.id === ac.channelId);
              const label = sessionChan?.shortName ?? derivedChan?.name ?? `#${ac.channelId}`;
              const rawUnit = sessionChan?.units ?? derivedChan?.units ?? '';
              const unitOptions = convertibleUnits(rawUnit);
              return (
                <div
                  key={ac.channelId}
                  className="qs-chip flex items-center rounded-full text-xs border"
                  style={{
                    borderColor: ac.color + '60', background: ac.color + '20', color: ac.color,
                    '--i': Math.min(i, MAX_STAGGERED_CHIPS),
                  } as CSSProperties}
                >
                  <button
                    onClick={() => onToggleChannel(ac.channelId, ac.color)}
                    className="flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-full transition-colors hover:opacity-80"
                    title={`Remove ${label}`}
                  >
                    {derivedChan && <FlaskConical className="w-2.5 h-2.5" />}
                    {label}
                    <X className="w-2.5 h-2.5" />
                  </button>
                  {unitOptions.length > 0 && (
                    <select
                      aria-label={`${label} unit`}
                      value={prefs.unitOverrides[label] ?? ''}
                      onChange={e => setUnitOverride(label, e.target.value)}
                      className="mr-1 bg-transparent text-xs outline-none cursor-pointer"
                      style={{ color: ac.color }}
                    >
                      <option value="">{resolveDisplayUnit(label, rawUnit, { unitSystem: prefs.unitSystem, unitOverrides: {} })}</option>
                      {unitOptions.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        </div>
      </Presence>
      </div>
    </div>
  );
}

// ─── ChannelRow ────────────────────────────────────────────────────────────────

interface ChannelRowProps {
  chan: ChannelDef;
  /** Colour for the current theme (custom or default). */
  color: string;
  isActive: boolean;
  onToggle: () => void;
  onColor: () => void;
}

/** Colour swatch: filled when the channel is on; click to choose its colour. */
function ColorSwatch({ name, color, isActive, onClick }: { name: string; color: string; isActive: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onClick(); }}
      aria-label={`${name} colour`}
      title="Change colour"
      className="no-press w-3 h-3 rounded-sm flex-shrink-0 transition-all hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      style={{
        background: isActive ? color : 'transparent',
        border: `1.5px solid ${isActive ? color : `${color}99`}`,
      }}
    />
  );
}

function ChannelRow({ chan, color, isActive, onToggle, onColor }: ChannelRowProps) {
  // fileSampleCount comes from the backend's channel list, so it is known even
  // for channels whose samples haven't been lazy-loaded yet.
  const displayCount = chan.fileSampleCount ?? 0;
  const fileHasData = displayCount > 0;
  return (
    <div
      className={`
        flex items-center gap-2 w-full px-2 py-1
        hover:bg-muted/30 transition-colors group
        ${isActive ? 'bg-muted/20' : ''}
        ${!fileHasData ? 'opacity-50' : ''}
      `}
    >
      <ColorSwatch name={chan.shortName} color={color} isActive={isActive} onClick={onColor} />
      <button
        onClick={onToggle}
        className="no-press flex items-center gap-2 flex-1 min-w-0 text-left"
        data-testid={`channel-row-${chan.index}`}
        title={!fileHasData ? 'No data recorded for this channel in this session' : undefined}
      >
        {/* Name */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-medium truncate ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
              {chan.shortName}
            </span>
            {chan.units && (
              <span className="text-xs text-muted-foreground flex-shrink-0">{chan.units}</span>
            )}
          </div>
          {chan.longName && chan.longName !== chan.shortName && (
            <p className="text-xs text-muted-foreground truncate leading-tight">{chan.longName}</p>
          )}
        </div>

        {/* Data indicator */}
        <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
          {fileHasData ? (
            <span className="text-xs text-muted-foreground tabular">
              {formatSampleCount(displayCount)}
            </span>
          ) : (
            <span className="text-xs px-1 py-0.5 rounded bg-muted/60 text-muted-foreground leading-none">
              No data
            </span>
          )}
          {fileHasData && chan.sampleRateHz > 0 && (
            <span className="text-xs text-muted-foreground tabular">
              {chan.sampleRateHz}Hz
            </span>
          )}
        </div>
      </button>
    </div>
  );
}

// ─── DerivedChannelRow ────────────────────────────────────────────────────────

interface DerivedChannelRowProps {
  dc: DerivedChannel;
  color: string;
  onColor: () => void;
  isActive: boolean;
  sampleCount: number;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function DerivedChannelRow({ dc, color, isActive, sampleCount, onToggle, onColor, onEdit, onRemove }: DerivedChannelRowProps) {
  return (
    <div
      className={`
        flex items-center gap-2 w-full px-2 py-1 group
        hover:bg-muted/30 transition-colors
        ${isActive ? 'bg-muted/20' : ''}
      `}
      data-testid={`channel-row-derived-${dc.id}`}
    >
      <ColorSwatch name={dc.name} color={color} isActive={isActive} onClick={onColor} />
      <button
        onClick={onToggle}
        className="no-press flex items-center gap-2 flex-1 min-w-0 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <FlaskConical className="w-2.5 h-2.5 text-primary-text/60 flex-shrink-0" />
            <span className={`text-xs font-medium truncate ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
              {dc.name}
            </span>
            {dc.units && (
              <span className="text-xs text-muted-foreground flex-shrink-0">{dc.units}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground leading-tight">
            {sampleCount > 0 ? formatSampleCount(sampleCount) : 'No data'}
          </p>
        </div>
      </button>

      {/* Edit / delete — visible on hover (subtle on touch) */}
      <div className="flex items-center gap-0.5 opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={e => { e.stopPropagation(); onEdit(); }}
          className="p-1 rounded text-muted-foreground hover:text-primary-text transition-colors"
          title="Edit"
        >
          <Pencil className="w-3 h-3" />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className="p-1 rounded text-muted-foreground hover:text-red-500 dark:hover:text-red-400 transition-colors"
          title="Delete"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
