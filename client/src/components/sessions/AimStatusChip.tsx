import { useRef, useState } from 'react';
import { ChevronDown, Download, Activity, RefreshCw, Settings } from 'lucide-react';
import type { AimStatus } from '../../lib/api';
import { Menu, type MenuEntry } from '../ui/Menu';

export function AimStatusChip({
  status,
  onPull,
  onOpenLive,
  onRecheck,
  onOpenSettings,
}: {
  status: AimStatus | null;
  onPull: () => void;
  onOpenLive: () => void;
  onRecheck: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const connected = !!status?.connected;
  const text = connected ? status?.device?.device_name || 'AiM connected' : 'No AiM device';

  const headline = connected ? `Connected to ${status?.device?.device_name || 'AiM logger'}` : 'No AiM device found';
  const hint = connected
    ? [status?.device?.model, status?.device?.ip].filter(Boolean).join(' · ') || 'Ready to pull sessions or stream live data'
    : "Join the logger's Wi-Fi (AiM-EVO5…)";

  const items: MenuEntry[] = [
    { label: 'Pull Sessions…', icon: Download, onSelect: onPull },
    { label: 'Open Live View', icon: Activity, onSelect: onOpenLive },
    'separator',
    { label: 'Search Again', icon: RefreshCw, onSelect: onRecheck },
    { label: 'Network Settings…', icon: Settings, onSelect: onOpenSettings },
  ];

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={`AiM status: ${text}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 items-center gap-[7px] rounded-[14px] bg-muted pl-[9px] pr-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      >
        <span className={`h-[7px] w-[7px] rounded-full ${connected ? 'bg-success' : 'bg-label-3'}`} aria-hidden="true" />
        {text}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 w-[270px] rounded-[10px] bg-popover shadow-xl ring-1 ring-border">
          <div className="px-3.5 pb-2 pt-3">
            <div className="text-[13px] font-semibold text-foreground">{headline}</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">{hint}</div>
          </div>
          <Menu
            items={items}
            onClose={() => setOpen(false)}
            dismissRef={box}
            className="min-w-0 border-t border-separator !bg-transparent !shadow-none !ring-0"
          />
        </div>
      )}
    </div>
  );
}
