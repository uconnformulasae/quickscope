import { useRef } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, ArrowLeft, Share } from 'lucide-react';
import type { XRKSession } from '../lib/xrk-parser';
import { sessionSubtitle } from '../lib/session-subtitle';
import { ThemeToggle } from './ThemeToggle';
import { IconButton } from './ui/Button';
import { SegmentedControl } from './ui/SegmentedControl';
import { MenuButton, type MenuEntry } from './ui/Menu';

interface SessionHeaderProps {
  session: XRKSession | null;
  fileName: string | null;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onFileSelected: (file: File) => void;
  onExportOpen?: () => void;
  onBack?: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  viewMode: 'chart' | 'table';
  onViewModeChange: (mode: 'chart' | 'table') => void;
  onSessionInfoOpen?: () => void;
}

export function SessionHeader({
  session,
  fileName,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onFileSelected,
  onExportOpen,
  onBack,
  theme,
  onToggleTheme,
  viewMode,
  onViewModeChange,
  onSessionInfoOpen,
}: SessionHeaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelected(file);
      // Reset so the same file can be re-selected
      e.target.value = '';
    }
  };

  const lapCount = session ? Math.max(0, session.lapMarkers.length - 1) : 0;
  const subtitle = session ? sessionSubtitle(session.metadata, session.durationMs, lapCount) : '';

  const items: MenuEntry[] = [{ label: 'Open…', onSelect: () => fileInputRef.current?.click() }];
  if (session && onExportOpen) items.push({ label: 'Export CSV…', onSelect: onExportOpen });
  if (session && onSessionInfoOpen) items.push({ label: 'Get Info', onSelect: onSessionInfoOpen });

  return (
    <header className="relative z-20 flex h-[52px] flex-shrink-0 items-center gap-1.5 border-b border-separator bg-card px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        {onBack && (
          <IconButton label="Back to sessions" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        )}
        <IconButton label={leftOpen ? 'Hide channels' : 'Show channels'} active={leftOpen} onClick={onToggleLeft}>
          {leftOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
        </IconButton>
        {session && fileName && (
          <button
            type="button"
            onClick={onSessionInfoOpen}
            className="ml-1 flex min-w-0 max-w-[40%] flex-col items-start rounded-md px-1.5 py-0.5 text-left hover:bg-muted"
          >
            <span className="max-w-full truncate font-display text-[13.5px] font-semibold text-foreground">{fileName}</span>
            {subtitle && <span className="max-w-full truncate text-[11.5px] text-muted-foreground">{subtitle}</span>}
          </button>
        )}
      </div>

      {session && (
        <div className="absolute left-1/2 -translate-x-1/2">
          <SegmentedControl
            ariaLabel="View"
            value={viewMode}
            onChange={onViewModeChange}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'table', label: 'Table' },
            ]}
          />
        </div>
      )}

      <div className="ml-auto flex flex-shrink-0 items-center gap-1">
        <MenuButton label="Export" icon={<Share className="h-4 w-4" />} items={items} align="right" />

        <input
          ref={fileInputRef}
          type="file"
          accept=".xrk,.xrz,.XRK,.XRZ"
          className="hidden"
          onChange={handleFileChange}
          data-testid="input-file-hidden"
        />

        <ThemeToggle theme={theme} onToggle={onToggleTheme} />

        <IconButton label={rightOpen ? 'Hide analysis' : 'Show analysis'} active={rightOpen} onClick={onToggleRight}>
          {rightOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </IconButton>
      </div>
    </header>
  );
}
