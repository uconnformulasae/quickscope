import { Moon, Sun } from 'lucide-react';

interface ThemeToggleProps {
  theme: 'dark' | 'light';
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  return (
    <button
      onClick={onToggle}
      className="p-1 hover:opacity-70 transition-opacity"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <Moon className="w-4 h-4" style={{ color: '#4361ee' }} />
      ) : (
        <Sun className="w-4 h-4" style={{ color: '#f5a623' }} />
      )}
    </button>
  );
}
