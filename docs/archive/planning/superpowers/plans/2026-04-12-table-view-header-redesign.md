# Table View, Header Redesign & Session Metadata Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable table view for telemetry data, reorganize the session header with a chart/table segmented toggle and 3-dot menu, and add a session info modal with editable metadata that syncs to the backend.

**Architecture:** CSS variable-driven theming (existing pattern). New `viewMode` state in the store toggles between chart and table rendering in the same layout slot. Table uses `@tanstack/react-virtual` for virtualized scrolling. Backend gets a new `PATCH /api/sessions/{id}/metadata` endpoint that mirrors the existing rename pattern. Session info modal is a new component rendered in App.tsx alongside existing dialogs.

**Tech Stack:** React 18, TypeScript, Tailwind CSS v3, @tanstack/react-virtual, FastAPI (backend), lucide-react icons, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-04-12-table-view-and-header-redesign.md`

---

### Task 1: Install Dependency & Add viewMode State

**Files:**
- Modify: `package.json` (root — no client/package.json exists)
- Modify: `client/src/lib/useXRKStore.ts`

- [ ] **Step 1: Install @tanstack/react-virtual**

```bash
cd /Users/manthan/Documents/development/quickscope && npm install @tanstack/react-virtual
```

- [ ] **Step 2: Add ViewMode type and state to useXRKStore.ts**

In `client/src/lib/useXRKStore.ts`, add the ViewMode type after line 22 (`export type ChartMode = 'separate' | 'overlay';`):

```ts
export type ViewMode = 'chart' | 'table';
```

Add `viewMode: ViewMode;` to the `AppState` interface after line 60 (`chartMode: ChartMode;`):

```ts
  viewMode: ViewMode;
```

- [ ] **Step 3: Initialize viewMode and add setter**

In the `useAppState()` hook, add initial state value `viewMode: 'chart' as ViewMode,` alongside the other initial values.

Add a setter function:

```ts
const setViewMode = useCallback((mode: ViewMode) => {
  setState(prev => ({ ...prev, viewMode: mode }));
}, []);
```

Add `setViewMode` to the returned object.

- [ ] **Step 4: Verify the app still compiles**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json client/src/lib/useXRKStore.ts
git commit -m "Add @tanstack/react-virtual and viewMode state"
```

---

### Task 2: Backend — Metadata Update Endpoint

**Files:**
- Modify: `backend/routes/sessions.py`
- Modify: `backend/services/railway_client.py`

- [ ] **Step 1: Add MetadataUpdate model to sessions.py**

In `backend/routes/sessions.py`, after the `RenameRequest` class (line 69), add:

```python
class MetadataUpdate(BaseModel):
    driver_name: str | None = None
    vehicle_name: str | None = None
    track_name: str | None = None
    recorded_at: str | None = None
    championship_name: str | None = None
```

- [ ] **Step 2: Add the PATCH endpoint**

After the rename endpoint (after line 118), add:

```python
@router.patch("/sessions/{session_id}/metadata")
async def update_session_metadata(session_id: str, body: MetadataUpdate):
    entry = session_store.get_session(session_id)
    if not entry:
        raise HTTPException(404, "Session not found")

    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        return entry

    updated = session_store.update_session(session_id, **updates)

    remote_id = entry.get("remote_id")
    if remote_id:
        try:
            await railway_client.update_session_metadata(remote_id, updates)
        except Exception as exc:
            logger.warning("Failed to sync metadata to Railway: %s", exc)

    return updated
```

- [ ] **Step 3: Add update_session_metadata to railway_client.py**

In `backend/services/railway_client.py`, after the `rename_session` function (after line 73), add:

```python
async def update_session_metadata(remote_id: int, fields: dict) -> dict:
    """Update metadata fields on the Railway backend."""
    base = _base_url()
    async with httpx.AsyncClient(timeout=TIMEOUT_DEFAULT) as client:
        resp = await client.patch(
            f"{base}/sessions/{remote_id}/metadata",
            json=fields,
        )
        resp.raise_for_status()
        return resp.json()
```

- [ ] **Step 4: Test the endpoint manually**

Start the backend, then test with curl:

```bash
cd /Users/manthan/Documents/development/quickscope/backend && python -m uvicorn main:app --reload --port 8000 &
# Wait for startup, then test with a known session ID (replace {id}):
curl -X PATCH http://localhost:8000/api/sessions/{id}/metadata \
  -H "Content-Type: application/json" \
  -d '{"driver_name": "Test Driver"}'
```

