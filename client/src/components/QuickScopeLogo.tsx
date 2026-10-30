import { useId } from 'react';

const CX = 50;
const CY = 53;
const R = 28;
const TRACK_START = 135;
const TRACK_END = 405;
const VALUE_END = 330;

function point(angleDeg: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
}

function arc(startDeg: number, endDeg: number): string {
  const [x0, y0] = point(startDeg);
  const [x1, y1] = point(endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function GaugeGlyph({ size, mono = false }: { size: number; mono?: boolean }) {
  const gradId = `qs-gauge-${useId().replace(/:/g, '')}`;
  const [tipX, tipY] = point(VALUE_END);
  const blue = mono ? 'currentColor' : `url(#${gradId})`;
  const orange = mono ? 'currentColor' : '#f77f00';
  const track = mono ? 'currentColor' : 'hsl(var(--label-4))';
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      {!mono && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7f95ff" />
            <stop offset=".55" stopColor="#4361ee" />
            <stop offset="1" stopColor="#3048c9" />
          </linearGradient>
        </defs>
      )}
      <path d={arc(TRACK_START, TRACK_END)} fill="none" stroke={track} strokeWidth="9" strokeLinecap="round" opacity={mono ? 0.3 : undefined} />
      <path d={arc(TRACK_START, VALUE_END)} fill="none" stroke={blue} strokeWidth="9" strokeLinecap="round" />
      <path d="M36 60 L43 60 L47 49 L53 67 L57 55 L64 55" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={tipX.toFixed(2)} cy={tipY.toFixed(2)} r="7" fill={orange} />
    </svg>
  );
}

export function QuickScopeLogo({ size = 20, showWordmark = true }: { size?: number; showWordmark?: boolean }) {
  return (
    <div role="img" aria-label="QuickScope" className="flex items-center gap-1.5 text-foreground">
      <GaugeGlyph size={size} />
      {showWordmark && (
        <span className="font-display font-semibold tracking-tight text-[14px]">QuickScope</span>
      )}
    </div>
  );
}
