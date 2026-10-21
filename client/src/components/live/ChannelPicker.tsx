export interface ChannelSources {
  /** Keys of the snapshot on screen right now. */
  live: string[];
  /** Channels this car sent on earlier sessions (backend cache). */
  seen: string[];
  /** Channels the app knows the car has (live-channels.ts). */
  builtin: string[];
  /** Unit the logger sends each channel in (live, else remembered, else built-in). */
  units: Record<string, string>;
  vehicleLabel: string;
}

/**
 * Shared suggestion list for every ChannelPicker in a dialog. Each name is
 * listed once, tagged with the best source it came from.
 */
export function ChannelDatalist({ id, sources }: { id: string; sources: ChannelSources }) {
  const tagged = new Map<string, string>();
  for (const n of sources.live) tagged.set(n, 'Live now');
  for (const n of sources.seen) if (!tagged.has(n)) tagged.set(n, `Seen on ${sources.vehicleLabel}`);
  for (const n of sources.builtin) if (!tagged.has(n)) tagged.set(n, 'Built-in');
  const entries = [...tagged.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <datalist id={id}>
      {entries.map(([name, tag]) => (
        <option key={name} value={name} label={tag} />
      ))}
    </datalist>
  );
}

/** Free-text channel name input with suggestions; flags names the car has never sent. */
export function ChannelPicker({
  value,
  onChange,
  listId,
  sources,
  placeholder = 'Channel name',
}: {
  value: string;
  onChange: (name: string) => void;
  listId: string;
  sources: ChannelSources;
  placeholder?: string;
}) {
  // Only flag once we actually know what this car sends.
  const knowsCar = sources.live.length > 0 || sources.seen.length > 0;
  const unseen = knowsCar && value !== '' && !sources.live.includes(value) && !sources.seen.includes(value);
  return (
    <div className="relative flex-1 min-w-0">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder={placeholder}
        spellCheck={false}
        className={`w-full px-2 py-1 bg-background border rounded text-xs text-foreground font-mono placeholder-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary ${
          unseen ? 'border-amber-500/50 pr-16' : 'border-border'
        }`}
      />
      {unseen && (
        <span
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-amber-600 dark:text-amber-400 pointer-events-none"
          title={`${sources.vehicleLabel} hasn't sent this channel on this laptop yet. It will show "—" until it does.`}
        >
          not seen
        </span>
      )}
    </div>
  );
}