Verify the response contains the updated `driver_name`. Kill the background server after testing.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/sessions.py backend/services/railway_client.py
git commit -m "Add PATCH /api/sessions/{id}/metadata endpoint"
```

---

### Task 3: Client API Function for Metadata

**Files:**
- Modify: `client/src/lib/api.ts`

- [ ] **Step 1: Add the updateSessionMetadata function**

In `client/src/lib/api.ts`, after the `renameSession` function (after line 141), add:

```ts
export interface MetadataUpdate {
  driver_name?: string;
  vehicle_name?: string;
  track_name?: string;
  recorded_at?: string;
  championship_name?: string;
}

export async function updateSessionMetadata(sessionId: string, fields: MetadataUpdate): Promise<LocalSession> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Metadata update failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/lib/api.ts
git commit -m "Add updateSessionMetadata client API function"
```

---

### Task 4: Header Redesign — Segmented Toggle, 3-Dot Menu, Track Pill

**Files:**
- Modify: `client/src/components/SessionHeader.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Update SessionHeaderProps**

In `client/src/components/SessionHeader.tsx`, replace the `SessionHeaderProps` interface (lines 8-21) with:

```ts
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
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  viewMode: 'chart' | 'table';
  onViewModeChange: (mode: 'chart' | 'table') => void;
  onSessionInfoOpen?: () => void;
}
```

- [ ] **Step 2: Update imports**

Replace the lucide-react import (line 2) with:

```ts
import { Car, User, Calendar, Clock, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Gauge, Activity, ArrowLeft, MoreVertical, MapPin, Upload, Download, Info } from 'lucide-react';
```

Add a useState import — update line 1:

```ts
import { useRef, useState, useEffect } from 'react';
```

- [ ] **Step 3: Destructure new props and add dropdown state**

Update the function signature to destructure the new props (`viewMode`, `onViewModeChange`, `onSessionInfoOpen`).

Add dropdown state inside the component:

```ts
const [menuOpen, setMenuOpen] = useState(false);
const menuRef = useRef<HTMLDivElement>(null);

// Close on outside click
useEffect(() => {
  if (!menuOpen) return;
  const handler = (e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setMenuOpen(false);
    }
  };
  document.addEventListener('mousedown', handler);
  return () => document.removeEventListener('mousedown', handler);
}, [menuOpen]);
```

- [ ] **Step 4: Add segmented toggle after the logo**

After the logo `<QuickScopeLogo>` block (line 75) and before the file name block, add:

```tsx
{/* Chart / Table segmented toggle */}
{session && (
  <div className="flex items-center bg-muted/30 rounded-md p-0.5">
    <button
      onClick={() => onViewModeChange('chart')}
      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
        viewMode === 'chart'
          ? 'bg-primary text-white'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      Chart
    </button>
    <button
      onClick={() => onViewModeChange('table')}
      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
        viewMode === 'table'
          ? 'bg-primary text-white'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      Table
    </button>
  </div>
)}
```

- [ ] **Step 5: Add track/venue pill**

In the metadata pills section (lines 87-99), after the lap count pill (line 97), add:

```tsx
{metadata.venue && metadata.venue !== 'Unknown' && (
  <MetaPill icon={<MapPin className="w-3 h-3" />} value={metadata.venue} />
)}
```

- [ ] **Step 6: Replace Export/Load buttons with 3-dot menu**

Replace the right controls section (lines 102-150) with:

```tsx
<div className="flex items-center gap-1 ml-auto flex-shrink-0">
  {session && (
    <div className="hidden md:flex items-center gap-1 px-2 py-1 bg-muted/20 rounded text-xs text-muted-foreground">
      <span className="tabular">{totalSamples.toLocaleString()}</span>
      <span>samples</span>
    </div>
  )}

  {/* 3-dot menu */}
  <div className="relative" ref={menuRef}>
    <button
      onClick={() => setMenuOpen(!menuOpen)}
      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      title="Menu"
    >
      <MoreVertical className="w-4 h-4" />
    </button>
    {menuOpen && (
      <div className="absolute right-0 top-full mt-1 w-40 bg-card border border-border rounded-md shadow-lg z-50 py-1">
        <button
          onClick={() => { handleLoadClick(); setMenuOpen(false); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          Load File
        </button>
        {session && onExportOpen && (
          <button
            onClick={() => { onExportOpen(); setMenuOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
        )}
        {session && onSessionInfoOpen && (
          <button
            onClick={() => { onSessionInfoOpen(); setMenuOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Info className="w-3.5 h-3.5" />
            Session Info
          </button>
        )}
      </div>
    )}
  </div>

  {/* Hidden file input */}
  <input
    ref={fileInputRef}
    type="file"
    accept=".xrk,.xrz,.XRK,.XRZ"
    className="hidden"
    onChange={handleFileChange}
    data-testid="input-file-hidden"
  />

  <ThemeToggle theme={theme} onToggle={onToggleTheme} />

  <button
    onClick={onToggleRight}
    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
    title={rightOpen ? 'Hide analysis' : 'Show analysis'}
  >
    {rightOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
  </button>
</div>
```

