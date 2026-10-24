# Table View, Header Redesign & Session Metadata Editor

## Overview

Add a toggleable table view for telemetry data, reorganize the session header (segmented chart/table toggle, 3-dot menu), and add a session info modal with editable metadata that syncs to the backend.

## 1. Table View

### Data Model
- Global timestamp column driven by the highest-frequency active channel's timestamps
- Each active channel (including derived channels) gets a column
- Lower-frequency channels repeat their last known sample at timestamps where they have no new data
- Repeated/held values render at **50% opacity** to signal interpolation

### Layout
- Fills the same area the chart currently occupies (between left and right sidebars)
- Fixed header row: "Time (s)" column + one column per active channel
- Column headers show channel color swatch + short name with units (e.g., "Speed (mph)")
- Monospace font (JetBrains Mono) for all values
- Alternating subtle row tinting for readability
- Virtualized scrolling via `@tanstack/react-virtual` (uniform row height)

### Timestamp Search
- Search input above the table, left-aligned: "Go to time (s)..."
- Enter jumps to the nearest row matching the entered timestamp
- Row count displayed on the right side of the search bar
- Keyboard shortcut: Ctrl+G when table area is focused

## 2. Header Redesign

### Chart/Table Segmented Toggle
- Small pill-style segmented control in the header bar, after the logo
- Active segment: primary color background (#4361ee), white text
- Inactive segment: muted text, hover effect
- Minimal, matches existing header aesthetic

### 3-Dot Dropdown Menu
- Replaces the separate Export and Load File buttons
- Vertical ellipsis icon (MoreVertical from lucide-react) in the right controls area
- Dropdown items:
  1. **Load File** — triggers existing file input
  2. **Export CSV** — triggers existing export dialog
  3. **Session Info** — opens the session info modal
- Dropdown closes on click outside or item selection

### Track/Venue Pill
- Add a venue/track metadata pill to the header pills row (using MapPin icon)
- Uses `session.metadata.venue` (the "Venue" field from XRK metadata)
- Only shown if venue is not empty/"Unknown"

## 3. Session Info Modal

### View Mode
- Title: "Session Info"
- Edit button top-right (subtle primary color styling)
- Close button (X) top-right
- Label/value rows for all metadata:
  - **Editable:** Driver, Vehicle, Track, Date, Championship
  - **Read-only:** Duration, Laps, Source, Filename
- Empty/missing values shown as em-dash
- Larger modal: ~520px wide, generous padding, 13px text

### Edit Mode
- Same row layout as view mode (no visual shift)
- Editable fields: hover reveals subtle blue tint background on the row, text cursor
- Clicking a row makes it editable inline (contentEditable or hidden input that looks like plain text)
- Non-editable fields remain as plain text, unchanged
- Cancel/Save buttons appear at the bottom
- Cancel reverts all changes, Save persists to backend

### Save Behavior
- PATCH `/api/sessions/{session_id}/metadata` with changed fields
- Updates local session store
- If session has `remote_id`, syncs metadata to Railway/Data-Development backend
- On success: closes edit mode, updates header pills if driver/vehicle/track/date changed
- On error: shows inline error message, keeps edit mode open

## 4. Backend: Metadata Update Endpoint

### `PATCH /api/sessions/{session_id}/metadata`

**Request body (all fields optional):**
```json
{
  "driver_name": "string",
  "vehicle_name": "string", 
  "track_name": "string",
  "recorded_at": "string (ISO-8601)",
  "championship_name": "string"
}
```

**Behavior:**
1. Validate session exists
2. Update provided fields via `session_store.update_session()`
3. If session has `remote_id`, sync to Railway via `railway_client`
4. Return updated session entry

**Remote sync:** Add `update_session_metadata()` to `railway_client.py`. Uses PATCH to the Data-Development API. Failures are logged but don't block the local update.

**Data-Development side:** Add matching `PATCH /sessions/{session_id}/metadata` endpoint that updates the database model fields.

## 5. Light Mode Consistency

- Table uses CSS variable tokens for all colors (background, text, borders, row tinting)
- Session Info modal uses `bg-card`, `text-foreground`, `border-border` tokens
- 3-dot dropdown uses same token pattern
- Dimmed repeated values use `opacity-40` which works on both themes
- No hardcoded colors

## 6. Dependencies

- New: `@tanstack/react-virtual` (virtualized table scrolling)
- Existing: lucide-react (MoreVertical, MapPin icons), all other deps already present
