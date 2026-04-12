import { useState, useRef, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { updateSessionMetadata, type MetadataUpdate } from '../lib/api';

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
  fileName: string;
  source?: string;
  onClose: () => void;
  onMetadataUpdated?: (fields: MetadataUpdate) => void;
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
  fileName,
  source,
  onClose,
  onMetadataUpdated,
}: SessionInfoModalProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({
    driver: metadata.driver,
    vehicle: metadata.vehicle,
    venue: metadata.venue,
    date: metadata.date,
    championship: metadata.championship,
  });
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEditValues({
      driver: metadata.driver,
      vehicle: metadata.vehicle,
      venue: metadata.venue,
      date: metadata.date,
      championship: metadata.championship,
    });
  }, [metadata]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCancel = () => {
    setEditValues({
      driver: metadata.driver,
      vehicle: metadata.vehicle,
      venue: metadata.venue,
      date: metadata.date,
      championship: metadata.championship,
    });
    setError(null);
    setEditing(false);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const fields: MetadataUpdate = {};
      if (editValues.driver !== metadata.driver) fields.driver_name = editValues.driver;
      if (editValues.vehicle !== metadata.vehicle) fields.vehicle_name = editValues.vehicle;
      if (editValues.venue !== metadata.venue) fields.track_name = editValues.venue;
      if (editValues.date !== metadata.date) fields.recorded_at = editValues.date;
      if (editValues.championship !== metadata.championship) fields.championship_name = editValues.championship;

      if (Object.keys(fields).length === 0) {
        setEditing(false);
        return;
      }

      await updateSessionMetadata(sessionId, fields);
      onMetadataUpdated?.(fields);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [editValues, metadata, sessionId, onMetadataUpdated]);

  const fields: FieldDef[] = [
    { label: 'Driver', key: 'driver', value: editing ? editValues.driver : metadata.driver, editable: true },
    { label: 'Vehicle', key: 'vehicle', value: editing ? editValues.vehicle : metadata.vehicle, editable: true },
    { label: 'Track', key: 'venue', value: editing ? editValues.venue : metadata.venue, editable: true },
    { label: 'Date', key: 'date', value: editing ? editValues.date : metadata.date, editable: true },
    { label: 'Championship', key: 'championship', value: editing ? editValues.championship : metadata.championship, editable: true },
    { label: 'Duration', key: 'duration', value: formatDuration(durationMs), editable: false },
    { label: 'Laps', key: 'laps', value: lapCount > 0 ? String(lapCount) : '\u2014', editable: false },
    { label: 'Source', key: 'source', value: source || 'Manual upload', editable: false },
    { label: 'Filename', key: 'filename', value: fileName, editable: false },
  ];

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="w-[520px] bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <span className="text-[15px] font-semibold text-foreground">Session Info</span>
          <div className="flex items-center gap-2">
            {!editing && (
              <button
                onClick={() => setEditing(true)}
                className="px-3.5 py-1 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
              >
                Edit
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-2">
          {fields.map((field) => (
            <EditableRow
              key={field.key}
              label={field.label}
              value={field.value}
              editable={editing && field.editable}
              onChange={(v) => setEditValues(prev => ({ ...prev, [field.key]: v }))}
            />
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-6 mb-2 px-3 py-2 rounded-md text-xs bg-red-500/10 text-red-500 dark:text-red-400 border border-red-500/20">
            {error}
          </div>
        )}

        {/* Footer (edit mode only) */}
        {editing && (
          <div className="flex justify-end gap-2 px-6 pb-5 pt-3 border-t border-border">
            <button
              onClick={handleCancel}
              disabled={saving}
              className="px-3.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground border border-border hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3.5 py-1.5 rounded-md text-xs font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
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
