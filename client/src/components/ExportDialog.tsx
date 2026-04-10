import { useState, useMemo, useCallback } from 'react';
import { X, Download, Search, CheckSquare, Square } from 'lucide-react';
import type { XRKSession, ChannelSample } from '../lib/xrk-parser';
import type { DerivedChannel } from '../lib/useXRKStore';
import { exportCSV } from '../lib/api';

interface ExportDialogProps {
  session: XRKSession;
  fileName: string | null;
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
  onClose: () => void;
}

interface ExportChannel {
  id: number;
  name: string;
  units: string;
  sampleCount: number;
  isDerived: boolean;
}

export function ExportDialog({
  session,
  fileName,
  derivedChannels,
  derivedSamplesMap,
  onClose,
}: ExportDialogProps) {
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => {
    // Default: select all channels with data
    const ids = new Set<number>();
    session.channels.forEach((ch) => {
      if ((session.samples.get(ch.index) || []).length > 0) {
        ids.add(ch.index);
      }
    });
    return ids;
  });
  const [isExporting, setIsExporting] = useState(false);

  // Build the full channel list (session + derived), only those with data
  const allChannels = useMemo<ExportChannel[]>(() => {
    const list: ExportChannel[] = [];

    session.channels.forEach((ch) => {
      const count = (session.samples.get(ch.index) || []).length;
      if (count === 0) return; // skip empty
      list.push({
        id: ch.index,
        name: ch.shortName,
        units: ch.units,
        sampleCount: count,
        isDerived: false,
      });
    });

    if (derivedChannels && derivedSamplesMap) {
      for (const dc of derivedChannels) {
        const count = (derivedSamplesMap.get(dc.id) || []).length;
        if (count === 0) continue;
        list.push({
          id: dc.id,
          name: dc.name,
          units: dc.units,
          sampleCount: count,
          isDerived: true,
        });
      }
    }

    // Sort alphabetically
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [session, derivedChannels, derivedSamplesMap]);

  const filteredChannels = useMemo(() => {
    if (!search) return allChannels;
    const q = search.toLowerCase();
    return allChannels.filter(c => c.name.toLowerCase().includes(q));
  }, [allChannels, search]);

  const selectedCount = selectedIds.size;
  const totalRows = useMemo(() => {
    // Estimate based on maximum sample count among selected channels
    let max = 0;
    for (const ch of allChannels) {
      if (selectedIds.has(ch.id)) {
        max = Math.max(max, ch.sampleCount);
      }
    }
    return max;
  }, [allChannels, selectedIds]);

  const toggleChannel = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredChannels.map(c => c.id)));
  }, [filteredChannels]);

  const deselectAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const c of filteredChannels) next.delete(c.id);
      return next;
    });
  }, [filteredChannels]);

  const handleExport = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setIsExporting(true);

    try {
      // Get selected channel names (only session channels for backend export)
      const selectedChannels = allChannels.filter(c => selectedIds.has(c.id) && !c.isDerived);
      const channelNames = selectedChannels.map(c => c.name);

      if (channelNames.length === 0) {
        setIsExporting(false);
        return;
      }

      // Call backend export endpoint
      const blob = await exportCSV(channelNames);
      const url = URL.createObjectURL(blob);
      const baseName = fileName ? fileName.replace(/\.xrk$/i, '') : 'export';
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}_export.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setIsExporting(false);
    }
  }, [selectedIds, allChannels, fileName, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col overflow-hidden"
        style={{ maxHeight: '80vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Export CSV</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search + Select All/None */}
        <div className="px-4 pt-3 pb-2 flex-shrink-0 space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Filter channels..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-muted/50 border border-border rounded-md text-xs text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={selectAll}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground border border-border hover:border-muted-foreground/40 transition-colors"
              >
                <CheckSquare className="w-3 h-3" />
                Select All
              </button>
              <button
                onClick={deselectAll}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground border border-border hover:border-muted-foreground/40 transition-colors"
              >
                <Square className="w-3 h-3" />
                Deselect All
              </button>
            </div>
            <span className="text-xs text-muted-foreground">
              {selectedCount} / {allChannels.length} selected
            </span>
          </div>
        </div>

        {/* Channel list */}
        <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-0.5 min-h-0">
          {filteredChannels.map(ch => {
            const isSelected = selectedIds.has(ch.id);
            return (
              <button
                key={ch.id}
                onClick={() => toggleChannel(ch.id)}
                className={`flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-left transition-colors hover:bg-muted/30 ${isSelected ? 'bg-muted/20' : ''}`}
              >
                <div className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-border'}`}>
                  {isSelected && (
                    <svg viewBox="0 0 10 8" fill="none" className="w-2.5 h-2 text-white">
                      <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className={`text-xs font-medium ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {ch.name}
                    {ch.units && <span className="ml-1 text-muted-foreground/50">{ch.units}</span>}
                    {ch.isDerived && <span className="ml-1.5 text-xs text-primary/60">derived</span>}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground/40 tabular flex-shrink-0">
                  {ch.sampleCount >= 1000 ? `${(ch.sampleCount / 1000).toFixed(0)}K` : ch.sampleCount}
                </span>
              </button>
            );
          })}
          {filteredChannels.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-xs">No channels match your filter</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border flex-shrink-0 bg-muted/10">
          <div className="text-xs text-muted-foreground">
            {totalRows > 0 ? (
              <>~{totalRows.toLocaleString()} rows</>
            ) : (
              'Select channels to export'
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors border border-border"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={selectedIds.size === 0 || isExporting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              {isExporting ? 'Exporting...' : `Export ${selectedCount > 0 ? selectedCount : ''} channels`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
