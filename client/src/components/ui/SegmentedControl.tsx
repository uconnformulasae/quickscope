import { useRef, type KeyboardEvent } from 'react';

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  ariaLabel: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const ni = (i + step + options.length) % options.length;
    const next = options[ni];
    if (next) {
      onChange(next.value);
      refs.current[ni]?.focus();
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="inline-flex gap-0 rounded-lg bg-muted p-0.5"
    >
      {options.map((o, idx) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary ${
              size === 'sm' ? 'px-[9px] py-0.5 text-[12px]' : 'px-[13px] py-[3px] text-[12.5px]'
            } ${
              on
                ? 'bg-popover text-foreground shadow-[0_0.5px_1px_rgba(0,0,0,0.2),0_1px_3px_rgba(0,0,0,0.12)] dark:bg-surface-4'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