- [ ] **Step 7: Update App.tsx to pass new props**

In `client/src/App.tsx`:

1. Add imports for the new state/types:
```ts
import type { DerivedChannel, ViewMode } from './lib/useXRKStore';
```

2. Destructure `setViewMode` from `useAppState()` (add to the destructuring on line 21-45).

3. Add session info dialog state after the other dialog states (after line 56):
```ts
const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
```

4. Update the `SessionHeader` invocation (lines 289-302) to pass new props:
```tsx
<SessionHeader
  session={session}
  fileName={state.fileName}
  leftOpen={leftSidebarOpen}
  rightOpen={rightSidebarOpen}
  onToggleLeft={toggleLeftSidebar}
  onToggleRight={toggleRightSidebar}
  onFileSelected={handleFileSelected}
  onExportOpen={session ? () => setExportDialogOpen(true) : undefined}
  totalSamples={session?.totalSamples ?? 0}
  onBack={handleBackToBrowser}
  theme={theme}
  onToggleTheme={toggleTheme}
  viewMode={state.viewMode}
  onViewModeChange={setViewMode}
  onSessionInfoOpen={session ? () => setSessionInfoOpen(true) : undefined}
/>
```

- [ ] **Step 8: Verify the app compiles and the toggle renders**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

Run the dev server and check in browser: toggle should be visible, 3-dot menu should open with items, track pill should show if venue data is present.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/SessionHeader.tsx client/src/App.tsx
git commit -m "Redesign header: segmented chart/table toggle, 3-dot menu, track pill"
```

---

### Task 5: Session Info Modal

**Files:**
- Create: `client/src/components/SessionInfoModal.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Create the SessionInfoModal component**

Create `client/src/components/SessionInfoModal.tsx`:

```tsx
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

interface EditableField {
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

  // Reset edit values when metadata changes
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

  // Close on Escape
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

  const fields: EditableField[] = [
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

  const displayValue = value || '\u2014';
  const isEmpty = !value || value === 'Unknown';

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
```

- [ ] **Step 2: Wire into App.tsx**

In `client/src/App.tsx`:

1. Import the component:
```ts
import { SessionInfoModal } from './components/SessionInfoModal';
```

2. Import `MetadataUpdate` type and `listSessions` if not already imported.

3. Add a callback to handle metadata updates. This needs to update the in-memory session metadata so the header pills reflect changes without a full reload:
```ts
const handleMetadataUpdated = useCallback((fields: MetadataUpdate) => {
  if (!session) return;
  const m = session.metadata;
  if (fields.driver_name !== undefined) m.driver = fields.driver_name;
  if (fields.vehicle_name !== undefined) m.vehicle = fields.vehicle_name;
  if (fields.track_name !== undefined) m.venue = fields.track_name;
  if (fields.recorded_at !== undefined) m.date = fields.recorded_at;
  if (fields.championship_name !== undefined) m.championship = fields.championship_name;
  // Force re-render by setting session again
  setSession(session, state.fileName || '');
}, [session, state.fileName, setSession]);
```

Note: This mutates the metadata object in place and re-sets it. If `setSession` does a deep clone, this works fine. If not, the mutation + setState will trigger a re-render since the reference is the same object but React will re-render due to the setState call. Check the existing `setSession` implementation — it stores the session reference directly, so this will work.

4. Add the modal render after the ExportDialog block (after line 444):

```tsx
{sessionInfoOpen && session && state.fileName && (
  <SessionInfoModal
    sessionId={/* need session ID from the store */}
    metadata={session.metadata}
    durationMs={session.durationMs}
    lapCount={Math.max(0, session.lapMarkers.length - 1)}
    fileName={state.fileName}
    onClose={() => setSessionInfoOpen(false)}
    onMetadataUpdated={handleMetadataUpdated}
  />
)}
```

