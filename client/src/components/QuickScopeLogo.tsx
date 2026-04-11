export function QuickScopeLogo({ size = 28, textClass = 'text-base' }: { size?: number; textClass?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-label="QuickScope">
        <rect width="40" height="40" rx="8" fill="hsl(230 25% 10%)" />
        <circle cx="20" cy="20" r="11" stroke="#4361ee" strokeWidth="2.5" />
        <line x1="20" y1="5" x2="20" y2="13" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="20" y1="27" x2="20" y2="35" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="5" y1="20" x2="13" y2="20" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="27" y1="20" x2="35" y2="20" stroke="#4361ee" strokeWidth="2.5" strokeLinecap="round" />
        <polyline points="13,22 16,17 19,23 22,18 25,21 27,20" stroke="#f77f00" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle cx="20" cy="20" r="2" fill="#f77f00" />
      </svg>
      <span className={`${textClass} font-semibold text-foreground tracking-tight`}>QuickScope</span>
    </div>
  );
}
