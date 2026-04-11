# Overlay Mode for Channel Graphs

## Summary
Add a toggle in the channel sidebar to switch between "Separate" (current stacked strips) and "Overlay" (all channels on one shared graph) display modes.

## Decisions
- **Toggle location:** Segmented control at top of ChannelSidebar, above search bar
- **Y-axes in overlay:** Each channel gets its own Y-axis, alternating left/right (1st left, 2nd right, 3rd left offset, etc.), color-coded to match trace
- **Mode switch behavior:** Preserve X-axis view range and cursor positions across mode changes
- **Channel limit:** No limit on overlay count — user manages complexity
- **Approach:** Branch inside existing TelemetryChart (not a separate component)

## State
- New field `chartMode: 'separate' | 'overlay'` in `useXRKStore` AppState
- Default: `'separate'`
- Action: `setChartMode(mode)`

## Sidebar Toggle
- Segmented pill control (Separate | Overlay) above search bar in ChannelSidebar
- Active state: primary blue tint. Inactive: muted.
- Only shown when session is loaded

## TelemetryChart Changes

### Layout
- **Separate mode:** Unchanged — each channel gets its own strip
- **Overlay mode:** All visible channels share one strip spanning full chart height

### Y-Axes (Overlay)
- Alternate left/right per channel
- Color-coded tick labels matching trace color
- LEFT_MARGIN and RIGHT_MARGIN expand dynamically (~50px per axis on that side)

### Cursor & Delta
- Identical behavior in both modes — vertical cursor line spans full height
- Value pills show interpolated values for all channels (already the case)
- Delta panel unchanged

### Rendering
- Same downsampling, same X-axis, same grid
- Each channel drawn with its own Y-range mapped to the shared strip height
- Traces drawn in channel order with 2px line width (same as current)
