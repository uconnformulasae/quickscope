# Click-to-Cycle Units on Live Tiles — Implementation Plan

**Goal:** Switching a live value's unit takes one click on the value instead of Edit → configure widget → Unit → Save.

**Decisions (confirmed with the user 2026-10-22):**
- Clicking a value cycles it through the units it converts to (°C → °F → °C, bar → psi → kPa → bar).
- Every value is independent: the choice is keyed `layoutId:widgetId:channelName`, so the same channel in two widgets keeps two choices.
- Every value can always cycle back to the layout's own unit. Nothing locks: a stored choice that no longer fits the channel (logger unit changed, channel edited) is ignored and the cycle restarts from the layout unit.
- Choices are per viewer (`localStorage`), never written into the layout, so they work on built-in layouts and never make a layout dirty. Landing back on the layout unit deletes the stored choice.
- Off in edit mode (a click there starts a drag; the config dialog sets the layout's default). Edit mode shows the layout's own units.
- Thresholds follow the unit: `warn`, `crit`, `invalidBelow`, `min`, `max` are converted into the chosen unit.
- A switched value's unit label is tinted primary so a stray tap is visible.

## Cycle rules (`units.ts`)

`unitCycle(sourceUnit, homeUnit)` — the units a value steps through, home first:
- No source unit, or the source has no alternatives → `[]` (not clickable).
- `home` = the layout's display unit (`ref.unit ?? sourceUnit`).
- `home` converts from the source → the source's family, rotated so `home` is first.
- `home` is only a label (e.g. an old `kph`) → `[home, ...family]`, so the label is still reachable.

`nextUnit(cycle, current)` — the entry after `current`, wrapping; a `current` not in the cycle counts as `home`.

## Files

| File | Change |
|---|---|
| `client/src/components/live/units.ts` | `unitCycle`, `nextUnit` |
| `client/src/components/live/WidgetRenderer.tsx` | `withDisplayUnit(ref, unit, sourceUnit)` (converts thresholds/range); per-value override lookup and click handler for `stats`, `bars`, `otherChannels` |
| `client/src/components/live/useUnitOverrides.ts` | New: `localStorage`-backed map + pure `cycleOverride` / `loadOverrides` / `saveOverrides` |
| `client/src/components/live/widgets.tsx` | `BigStat`, `CoolStat`, `VehicleStat`, `BarRow` take `onClick` / `unitChanged`; `clickableProps` helper (role=button, keyboard) |
| `client/src/components/live/LiveDashboard.tsx` | Pass `layout.id` and the override props through |
| `client/src/components/LiveView.tsx` | Own the hook; pass overrides only outside edit mode |

## Tests (`npx vitest run --root client`)

- `units.test.ts`: cycle order, wrap-around back to home, label-only home, stale `current`, no alternatives.
- `widget-values.test.ts`: `withDisplayUnit` converts crit °C → °F, min/max bar → psi, keeps unset fields unset, converts from the source when the layout unit is only a label.
- `unit-overrides.test.ts`: cycling stores the next unit, deletes it on return to home, stale entries restart; load/save survive a throwing or garbage storage.

Done = vitest green, `npx tsc --noEmit -p .` clean, manual check in the app.