Note: The current app state doesn't track `sessionId` (the backend UUID). We need to store it. Add `sessionId: string | null;` to AppState (in useXRKStore.ts), initialize to `null`, and set it when loading a session. The session ID comes from the `loadSession` or `listSessions` API. Check how the session is loaded — in `buildAndSetSession`, the session ID is available from the session browser flow. Add a `setSessionId` action and pass the session ID through.

Alternatively, since sessions loaded from the browser have an ID available, store it in a local `useState` in App.tsx:

```ts
const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
```

Set it in the `handleSessionLoaded` callback (the one passed to SessionBrowser). Then pass `loadedSessionId` to the modal.

- [ ] **Step 3: Verify compilation**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

- [ ] **Step 4: Test in browser**

Open the app, load a session, click 3-dot menu > Session Info. Verify:
- Modal appears centered with backdrop
- All metadata fields show correct values
- Click Edit, hover over editable rows — blue tint appears
- Click a field, type — value changes
- Cancel reverts, Save calls the API
- Close via X or clicking backdrop or Escape

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SessionInfoModal.tsx client/src/App.tsx client/src/lib/useXRKStore.ts
git commit -m "Add Session Info modal with editable metadata"
```

---

### Task 6: Table View — Data Logic

**Files:**
- Create: `client/src/lib/table-data.ts`

- [ ] **Step 1: Create the table data utility**

Create `client/src/lib/table-data.ts`:

```ts
import type { ChannelSample } from './xrk-parser';

export interface TableRow {
  timestamp: number; // milliseconds
  values: (number | null)[];
  /** Per-cell flag: true if this is a held/repeated value (not a fresh sample) */
  held: boolean[];
}

/**
 * Build a unified table from multiple channels at different sample rates.
 * Uses the highest-frequency channel's timestamps as the master timeline.
 * Lower-frequency channels repeat their last known value (marked as held).
 */
export function buildTableData(
  channelIds: number[],
  samplesMap: Map<number, ChannelSample[]>,
): TableRow[] {
  if (channelIds.length === 0) return [];

  // Find the channel with the most samples (highest frequency) to use as master timeline
  let masterTimestamps: number[] = [];
  for (const id of channelIds) {
    const samples = samplesMap.get(id);
    if (samples && samples.length > masterTimestamps.length) {
      masterTimestamps = samples.map(s => s.timestamp);
    }
  }

  if (masterTimestamps.length === 0) return [];

  // For each channel, build a lookup-friendly structure
  // We'll use a pointer-based approach: for each channel, walk through its samples
  // in sync with the master timestamps
  const channelPointers = channelIds.map(id => {
    const samples = samplesMap.get(id) || [];
    return { samples, ptr: 0 };
  });

  const rows: TableRow[] = new Array(masterTimestamps.length);

  for (let i = 0; i < masterTimestamps.length; i++) {
    const ts = masterTimestamps[i];
    const values: (number | null)[] = new Array(channelIds.length);
    const held: boolean[] = new Array(channelIds.length);

    for (let c = 0; c < channelIds.length; c++) {
      const ch = channelPointers[c];
      const { samples, ptr } = ch;

      if (samples.length === 0) {
        values[c] = null;
        held[c] = false;
        continue;
      }

      // Advance pointer to the last sample at or before this timestamp
      while (ch.ptr < samples.length - 1 && samples[ch.ptr + 1].timestamp <= ts) {
        ch.ptr++;
      }

      const sample = samples[ch.ptr];
      if (sample.timestamp <= ts) {
        values[c] = sample.value;
        // It's "held" if this sample's timestamp is strictly before the current row timestamp
        held[c] = sample.timestamp < ts;
      } else {
        // No sample yet at this timestamp
        values[c] = null;
        held[c] = false;
      }
    }

    rows[i] = { timestamp: ts, values, held };
  }

  return rows;
}

/**
 * Binary search for the row index closest to the given timestamp (ms).
 */
