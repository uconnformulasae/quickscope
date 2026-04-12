import { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Clock } from 'lucide-react';
import type { XRKSession, ChannelSample } from '../lib/xrk-parser';
import type { ActiveChannel, DerivedChannel } from '../lib/useXRKStore';
import { buildTableData, findRowByTimestamp } from '../lib/table-data';
import { formatValue } from '../lib/chart-utils';

interface TableViewProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
}

const ROW_HEIGHT = 28;

export function TableView({
  session,
  activeChannels,
  derivedChannels,
  derivedSamplesMap,
}: TableViewProps) {
  const [searchValue, setSearchValue] = useState('');
  const parentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Build channel info for columns
  const columns = useMemo(() => {
    return activeChannels
      .filter(ac => ac.visible)
      .map(ac => {
        const isDerived = ac.channelId >= 10000;
        const channelDef = session.channels.get(ac.channelId);
        const derivedDef = derivedChannels?.find(dc => dc.id === ac.channelId);
        return {
          channelId: ac.channelId,
          name: isDerived ? (derivedDef?.name || `DC${ac.channelId}`) : (channelDef?.shortName || `Ch${ac.channelId}`),
          units: isDerived ? (derivedDef?.units || '') : (channelDef?.units || ''),
          color: ac.color,
        };
      });
  }, [activeChannels, session.channels, derivedChannels]);

  // Merge all samples maps
  const allSamplesMap = useMemo(() => {
    const merged = new Map<number, ChannelSample[]>();
    for (const [id, samples] of session.samples) {
      merged.set(id, samples);
    }
    if (derivedSamplesMap) {
      for (const [id, samples] of derivedSamplesMap) {
        merged.set(id, samples);
      }
    }
    return merged;
  }, [session.samples, derivedSamplesMap]);

  // Build table data
  const channelIds = useMemo(() => columns.map(c => c.channelId), [columns]);
  const rows = useMemo(() => buildTableData(channelIds, allSamplesMap), [channelIds, allSamplesMap]);

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Ctrl+G shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Search: jump to timestamp
  const handleSearch = useCallback(() => {
    const seconds = parseFloat(searchValue);
    if (isNaN(seconds)) return;
    const ms = seconds * 1000;
    const idx = findRowByTimestamp(rows, ms);
    virtualizer.scrollToIndex(idx, { align: 'center' });
  }, [searchValue, rows, virtualizer]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  if (columns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground/60">Select channels in the sidebar to view data</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Search bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card/50 flex-shrink-0">
        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
        <input
          ref={searchRef}
          type="text"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Go to time (s)..."
          className="w-36 px-2 py-1 bg-muted/30 border border-border/50 rounded text-xs text-foreground placeholder:text-muted-foreground/50 font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <span className="text-[10px] text-muted-foreground/40 font-mono">Ctrl+G</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {rows.length.toLocaleString()} rows
        </span>
      </div>

      {/* Table header */}
      <div className="flex border-b border-border bg-card flex-shrink-0 overflow-hidden">
        <div className="w-24 flex-shrink-0 px-3 py-2 text-[11px] font-semibold text-muted-foreground font-mono border-r border-border/30">
          Time (s)
        </div>
        {columns.map((col) => (
          <div
            key={col.channelId}
            className="flex-1 min-w-[100px] px-3 py-2 text-[11px] font-semibold text-muted-foreground font-mono border-r border-border/30 last:border-r-0 flex items-center gap-1.5 truncate"
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: col.color }}
            />
            {col.name}{col.units ? ` (${col.units})` : ''}
          </div>
        ))}
      </div>

      {/* Virtualized rows */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            const isEven = virtualRow.index % 2 === 0;
            return (
              <div
                key={virtualRow.index}
                className={`flex absolute w-full ${isEven ? 'bg-background' : 'bg-card/30'}`}
                style={{
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div className="w-24 flex-shrink-0 px-3 flex items-center text-[11px] text-muted-foreground font-mono border-r border-border/10">
                  {(row.timestamp / 1000).toFixed(3)}
                </div>
                {row.values.map((val, colIdx) => (
                  <div
                    key={colIdx}
                    className={`flex-1 min-w-[100px] px-3 flex items-center text-[11px] font-mono border-r border-border/10 last:border-r-0 ${
                      row.held[colIdx]
                        ? 'text-foreground/40'
                        : val === null
                          ? 'text-muted-foreground/30'
                          : 'text-foreground'
                    }`}
                  >
                    {val !== null ? formatValue(val) : '\u2014'}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
