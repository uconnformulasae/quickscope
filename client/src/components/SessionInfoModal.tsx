import { useState, useRef, useEffect, useCallback } from 'react';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Button';
import { renameSession } from '../lib/api';
import type { LocalSession } from '../lib/api';

const SOURCE_LABELS: Record<LocalSession['source'], string> = {
  manual_upload: 'Manual upload',
  aim_device: 'AiM device',
};

interface SessionInfoModalProps {
  sessionId: string;
  metadata: {
    driver: string;
    vehicle: string;
    venue: string;
    date: string;
    time: string;
    championship: string;
    sessionType: string;
  };
  durationMs: number;
  lapCount: number;
  totalSamples: number;
  fileName: string;
  source: LocalSession['source'];
  onClose: () => void;
  onFileRenamed?: (newFileName: string) => void;
}

interface FieldDef {
  label: string;
  key: string;
  value: string;
  editable: boolean;
}

function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = (totalSec % 60).toFixed(2);
  return `${min}:${sec.padStart(5, '0')}`;
}

export function SessionInfoModal({
  sessionId,
  metadata,
  durationMs,
  lapCount,
  totalSamples,
  fileName,
  source,
  onClose,
  onFileRenamed,
}: SessionInfoModalProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editFilename, setEditFilename] = useState(fileName);

  useEffect(() => {
    setEditFilename(fileName);
  }, [fileName]);

  const handleCancel = () => {
    setEditFilename(fileName);
    setError(null);
    setEditing(false);
  };

  const handleSave = useCallback(async () => {
    if (editFilename === fileName) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await renameSession(sessionId, editFilename);
      onFileRenamed?.(editFilename);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [editFilename, fileName, sessionId, onFileRenamed]);

  const fields: FieldDef[] = [
    { label: 'Filename', key: 'filename', value: editing ? editFilename : fileName, editable: true },
    { label: 'Driver', key: 'driver', value: metadata.driver, editable: false },
    { label: 'Vehicle', key: 'vehicle', value: metadata.vehicle, editable: false },
    { label: 'Track', key: 'venue', value: metadata.venue, editable: false },
    { label: 'Date', key: 'date', value: metadata.date, editable: false },
    { label: 'Championship', key: 'championship', value: metadata.championship, editable: false },
    { label: 'Duration', key: 'duration', value: formatDuration(durationMs), editable: false },
    { label: 'Laps', key: 'laps', value: lapCount > 0 ? String(lapCount) : '\u2014', editable: false },
    { label: 'Samples', key: 'samples', value: totalSamples.toLocaleString(), editable: false },
    { label: 'Source', key: 'source', value: SOURCE_LABELS[source], editable: false },
  ];

  return (
    <Sheet
      title="Session Info"
      onClose={onClose}
      footer={
        editing ? (
          <>
            <Button variant="plain" onClick={handleCancel} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </>
        ) : undefined
      }
    >
      {!editing && (
        <div className="flex justify-end pb-1">
          <Button variant="tinted" onClick={() => setEditing(true)}>Rename</Button>
        </div>
      )}
      {fields.map((field) => (
        <EditableRow
          key={field.key}
          label={field.label}
          value={field.value}
          editable={editing && field.editable}
          onChange={field.editable ? setEditFilename : () => {}}
        />
      ))}
      {error && (
        <div className="mt-2 px-3 py-2 rounded-md text-xs bg-danger/10 text-danger border border-danger/20">
          {error}
        </div>
      )}
    </Sheet>
  );
}

function EditableRow({
  label,
  value,
  editable,
  onChange,
}: {
  label: string;
  value: string;
  editable: boolean;
  onChange: (v: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isEmpty = !value || value === 'Unknown';
  const displayValue = isEmpty ? '\u2014' : value;

  if (!editable) {
    return (
      <div className="flex justify-between items-center py-3.5 border-b border-border/30 last:border-b-0">
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <span className={`text-[13px] font-medium ${isEmpty ? 'text-muted-foreground' : 'text-foreground'}`}>
          {displayValue}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`flex justify-between items-center py-3.5 border-b border-border/30 last:border-b-0 rounded-md -mx-2 px-2 transition-colors cursor-text ${
        hovered ? 'bg-primary/5' : ''
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => inputRef.current?.focus()}
    >
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`text-[13px] font-medium text-right bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground w-[60%] ${
          isEmpty ? 'text-muted-foreground italic' : ''
        }`}
        placeholder="Not set"
      />
    </div>
  );
}
