import { useRef } from 'react';
import { Car, User, Calendar, Clock, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Upload, Gauge, Activity, Download, ArrowLeft } from 'lucide-react';
import type { XRKSession } from '../lib/xrk-parser';
import { formatTime } from '../lib/xrk-parser';

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
}: SessionHeaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    <header className="flex items-center gap-3 px-3 h-10 border-b border-border bg-card flex-shrink-0 overflow-hidden">
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
        <QuickScopeLogoInline />
      </div>

      {/* File name */}
      {fileName && (
        <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 bg-muted/30 rounded-md">
          <Activity className="w-3 h-3 text-primary" />
          <span className="text-xs text-muted-foreground font-medium truncate max-w-[160px]">{fileName}</span>
        </div>
      )}

      {/* Session metadata pills */}
      {metadata && (
        <div className="flex items-center gap-2 overflow-hidden">
          <MetaPill icon={<Car className="w-3 h-3" />} value={metadata.vehicle} />
          <MetaPill icon={<User className="w-3 h-3" />} value={metadata.driver} />
          <MetaPill icon={<Calendar className="w-3 h-3" />} value={metadata.date} />
          {session && (
            <MetaPill icon={<Clock className="w-3 h-3" />} value={formatTime(session.durationMs)} label="Duration" />
          )}
          {lapCount > 0 && (
            <MetaPill icon={<Gauge className="w-3 h-3" />} value={`${lapCount} laps`} />
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

        {/* Export CSV button — only when a session is loaded */}
        {session && onExportOpen && (
          <button
            onClick={onExportOpen}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Export CSV"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export</span>
          </button>
        )}

        {/* Load File button triggers hidden file input */}
        <button
          onClick={handleLoadClick}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Load File</span>
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xrk,.xrz,.XRK,.XRZ"
          className="hidden"
          onChange={handleFileChange}
          data-testid="input-file-hidden"
        />

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
    <div className="hidden lg:flex items-center gap-1 px-1.5 py-0.5 bg-muted/30 rounded text-xs text-muted-foreground whitespace-nowrap">
      <span className="text-primary">{icon}</span>
      <span>{value}</span>
    </div>
  );
}

function QuickScopeLogoInline() {
  return (
    <div className="flex items-center gap-1.5">
      <svg width="24" height="24" viewBox="0 0 40 40" fill="none" aria-label="QuickScope">
        {/* Background tile */}
        <rect width="40" height="40" rx="8" fill="hsl(230 25% 10%)"/>
        {/* Outer crosshair circle */}
        <circle cx="20" cy="20" r="11" stroke="#4361ee" strokeWidth="2.5"/>
        {/* Crosshair lines */}
        <line x1="20" y1="5" x2="20" y2="13" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round"/>
        <line x1="20" y1="27" x2="20" y2="35" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round"/>
        <line x1="5" y1="20" x2="13" y2="20" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round"/>
        <line x1="27" y1="20" x2="35" y2="20" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round"/>
        {/* Small waveform inside */}
        <polyline points="13,22 16,17 19,23 22,18 25,21 27,20" stroke="#f77f00" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        {/* Center dot */}
        <circle cx="20" cy="20" r="2" fill="#f77f00"/>
      </svg>
      <span className="text-sm font-semibold text-foreground tracking-tight">QuickScope</span>
    </div>
  );
}
