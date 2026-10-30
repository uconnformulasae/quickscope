import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'tinted' | 'plain' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-primary text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.2),0_1px_2px_rgba(0,0,0,0.2)] hover:brightness-110',
  secondary: 'bg-muted text-foreground hover:bg-surface-4',
  tinted: 'bg-primary/15 text-primary-text hover:bg-primary/20',
  plain: 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
  danger: 'bg-danger/10 text-danger hover:bg-danger/15',
};

const SIZES: Record<Size, string> = {
  sm: 'h-6 px-2.5',
  md: 'h-7 px-3',
  lg: 'h-8 px-3.5',
};

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary';

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] text-[13px] font-medium tracking-[-0.01em] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS} ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

export function IconButton({
  label,
  active,
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS} ${
        active
          ? 'bg-primary/15 text-primary-text'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      } ${className}`}
      {...rest}
    />
  );
}
