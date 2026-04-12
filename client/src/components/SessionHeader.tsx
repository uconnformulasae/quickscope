import { useRef, useState, useEffect } from 'react';
import { Car, User, Calendar, Clock, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Gauge, Activity, ArrowLeft, MoreVertical, MapPin, Upload, Download, Info } from 'lucide-react';
import type { XRKSession } from '../lib/xrk-parser';
import { formatTime } from '../lib/xrk-parser';
import { QuickScopeLogo } from './QuickScopeLogo';
import { ThemeToggle } from './ThemeToggle';

interface SessionHeaderProps {
  session: XRKSession | null;
  fileName: string | null;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onFileSelected: (file: File) => void;
  onExportOpen?: () => void;
  totalSamples: number;
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
  totalSamples,
  onBack,
  theme,
  onToggleTheme,
  viewMode,
  onViewModeChange,
  onSessionInfoOpen,
}: SessionHeaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleLoadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelected(file);
      // Reset so the same file can be re-selected
      e.target.value = '';
    }
  };

  const metadata = session?.metadata;
  const lapCount = session ? Math.max(0, session.lapMarkers.length - 1) : 0;

  return (
    <header className="flex items-center gap-3 px-3 h-10 border-b border-border bg-card flex-shrink-0 overflow-visible relative z-20">
      {/* Back + Logo + toggle */}
      <div className="flex items-center gap-2">
        {onBack && (
          <button
            onClick={onBack}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Back to sessions"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={onToggleLeft}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          title={leftOpen ? 'Hide channels' : 'Show channels'}
        >
          {leftOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
        </button>
        <QuickScopeLogo size={24} textClass="text-sm" />
      </div>

      {/* Chart / Table segmented toggle */}
      {session && (
        <div className="flex items-center bg-muted rounded-md p-0.5 border border-border/50">
          <button
            onClick={() => onViewModeChange('chart')}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              viewMode === 'chart'
                ? 'bg-primary text-white'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Chart
          </button>
          <button
            onClick={() => onViewModeChange('table')}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              viewMode === 'table'
                ? 'bg-primary text-white'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Table
          </button>
        </div>
      )}

      {/* File name */}
      {fileName && (
        <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 bg-muted/30 rounded-md">
          <Activity className="w-3 h-3 text-primary" />
          <span className="text-xs text-muted-foreground font-medium truncate max-w-[160px]">{fileName}</span>
        </div>
      )}

      {/* Session metadata pills */}
      {metadata && (
        <div className="flex items-center gap-2 overflow-hidden min-w-0">
          <MetaPill icon={<Car className="w-3 h-3" />} value={metadata.vehicle} />
          <MetaPill icon={<User className="w-3 h-3" />} value={metadata.driver} />
          <MetaPill icon={<Calendar className="w-3 h-3" />} value={metadata.date} />
          {session && (
            <MetaPill icon={<Clock className="w-3 h-3" />} value={formatTime(session.durationMs)} label="Duration" />
          )}
          {lapCount > 0 && (
            <MetaPill icon={<Gauge className="w-3 h-3" />} value={`${lapCount} laps`} />
          )}
          {metadata.venue && metadata.venue !== 'Unknown' && (
            <MetaPill icon={<MapPin className="w-3 h-3" />} value={metadata.venue} />
          )}
        </div>
      )}

      {/* Right controls */}
      <div className="flex items-center gap-1 ml-auto flex-shrink-0">
        {session && (
          <div className="hidden md:flex items-center gap-1 px-2 py-1 bg-muted/20 rounded text-xs text-muted-foreground">
            <span className="tabular">{totalSamples.toLocaleString()}</span>
            <span>samples</span>
          </div>
        )}

        {/* 3-dot dropdown menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Menu"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-40 bg-card border border-border rounded-md shadow-lg z-50 py-1">
              <button
                onClick={() => { handleLoadClick(); setMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                Load File
              </button>
              {session && onExportOpen && (
                <button
                  onClick={() => { onExportOpen(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export CSV
                </button>
              )}
              {session && onSessionInfoOpen && (
                <button
                  onClick={() => { onSessionInfoOpen(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  <Info className="w-3.5 h-3.5" />
                  Session Info
                </button>
              )}
            </div>
          )}
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xrk,.xrz,.XRK,.XRZ"
          className="hidden"
          onChange={handleFileChange}
          data-testid="input-file-hidden"
        />

        <ThemeToggle theme={theme} onToggle={onToggleTheme} />

        <button
          onClick={onToggleRight}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          title={rightOpen ? 'Hide analysis' : 'Show analysis'}
        >
          {rightOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
        </button>
      </div>
    </header>
  );
}

function MetaPill({ icon, value, label }: { icon: React.ReactNode; value: string; label?: string }) {
  if (value === 'Unknown' || !value) return null;
  return (
    <div className="hidden lg:flex items-center gap-1 px-1.5 py-0.5 bg-muted border border-border/40 rounded text-xs text-foreground/70 whitespace-nowrap">
      <span className="text-primary">{icon}</span>
      <span>{value}</span>
    </div>
  );
}