export function findRowByTimestamp(rows: TableRow[], targetMs: number): number {
  if (rows.length === 0) return 0;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].timestamp < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // Check if the previous row is closer
  if (lo > 0 && Math.abs(rows[lo - 1].timestamp - targetMs) < Math.abs(rows[lo].timestamp - targetMs)) {
    return lo - 1;
  }
  return lo;
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/lib/table-data.ts
git commit -m "Add table data utility for multi-rate channel merging"
```

---

### Task 7: Table View Component

**Files:**
- Create: `client/src/components/TableView.tsx`

- [ ] **Step 1: Create the TableView component**

Create `client/src/components/TableView.tsx`:

```tsx
import { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Clock } from 'lucide-react';
import type { XRKSession, ChannelSample } from '../lib/xrk-parser';
import type { ActiveChannel, DerivedChannel } from '../lib/useXRKStore';
import { buildTableData, findRowByTimestamp, type TableRow } from '../lib/table-data';
import { formatValue } from '../lib/chart-utils';

interface TableViewProps {
  session: XRKSession;
  activeChannels: ActiveChannel[];
  derivedChannels?: DerivedChannel[];
  derivedSamplesMap?: Map<number, ChannelSample[]>;
}

const ROW_HEIGHT = 28;

export function TableView({
  session,
  activeChannels,
  derivedChannels,
  derivedSamplesMap,
}: TableViewProps) {
  const [searchValue, setSearchValue] = useState('');
  const parentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Build channel info for columns
  const columns = useMemo(() => {
    return activeChannels
      .filter(ac => ac.visible)
      .map(ac => {
        const isDerived = ac.channelId >= 10000;
        const channelDef = session.channels.get(ac.channelId);
        const derivedDef = derivedChannels?.find(dc => dc.id === ac.channelId);
        return {
          channelId: ac.channelId,
          name: isDerived ? (derivedDef?.name || `DC${ac.channelId}`) : (channelDef?.shortName || `Ch${ac.channelId}`),
          units: isDerived ? (derivedDef?.units || '') : (channelDef?.units || ''),
          color: ac.color,
        };
      });
  }, [activeChannels, session.channels, derivedChannels]);

  // Merge all samples maps
  const allSamplesMap = useMemo(() => {
    const merged = new Map<number, ChannelSample[]>();
    for (const [id, samples] of session.samples) {
      merged.set(id, samples);
    }
    if (derivedSamplesMap) {
      for (const [id, samples] of derivedSamplesMap) {
        merged.set(id, samples);
      }
    }
    return merged;
  }, [session.samples, derivedSamplesMap]);

  // Build table data
  const channelIds = useMemo(() => columns.map(c => c.channelId), [columns]);
  const rows = useMemo(() => buildTableData(channelIds, allSamplesMap), [channelIds, allSamplesMap]);

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Ctrl+G shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Search: jump to timestamp
  const handleSearch = useCallback(() => {
    const seconds = parseFloat(searchValue);
    if (isNaN(seconds)) return;
    const ms = seconds * 1000;
    const idx = findRowByTimestamp(rows, ms);
    virtualizer.scrollToIndex(idx, { align: 'center' });
  }, [searchValue, rows, virtualizer]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  if (columns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground/60">Select channels in the sidebar to view data</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Search bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card/50 flex-shrink-0">
        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
        <input
          ref={searchRef}
          type="text"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Go to time (s)..."
          className="w-36 px-2 py-1 bg-muted/30 border border-border/50 rounded text-xs text-foreground placeholder:text-muted-foreground/50 font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <span className="text-[10px] text-muted-foreground/40 font-mono">Ctrl+G</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {rows.length.toLocaleString()} rows
        </span>
      </div>

      {/* Table header */}
      <div className="flex border-b border-border bg-card flex-shrink-0 overflow-hidden">
        <div className="w-24 flex-shrink-0 px-3 py-2 text-[11px] font-semibold text-muted-foreground font-mono border-r border-border/30">
          Time (s)
        </div>
        {columns.map((col) => (
          <div
            key={col.channelId}
            className="flex-1 min-w-[100px] px-3 py-2 text-[11px] font-semibold text-muted-foreground font-mono border-r border-border/30 last:border-r-0 flex items-center gap-1.5 truncate"
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: col.color }}
            />
            {col.name}{col.units ? ` (${col.units})` : ''}
          </div>
        ))}
      </div>

      {/* Virtualized rows */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            const isEven = virtualRow.index % 2 === 0;
            return (
              <div
                key={virtualRow.index}
                className={`flex absolute w-full ${isEven ? 'bg-background' : 'bg-card/30'}`}
                style={{
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div className="w-24 flex-shrink-0 px-3 flex items-center text-[11px] text-muted-foreground font-mono border-r border-border/10">
                  {(row.timestamp / 1000).toFixed(3)}
                </div>
                {row.values.map((val, colIdx) => (
                  <div
                    key={colIdx}
                    className={`flex-1 min-w-[100px] px-3 flex items-center text-[11px] font-mono border-r border-border/10 last:border-r-0 ${
                      row.held[colIdx]
                        ? 'text-foreground/40'
                        : val === null
                          ? 'text-muted-foreground/30'
                          : 'text-foreground'
                    }`}
                  >
                    {val !== null ? formatValue(val) : '\u2014'}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/TableView.tsx
git commit -m "Add TableView component with virtualized scrolling"
```

---

### Task 8: Wire Table View into App.tsx

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Import TableView**

Add to imports at the top of App.tsx:

```ts
import { TableView } from './components/TableView';
```

- [ ] **Step 2: Replace the chart area with conditional rendering**

In App.tsx, replace the chart rendering block (the `{session ? (` section around lines 341-352) with:

```tsx
{session ? (
  state.viewMode === 'table' ? (
    <TableView
      session={session}
      activeChannels={activeChannels}
      derivedChannels={state.derivedChannels}
      derivedSamplesMap={derivedSamplesMap}
    />
  ) : (
    <TelemetryChart
      session={session}
      activeChannels={activeChannels}
      viewRange={state.viewRange}
      onViewRangeChange={setViewRange}
      derivedChannels={state.derivedChannels}
      derivedSamplesMap={derivedSamplesMap}
      cursorTime={state.cursorTime}
      onCursorTimeChange={setCursorTime}
      chartMode={state.chartMode}
    />
  )
) : (
```

Keep the rest of the empty state / loading / error / drag-drop UI as-is (it follows the `) : (` branch).

- [ ] **Step 3: Verify compilation and test**

```bash
cd /Users/manthan/Documents/development/quickscope/client && npx tsc --noEmit
```

Run the dev server:
1. Load a session with multiple channels at different frequencies
2. Toggle active channels in the sidebar
3. Click "Table" in the header toggle
4. Verify: rows appear, dimmed values for held samples, timestamp column correct
5. Type a timestamp in search, press Enter — table scrolls to that position
6. Toggle back to "Chart" — chart renders correctly
7. Toggle to light mode — table should use correct theme colors

- [ ] **Step 4: Commit**

```bash
git add client/src/App.tsx
git commit -m "Wire TableView into main layout with chart/table toggle"
```

---

### Task 9: Light Mode & Polish Pass

**Files:**
- Modify: `client/src/components/SessionInfoModal.tsx` (if needed)
- Modify: `client/src/components/SessionHeader.tsx` (if needed)
- Modify: `client/src/components/TableView.tsx` (if needed)

- [ ] **Step 1: Test all new components in light mode**

Run the dev server, toggle to light mode. Verify each component:

1. **Header toggle**: Primary color segment should be visible on light background
2. **3-dot dropdown**: White background, dark text, subtle hover
3. **Track pill**: Should match other pills
4. **Table view**: Light background, dark text, subtle alternating rows, dimmed held values still distinguishable
5. **Session Info modal**: White card background, dark text, edit hover tint visible

- [ ] **Step 2: Fix any issues found**

Common fixes:
- If dropdown bg is wrong: ensure it uses `bg-card` (which is white in light mode)
- If table rows lack contrast: adjust `bg-card/30` to `bg-muted/20`
- If held values are too dim in light mode: check that `text-foreground/40` provides enough contrast — may need `dark:text-foreground/40 text-foreground/35` or similar

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "Light mode polish for table view, header, and session info modal"
```

---

### Task 10: Final Verification & Cleanup

- [ ] **Step 1: Full walkthrough in dark mode**

1. Session browser — 3-dot menu visible, no stale Export/Load buttons
2. Load a session — header shows toggle, track pill, 3-dot menu
3. Chart view — works as before
4. Table view — data correct, scroll smooth, search works
5. Session Info modal — view mode, edit mode, save persists
6. Toggle between chart and table — state preserved

- [ ] **Step 2: Full walkthrough in light mode**

Same sequence as above. Everything should be theme-consistent.

- [ ] **Step 3: Commit the planning docs**

```bash
git add docs/superpowers/plans/2026-04-11-light-mode.md docs/superpowers/plans/2026-04-12-table-view-header-redesign.md docs/superpowers/specs/2026-04-12-table-view-and-header-redesign.md
git commit -m "Add planning and spec docs for table view and header redesign"
```
