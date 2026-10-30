# UI Redesign — Phase 1 (Visual) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle QuickScope's Sessions, Analysis and Live screens to the approved Apple-style design (tokens, system fonts, Gauge logo, shared primitives), without removing any feature.

**Architecture:** Design tokens live in `client/src/index.css` as HSL triplets, keeping the existing shadcn token names so the many `bg-card` / `text-muted-foreground` classes keep working, plus new tokens exposed through `tailwind.config.ts`. A small set of hand-rolled primitives in `client/src/components/ui/` (Button, SegmentedControl, Menu, Sheet) replace the per-component copies. Pure helpers (date grouping, channel grouping, lap-label thinning) go in `client/src/lib/` with unit tests. Components then adopt them screen by screen.

**Tech Stack:** React 18 + TypeScript, Tailwind v4 (`@config` to `tailwind.config.ts`), lucide-react, Vitest + Testing Library (jsdom), Electron 44.

**Spec:** `docs/superpowers/specs/2026-10-29-ui-redesign-design.md` (Phase 1 sections 1.1–1.6). Visual reference: `.superpowers/brainstorm/47656-1793320409/content/redesign-v4.html` (screens + Style guide tab) and `logo-v3.html` (Gauge).

## Global Constraints

- Keep brand colors: background `#0d0e14`, blue `#4361ee`, orange `#f77f00`. Orange is used only for laps and reference marks.
- No new npm dependencies. Primitives are hand-rolled with Tailwind and lucide-react.
- No feature removed. Every relocated control stays reachable in ≤ 2 clicks.
- Fonts: system stack only (values in Task 1). Remove the Google Fonts `<link>`s. Monospace only for chart axes, timestamps, time pills and formula text.
- Must look right on macOS and Windows. Keep the native window chrome. Don't show ⌘-only glyphs in Phase 1. Shortcut display is Phase 2.
- Primary (`--foreground`) and secondary (`--muted-foreground`) text must meet WCAG AA on every surface in both themes. The Task 1 values do (dark 6.3–8.2:1, light 5.5–6.4:1 for secondary).
- Labels are title case ("Pack Voltage"), not all caps. The only exception is the sidebar section captions, which stay small caps-style.
- Baseline before starting: `npx vitest run` → 351 passed. `npx tsc` → exit 0. Both must hold after every task. Tests changed by a task are listed in it.

## Review Focus

1. **Sessions with missing or bad dates.** `recorded_at` is null or unparseable → falls back to `created_at`. If both are bad, the session goes under "Earlier" and never crashes or disappears (Task 5 test).
2. **Channel names that don't group.** No underscore, a leading underscore, or a prefix used only once → goes under "Other". An active channel inside a collapsed group still shows in the pinned Active section. Searching expands every group that has matches (Task 7 tests).
3. **Many laps fully zoomed out.** 31+ lap markers in 300 px → labels never overlap, the first visible label is always drawn, and every marker line still draws (Task 8 test).
4. **Header with sparse or "Unknown" metadata and very long names.** The subtitle omits Unknown and empty parts and never renders stray " · " separators. Long names truncate instead of pushing Chart/Table off-center (Task 6 test).
5. **Live view in edit mode while disconnected or erroring.** The connection status and Connect/Retry stay visible in the edit header, and the offline notice and editing coexist (Task 10 test).

---

### Task 1: Tokens and system fonts

**Files:**
- Modify: `client/src/index.css` (token blocks, body font, base styles)
- Modify: `tailwind.config.ts` (fontFamily, new colors)
- Modify: `client/index.html` (remove Google Fonts links)
- Create: `client/src/lib/fonts.ts`
- Modify: `client/src/lib/chart-utils.ts:97` (`MONO_FONT`), `client/src/lib/chart-export.ts:64` (`MONO`), `client/src/components/analysis/HistogramTab.tsx:58-71`, `client/src/components/analysis/XYPlotTab.tsx:108-122`
- Test: `client/src/lib/fonts.test.ts`

**Interfaces:**
- Produces: `UI_FONT`, `DISPLAY_FONT`, `MONO_FONT` string constants from `lib/fonts.ts`. `chart-utils.ts` re-exports `MONO_FONT` from it, so existing importers are unchanged.
- Produces Tailwind colors: `canvas`, `surface-1`…`surface-4`, `label-3`, `label-4`, `success`, `warning`, `danger`, `separator`. Produces `font-display` and `font-mono`.

- [ ] **Step 1: Write the failing test** `client/src/lib/fonts.test.ts`:
  - `it('uses the system font stacks')`: `UI_FONT` starts with `-apple-system, BlinkMacSystemFont, "SF Pro Text"` and contains `"Segoe UI Variable Text"`. `MONO_FONT` starts with `ui-monospace, "SF Mono"` and contains `"Cascadia Mono"`.
  - `it('does not load web fonts')`: read `client/index.html` with `fs` and expect it not to contain `fonts.googleapis`. Read `index.css` and expect no `DM Sans` and no `JetBrains`.
  - `it('re-exports MONO_FONT from chart-utils')`: `import { MONO_FONT as C } from './chart-utils'` → `C === MONO_FONT`.
- [ ] **Step 2:** `npx vitest run client/src/lib/fonts.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.**
  - `lib/fonts.ts`, exact values:
    ```ts
    export const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
    export const DISPLAY_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
    export const MONO_FONT = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace';
    ```
  - `chart-utils.ts`: replace the literal with `export { MONO_FONT } from './fonts'` (and import it for local use).
  - `chart-export.ts`: `const MONO = MONO_FONT`.
  - Plotly: Histogram and XY use `MONO_FONT` / `UI_FONT` in place of `'JetBrains Mono'` / `'DM Sans'`.
  - `index.css`: replace the `:root`, `.dark` and `.light` blocks with one dark block on `:root, .dark` and one `.light` override, using these HSL triplets:

    | token | dark | light |
    |---|---|---|
    | `--background` | `231 21% 6%` | `240 11% 96%` |
    | `--canvas` | `231 21% 6%` | `0 0% 100%` |
    | `--card` = `--surface-1` | `228 21% 9%` | `240 33% 99%` |
    | `--popover` = `--surface-2` | `227 21% 13%` | `0 0% 100%` |
    | `--muted` = `--secondary` = `--input` = `--surface-3` | `227 21% 17%` | `240 12% 93%` |
    | `--surface-4` | `226 20% 22%` | `240 9% 89%` |
    | `--foreground` (+ all `*-foreground` text tokens) | `223 23% 94%` | `240 3% 12%` |
    | `--muted-foreground` = `--secondary-foreground` | `224 14% 68%` | `240 4% 38%` |
    | `--label-3` | `224 11% 49%` | `240 2% 54%` |
    | `--label-4` | `225 14% 34%` | `240 4% 77%` |
    | `--primary` = `--ring` | `229 83% 60%` | `230 74% 54%` |
    | `--accent` (orange) | `31 100% 48%` | `29 100% 39%` |
    | `--success` | `135 64% 50%` | `140 67% 37%` |
    | `--warning` | `36 100% 63%` | `36 100% 36%` |
    | `--danger` = `--destructive` | `3 100% 69%` | `354 100% 42%` |
    | `--border` | `227 18% 19%` | `240 8% 88%` |
    | `--separator` (raw color, not a triplet) | `rgba(255,255,255,0.07)` | `rgba(0,0,0,0.08)` |

    `--primary-foreground` / `--accent-foreground` stay white. Keep every existing `--chart-*` canvas variable with its current values, except:
    - `--chart-text`: `#7b8296` dark / `#86868b` light.
    - `--chart-grid`: `rgba(255,255,255,0.045)` dark / `rgba(0,0,0,0.06)` light.
  - `--radius: 0.5rem` stays.
  - `body`:
    - `font-family: var(--font-ui)` with `--font-ui`, `--font-display` and `--font-mono` defined on `:root` from the same strings as `fonts.ts`.
    - Fixed `font-size: 13px`, `letter-spacing: -0.006em`.
    - Keep `.tabular`.
    - Add `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; } }`.
  - `tailwind.config.ts`:
    - `fontFamily.sans` = the UI stack, plus `display` and `mono`, each as arrays split from the strings above.
    - Colors: `canvas`, `surface-1..4`, `label-3`, `label-4`, `success`, `warning`, `danger` as `hsl(var(--x))`, and `separator: 'var(--separator)'`.
  - `index.html`: delete the three Google Fonts lines and their comment.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: all pass (352+), tsc exit 0.
- [ ] **Step 5: Commit** `feat(ui): Apple-style design tokens and system font stack`

### Task 2: Gauge logo, app icon and favicon

**Files:**
- Create: `build/icon.svg`, `scripts/render-icon.cjs`
- Modify: `build/icon.png` (regenerated, 1024×1024), `client/public/favicon.svg`, `client/src/components/QuickScopeLogo.tsx`
- Test: `client/src/components/simple-components.test.tsx` (add a `QuickScopeLogo` describe)

**Interfaces:**
- Produces: `QuickScopeLogo({ size = 20, showWordmark = true }: { size?: number; showWordmark?: boolean })`. The existing `textClass` prop is removed, so update its two call sites (`SessionHeader`, `SessionBrowser`).
- Produces: `GaugeGlyph({ size, mono }: { size: number; mono?: boolean })`, exported from the same file for reuse.

- [ ] **Step 1: Write the failing test.** `it('renders the gauge mark with an accessible name and the wordmark')`: render `<QuickScopeLogo />` → `getByRole('img', { name: 'QuickScope' })` exists, its SVG contains a `circle` with `fill="#f77f00"`, and text `QuickScope` is present. Render `<QuickScopeLogo showWordmark={false} />` → no `QuickScope` text node, but the role=img is still there.
- [ ] **Step 2:** `npx vitest run client/src/components/simple-components.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Geometry in a 100-unit box (from `logo-v3.html`, `gauge`):
  - Center (50,53), r 28, stroke 9, round caps.
  - Track arc 135°→405° drawn in `hsl(var(--label-4))`.
  - Value arc 135°→330° with a linear gradient `#7f95ff → #4361ee (55%) → #3048c9`.
  - Orange tip dot r 7 `#f77f00` at the 330° point.
  - Inner trace `M36 60 L43 60 L47 49 L53 67 L57 55 L64 55`, stroke 4.5, in `currentColor`.

  Compute the arc endpoints with a small helper in the file, not hand-typed numbers. `mono` renders every stroke and fill in `currentColor`, with the track at opacity .3. Gradient ids must be unique per instance (`useId`).

  The wordmark is `<span className="font-display font-semibold tracking-tight text-[14px]">QuickScope</span>`.

  `build/icon.svg` (1024 viewBox):
  - Apple superellipse tile (n = 5) with fill gradient `#242a42 → #151827 (50%) → #0b0c13`, top to bottom.
  - Radial highlight at (30%, 18%), white at .13 → 0.
  - A 0.5%-wide inner rim stroke `rgba(255,255,255,.14)`.
  - Glyph scaled to 86% of the tile and centered. The trace is `#eef1ff`; the track is `rgba(255,255,255,.13)`.

  `client/public/favicon.svg` is the same tile SVG.

  `scripts/render-icon.cjs` is an Electron script: an offscreen `BrowserWindow` 1024×1024 with a transparent background loads `build/icon.svg` and writes `capturePage().toPNG()` to `build/icon.png`. Run it with `npx electron scripts/render-icon.cjs`.
- [ ] **Step 4:** `npx electron scripts/render-icon.cjs`, then open `build/icon.png` (expect 1024×1024 with transparent corners). Then `npx vitest run && npx tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(brand): Gauge logo, app icon and favicon`

### Task 3: UI primitives

**Files:**
- Create: `client/src/components/ui/Button.tsx`, `ui/SegmentedControl.tsx`, `ui/Menu.tsx`, `ui/Sheet.tsx`, `ui/useDismiss.ts`
- Test: `client/src/components/ui/ui-primitives.test.tsx`

**Interfaces (produces):**
- `Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'tinted' | 'plain' | 'danger'; size?: 'sm' | 'md' | 'lg' })`. Heights: sm 24, md 28, lg 32 px; radius 7 px; text 13 px / 500. Default variant `secondary`.
- `IconButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean })`: 28×28, radius 6, sets both `aria-label` and `title` to `label`. When `active`, `aria-pressed` is true and the style is blue-tinted.
- `SegmentedControl<T extends string>({ value, options, onChange, size, ariaLabel }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md'; ariaLabel: string })`. Renders `role="radiogroup"` with `role="radio"` buttons carrying `aria-checked`. Arrow Left/Right moves the selection. The selected segment is `bg-popover` (light) / `bg-surface-4` (dark) with a shadow.
- `useDismiss(ref: RefObject<HTMLElement>, onDismiss: () => void, enabled = true)`: calls `onDismiss` on a mousedown outside `ref` and on Escape.
- `Menu({ items, onClose, className, style }: { items: MenuEntry[]; onClose: () => void; className?: string; style?: CSSProperties })`, where `type MenuEntry = { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean } | 'separator'`.
  - Renders `role="menu"` with `role="menuitem"` entries. Selecting an item calls `onSelect` then `onClose`.
  - Arrow Up/Down moves focus, Enter selects, and it uses `useDismiss`.
  - The highlighted item is `bg-primary text-white`.
- `MenuButton({ label, icon, items, align }: { label: string; icon: ReactNode; items: MenuEntry[]; align?: 'left' | 'right' })`: an IconButton that toggles a `Menu` below it.
- `ContextMenu({ x, y, items, onClose })`: a `Menu` fixed at the client coordinates, clamped inside the viewport.
- `Sheet({ title, subtitle, onClose, footer, width = 520, children, closeOnBackdrop = true }: {...; width?: number })`:
  - Fixed backdrop `bg-black/30` (light) / `bg-black/45` (dark), with the panel near the top (`pt-[10vh]`).
  - Panel `bg-popover rounded-[14px] shadow-2xl`.
  - Header has the title (15 px / 600, display font) and an optional subtitle (`text-muted-foreground`).
  - The body scrolls; the footer is right-aligned.
  - Escape closes. A backdrop click closes when `closeOnBackdrop` is true; clicks inside never do.
  - `role="dialog" aria-modal="true" aria-label={title}`.
  - Focus moves into the panel on mount, Tab is trapped inside, and focus returns to the previously focused element on unmount.

- [ ] **Step 1: Write the failing tests** in `ui-primitives.test.tsx`:
  - `SegmentedControl` marks the value radio as `aria-checked=true`. Clicking another calls `onChange` with its value. ArrowRight from the last option wraps to the first.
  - `Menu` calls `onSelect` then `onClose`. ArrowDown + Enter selects the second item. Escape calls `onClose`. `'separator'` renders `role="separator"`. A disabled item doesn't fire.
  - `ContextMenu` at x = 10000 is clamped so `style.left` is ≤ `window.innerWidth`.
  - `Sheet`: Escape and backdrop close it. A click inside doesn't close it. It has `role=dialog` with the title as its name. After mount, `document.activeElement` is inside the panel. Tab from the last focusable wraps to the first.
  - `IconButton` has `aria-label` and `title` equal to `label`, and `aria-pressed` when active.
- [ ] **Step 2:** `npx vitest run client/src/components/ui`. Expected: FAIL.
- [ ] **Step 3:** Implement the files per the Interfaces above.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(ui): Button, SegmentedControl, Menu and Sheet primitives`

### Task 4: Move dialogs onto Sheet

**Files:**
- Modify: `client/src/components/SettingsDialog.tsx`, `ExportDialog.tsx`, `ImageExportDialog.tsx`, `SessionInfoModal.tsx`, `DerivedChannelDialog.tsx`, `AimSessionPicker.tsx`, `live/WidgetConfigDialog.tsx`
- Test: existing `simple-components.test.tsx`, `session-panels.test.tsx`, `DerivedChannelDialog.test.tsx`, `AimSessionPicker.test.tsx`, `live/live-components.test.tsx` (must pass unchanged except where noted)

**Interfaces:**
- Consumes: `Sheet` and `Button` from Task 3.
- Produces: `SessionInfoModal` gains a required prop `totalSamples: number`, shown as a "Samples" row (`toLocaleString()`). Task 6 relies on this.

- [ ] **Step 1:** Add `it('shows the sample count')` to the SessionInfoModal describe in `simple-components.test.tsx`: render with `totalSamples={6141017}`, then `getByText('6,141,017')`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement.** In each dialog, replace the hand-rolled `fixed inset-0` backdrop, Escape handling and outer panel with `<Sheet title=… subtitle=… footer=…>`. Keep every field, label text and handler.
  - Footer buttons use `Button` (primary for the confirming action, plain for Cancel). Keep the existing button labels (for example "Update Channel", "Download 1", "Cancel") because tests query them.
  - Widths: Derived 640, AimSessionPicker 640, ImageExport 760, others 520.
  - Replace hardcoded `emerald-*`, `red-*` and `amber-*` text and background classes with `text-success` / `text-danger` / `text-warning` and `bg-*/10` tints.
  - Pass `totalSamples={session.totalSamples}` from `App.tsx`.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: all pass. If a test queried the old ✕ close button by role or title, keep an `IconButton label="Close"` in the Sheet header (Sheet renders it when `onClose` is set) so queries by title `Close` still work.
- [ ] **Step 5: Commit** `refactor(ui): dialogs share the Sheet shell`

### Task 5: Sessions screen

**Files:**
- Create: `client/src/lib/session-groups.ts`, `client/src/components/sessions/SessionRow.tsx`, `sessions/AimStatusChip.tsx`, `sessions/ActivitySheet.tsx`
- Modify: `client/src/components/SessionBrowser.tsx` (shrinks to state + layout)
- Test: `client/src/lib/session-groups.test.ts`, update `SessionBrowser.test.tsx`, `SessionBrowser.rename.test.tsx`

**Interfaces:**
- Produces: `groupSessionsByDate<T extends { recorded_at: string | null; created_at: string }>(sessions: T[], now: Date): { label: string; sessions: T[] }[]`.
  - The date is `recorded_at` if it parses, else `created_at`, else invalid.
  - Groups in order: `Today` (same local calendar day), `This Week` (the previous 6 local days), then one group per month labelled `October 2026`, newest first. Invalid dates go last under `Earlier`.
  - Sessions within a group are sorted newest first. Empty groups are omitted.
- Produces: `AimStatusChip({ status, onPull, onOpenLive, onRecheck, onOpenSettings }: { status: AimStatus | null; onPull: () => void; onOpenLive: () => void; onRecheck: () => void; onOpenSettings: () => void })`.
  - Chip text: `device_name` or `AiM connected`, or `No AiM device`.
  - Dot uses `bg-success` when connected, `bg-label-3` otherwise.
  - Click opens a popover with a status headline, a one-line hint ("Join the logger's Wi-Fi (AiM-EVO5…)" when disconnected), and Menu items `Pull Sessions…`, `Open Live View`, separator, `Search Again`, `Network Settings…`.
- Produces: `ActivitySheet({ onClose }: { onClose: () => void })`, which moves the existing Activity log table, its tabs and refresh out of SessionBrowser unchanged, inside a `Sheet` titled `Activity`.
- Produces: `SessionRow({ session, loading, renaming, renameValue, onOpen, onStartRename, onRenameChange, onRenameSubmit, onRenameCancel, onDelete })`.
  - Thumbnail 48 px in a 9 px-radius well.
  - Line 1: name (14 px / 500). Line 2 (`text-muted-foreground` 12 px): `[track] · [driver] · [vehicle] · [date]`, with empty parts skipped.
  - Right side: duration (tabular, `text-foreground`), laps, and a source icon with its title.
  - Then `IconButton label="More actions"` (visible on hover or focus) opening a Menu: `Open`, `Rename`, separator, `Delete` (danger). `onContextMenu` opens the same items in a `ContextMenu`.
  - The track pill is removed. The track goes in line 2.

- [ ] **Step 1: Write the failing tests.**
  - `session-groups.test.ts`, with `now = new Date(2026, 9, 29, 21, 0)`:
    - (a) a 2026-10-29 session → `Today`; 2026-10-25 → `This Week`; 2026-10-09 → `October 2026`; 2026-06-06 → `June 2026`. Group order is exactly that.
    - (b) `recorded_at: null` uses `created_at`.
    - (c) `recorded_at: 'garbage'` and `created_at: 'garbage'` → `Earlier`, last.
    - (d) newest first within a group.
    - (e) `[]` → `[]`.
  - Update `SessionBrowser.test.tsx`:
    - Placeholder `Search sessions…` → `Search`.
    - Session count `getByText('7 sessions')` → `getByLabelText('7 sessions')` (count rendered next to the title as `<span aria-label="7 sessions">7</span>`). Same for `0 sessions` and `2 sessions`.
    - `getByText('Pull from AiM')` → open the chip (`getByRole('button', { name: /AiM/ })`), then `getByRole('menuitem', { name: 'Pull Sessions…' })`. `Live` → menuitem `Open Live View`.
    - `Activity` → open `getByRole('button', { name: 'More' })`, then menuitem `Activity`.
    - `getByTitle('Delete')` / `getByTitle('Rename')` → click `More actions` on the row, then the menuitem.
    - `dismiss` → `getByRole('button', { name: 'Dismiss' })`.
  - Add `it('opens the row menu on right-click')` (`fireEvent.contextMenu(row)` → menuitem `Rename` visible) and `it('groups sessions under date headings')` (fixture dates produce the headings in order).
- [ ] **Step 2:** `npx vitest run client/src/lib/session-groups.test.ts client/src/components/SessionBrowser*`. Expected: FAIL.
- [ ] **Step 3: Implement.** SessionBrowser layout:
  - Header (52 px, `bg-card`, separator bottom): `QuickScopeLogo`, spacer, `AimStatusChip`, then `MenuButton label="More"` (items: `Activity`, `Settings…`), then ThemeToggle.
  - Scroll body (`px-10 py-8`, content `max-w-[1080px] mx-auto`):
    - Title row: `h1` "Sessions" (28 px / 700, `font-display`, tracking −0.022em), then the count (17 px, `text-label-3`), spacer, a search field (250 px, `bg-muted`, radius 7), and `Button variant="primary" size="lg"` "Import" with a Plus icon.
    - Then the status strip.
    - Then the groups: an `h2` 13 px / 600 `text-muted-foreground`, and a `bg-popover rounded-xl` list with 0.5 px separators inset 74 px.
  - Status strip: a single slim row that shows the upload progress (existing text and bar) or the error (text + `Dismiss` button), never both. It replaces the two banners.
  - The footer is removed.
  - Remove the `hsl(225,…)` literals.
  - Empty and no-match states use the same copy as today.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(sessions): grouped list, AiM status chip, row menus`

### Task 6: Analysis header

**Files:**
- Modify: `client/src/components/SessionHeader.tsx`, `client/src/App.tsx` (props)
- Create: `client/src/lib/session-subtitle.ts`
- Test: `client/src/lib/session-subtitle.test.ts`, update the SessionHeader describe in `simple-components.test.tsx`

**Interfaces:**
- Produces: `sessionSubtitle(meta: { vehicle: string; date: string; time: string; venue: string }, durationMs: number, lapCount: number): string`.
  - Joins the non-empty, non-`Unknown` parts with ` · ` in this order: vehicle, `date at time` (just date if time is Unknown), `formatTime(durationMs)`, `N laps` (only if > 0), venue.
- SessionHeader props: remove `totalSamples`; the rest are unchanged.
- Layout (52 px):
  - Left: back `IconButton label="Back to sessions"`, left-panel `IconButton label="Show channels"/"Hide channels" active={leftOpen}`, then a title button (session file name 13.5 px / 600 display font, plus the subtitle 11.5 px `text-muted-foreground`, both `truncate`, `max-w-[40%]`). Clicking it calls `onSessionInfoOpen`.
  - Center: absolutely centered `SegmentedControl ariaLabel="View" options Chart/Table`.
  - Right: `MenuButton label="Export"` with items `Open…`, `Export CSV…`, `Get Info`; then ThemeToggle; then right-panel `IconButton label="Show analysis"/"Hide analysis" active={rightOpen}`.
  - The metadata pills, sample count, filename pill and ⋮ menu are removed.

- [ ] **Step 1: Write the failing tests.**
  - `session-subtitle.test.ts`: full metadata → `'CT16-EV · Oct 22, 2026 at 8:19 PM · 43:59.022 · 31 laps · Standardized'`. Feed date `'Oct 22, 2026'` and time `'8:19 PM'` as stored strings, and use whatever `formatTime(2639022)` returns so the test calls `formatTime` itself. All parts `Unknown`, 0 laps → only the duration, with no leading or trailing separator. Time `Unknown` → date only.
  - Update the header tests:
    - `'shows file name, metadata…, sample count'` → assert the file name and the `sessionSubtitle` output, and assert no samples text.
    - `'opens the menu for export and session info'` → `Export` button, then menuitems `Export CSV…` and `Get Info`.
    - The Chart/Table toggle is queried by `getByRole('radio', { name: 'Table' })`.
    - Add `it('opens session info from the title')`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces. In `App.tsx`, stop passing `totalSamples` to the header.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(analysis): single-line header with centered Chart/Table`

### Task 7: Channel sidebar

**Files:**
- Create: `client/src/lib/channel-groups.ts`
- Modify: `client/src/components/ChannelSidebar.tsx`, `client/src/App.tsx` (stop passing chart-mode props)
- Test: `client/src/lib/channel-groups.test.ts`, update the ChannelSidebar tests in `session-panels.test.tsx`

**Interfaces:**
- Produces: `groupChannelsByPrefix<T extends { shortName: string }>(channels: T[]): { name: string; channels: T[] }[]`.
  - The key is the text before the first `_` when that text is non-empty, compared case-insensitively. The display name is the first-seen casing.
  - Keys with ≥ 2 channels become groups, sorted alphabetically. Everything else goes under a final `Other` group (omitted if empty). Channels within a group keep their input order.
- Produces: `useCollapsedGroups(): { isCollapsed(name: string): boolean; toggle(name: string): void }`, persisted to localStorage `quickscope-channel-groups-open` as a JSON array of open group names.
  - Groups are collapsed by default. Reads and writes are wrapped in try/catch.
- ChannelSidebar props: remove `chartMode` and `onChartModeChange`; the rest are unchanged.
- Layout:
  - Search field on top (placeholder `Filter N channels`), then the `Has data` toggle as a small plain toggle button with the same label.
  - Section `Active · N` with an `IconButton label="Create derived channel"`: rows (swatch filled with the channel color, name, unit; ✕ on hover `title="Remove"`). This replaces the bottom chip cloud. It's hidden when nothing is active.
  - Then `Derived` (if any, existing edit/remove actions).
  - Then the prefix groups, each a collapsible header (caret, caption 11 px / 600 `text-label-3`, count).
  - Channel rows are 26 px, radius 6, with a 9 px round swatch (outline `label-4` when inactive). The row title is `"{sampleCount} pts · {rate} Hz"` (the hover tooltip), and the visible pts/Hz columns are removed.
  - While the search is non-empty, every group with matches renders expanded regardless of its stored state.

- [ ] **Step 1: Write the failing tests.**
  - `channel-groups.test.ts`:
    - `['BMS_A','BMS_B','APPS_X','APPS_Y','Speed','_hidden','Cell_1']` → groups `APPS`(2), `BMS`(2), `Other`(`Speed`, `_hidden`, `Cell_1`).
    - `['bms_a','BMS_b']` → one group named `bms`.
    - `[]` → `[]`.
  - Update `session-panels.test.tsx` ChannelSidebar tests:
    - `'shows active chips'` → active channels appear under the `Active` section, and the ✕ (`title="Remove"`) toggles them off.
    - `'wires search, has-data, chart-mode and create controls'` → drop the chart-mode assertions.
    - `'lists … sample counts, rates'` → assert via each row's `title`.
  - Add `it('expands groups that match the search')` and `it('remembers collapsed groups')` (toggle a group, unmount, remount → same state).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces. `useCollapsedGroups` can live in `channel-groups.ts` or a sibling `useCollapsedGroups.ts`.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(analysis): pinned active channels and grouped channel list`

### Task 8: Chart toolbar and lap-label thinning

**Files:**
- Modify: `client/src/lib/chart-utils.ts` (add helper), `client/src/lib/chart-draw.ts:163-172`, `client/src/components/TelemetryChart.tsx:776-822`, `client/src/App.tsx`
- Test: `client/src/lib/chart-utils.test.ts`, `client/src/components/TelemetryChart.test.tsx`

**Interfaces:**
- Produces: `thinLapLabels(xs: number[], minGapPx = 30): boolean[]`. The input is the x positions of visible laps in ascending order. It returns which labels to draw: the first is always true, then a label is drawn only if it's ≥ `minGapPx` from the last drawn label.
- `TelemetryChart` gains the prop `onChartModeChange: (mode: ChartMode) => void`. App passes `setChartMode`.
- Toolbar (42 px, separator bottom, `bg-canvas`):
  - Left: the range text in `font-mono` 12 px `text-muted-foreground`.
  - Right: `SegmentedControl size="sm" ariaLabel="Chart layout"` (Separate/Overlay), the `Δ Delta` toggle (keep `data-testid="delta-toggle"`, active style `bg-primary/15 text-primary`), `IconButton label="Save image"` (keep `data-testid="save-image"`), and Reset (keep `data-testid="reset-zoom"`).
  - The hint `<span>` is removed. A first-run tip replaces it: a dismissible pill under the toolbar, "Scroll to zoom · drag to pan · double-click to reset", with a `Got it` button, shown until dismissed (localStorage `quickscope-chart-tip-dismissed`, try/catch).
- The chart area background is `bg-canvas`. The lap label font becomes `10px MONO_FONT`.

- [ ] **Step 1: Write the failing tests.**
  - `chart-utils.test.ts`: `thinLapLabels([0,10,20,40,75,80])` → `[true,false,false,true,true,false]`. `thinLapLabels([])` → `[]`. 31 xs spread evenly over 300 px → no two `true` entries closer than 30, and the first is true.
  - `TelemetryChart.test.tsx`:
    - `it('switches chart layout from the toolbar')`: clicking radio `Overlay` calls `onChartModeChange('overlay')`.
    - `it('shows the first-run tip once')`: the tip is visible; `Got it` hides it; it stays hidden after remount.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. In `chart-draw.ts`, collect the visible laps' x positions, call `thinLapLabels`, and draw only the flagged labels. Marker lines are unchanged.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(chart): toolbar layout control, first-run tip, thinned lap labels`

### Task 9: Analysis panel, stats cards and table surfaces

**Files:**
- Modify: `client/src/components/AnalysisPanel.tsx`, `analysis/StatsTab.tsx`, `analysis/LapAnalysisTab.tsx`, `TableView.tsx`
- Test: update `analysis/analysis-tabs.test.tsx` and `TableView.test.tsx` only where tab labels changed

**Interfaces:**
- Tabs: `SegmentedControl size="sm" ariaLabel="Analysis"` with labels `Stats`, `Laps`, `Histogram`, `XY`, `GPS`, centered in a 10 px padded row. The tab ids are unchanged.
- Stats card:
  - `bg-popover rounded-[11px]`, no inner borders.
  - Header: 8 px channel-color dot, name 13 px / 600, unit `text-label-3`, pts right-aligned `text-label-3` 11 px.
  - Grid: caption 11 px / 500 `text-label-3`, value 17 px / 500 display font tabular, the `@ time` line in `font-mono` 11 px `text-label-3`.
  - The existing text (`@ 00:01.000`, `Jump to max …` titles) is unchanged.
- Laps: the best lap uses `border-accent/40 bg-accent/5 text-accent` (orange = laps) instead of primary.
- TableView: header `bg-card`, rows on `bg-canvas`, separators `border-separator`. No behavior change.

- [ ] **Step 1:** Update the tests that query `'XY Plot'` to `'XY'`. Add `it('marks the best lap in the accent color')`: the `Best` badge's lap card has a class containing `accent`.
- [ ] **Step 2:** Run. Expected: FAIL (label and class).
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(analysis): segmented tabs and calmer stats cards`

### Task 10: Live view

**Files:**
- Modify: `client/src/components/LiveView.tsx`, `live/widgets.tsx`, `live/LiveDashboard.tsx`, `live/ChannelPicker.tsx` (classes only), `client/src/App.tsx` (`onOpenSettings`)
- Test: `client/src/components/live/live-components.test.tsx`, new `client/src/components/LiveView.test.tsx`

**Interfaces:**
- `LiveView` gains the prop `onOpenSettings: () => void`. App passes `() => setSettingsOpen(true)` and renders `SettingsDialog` in the live branch too.
- One header (52 px), replacing the header and the action bar.
  - **View mode**, left to right:
    - back `IconButton label="Back to sessions"`
    - "Live" (15 px / 600 display font)
    - layout `<select>` restyled as a chip (`bg-muted rounded-[7px]`, `aria-label="Dashboard layout"`, same optgroups)
    - `Button variant="plain"` Edit (same title text)
    - `MenuButton label="More layout actions"` with items: `Pin Layout` / `Unpin Layout`, `Duplicate`, `Export to File`, `Import from File…`, and `Delete` (danger, only when not built-in)
    - spacer
    - the status (dot + text: `Streaming` / `Paused` / `Connecting` / `Reconnecting to logger…` / `Disconnected` / `Not connected`; device `model · vehicle` in `text-label-3` when known)
    - the action: `Connect` or `Retry` (`Button variant="tinted"`), or `Pause` / `Resume` (secondary) plus `Disconnect` (`variant="danger"`) when live
    - `Received N` moves to the status element's `title`.
  - **Edit mode**, left to right: back; the layout-name input (`aria-label="Layout name"`); the vehicle select (`aria-label="Vehicle"`); a "Built-in layouts are edited as a copy" caption when applicable; spacer; the same status + action as view mode; `Add Widget` (secondary); `Cancel` (plain); `Done` (primary, calls `saveDraft`).
- Banners: remove the `connecting` banner, since the header shows it. The idle banner text is unchanged, but append " You can still edit this layout." and a `Network Settings…` plain button calling `onOpenSettings`. On macOS (`navigator.platform` starts with `Mac`), the `error` banner appends "Check System Settings → Privacy & Security → Local Network for QuickScope." The other banners are unchanged, restyled as a full-width strip (`bg-card`, separator bottom; primary-tinted for editing).
- `widgets.tsx` tones:
  - `primary` and `muted` render the value in `text-foreground` with no border.
  - `emerald` → `text-success`.
  - `amber` → `text-warning` with the tile `bg-warning/10`.
  - `red` → `text-danger` with the tile `bg-danger/10`.
  - Bars: `primary` `bg-primary`, `emerald` `bg-success`, `amber` `bg-warning`, `red` `bg-danger`, `muted` `bg-label-4`.
  - Panels are `bg-popover rounded-[13px]` (light: plus `ring-[0.5px] ring-separator`), with the title 13 px / 600 display font in title case. Drop the `uppercase tracking-wider` classes.
  - Tiles are `bg-card` (light `bg-background`) radius 9, label 11 px / 500 `text-muted-foreground` (no uppercase), value 24 px / 500 display font tabular, unit 12 px `text-label-3`.
  - Stale values use `text-label-3`.
  - In editing mode, panels get `ring-[1.5px] ring-primary` plus a 4 px `ring-primary/15` halo, in place of the dashed outline (update the `.live-grid-editing` rule in `index.css`).

- [ ] **Step 1: Write the failing tests** `LiveView.test.tsx`. Mock `useLiveStream` the way `useLiveStream.test.tsx` does, with status `error` and no data. Assert:
  - (a) header text `Not connected`, and a `Retry` button exists.
  - (b) clicking `Edit` shows the `Layout name` input, `Done`, and `Retry` together.
  - (c) with status `idle`, the text `You can still edit this layout.` is present, and clicking `Network Settings…` calls `onOpenSettings`.
  - (d) the `More layout actions` menu lists `Export to File`.

  In `live-components.test.tsx` add: a stat tile with value ≥ `warn` has a class containing `bg-warning`, and a `primary`-tone tile's value has `text-foreground`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement per the Interfaces.
- [ ] **Step 4:** `npx vitest run && npx tsc`. Expected: pass.
- [ ] **Step 5: Commit** `feat(live): single header, offline-friendly notices, calmer widgets`

### Task 11: Cross-screen verification

**Files:**
- Modify: whatever the checks below turn up (no planned changes)
- Modify: `CONTEXT.md` "Style" fact (fonts, tokens, logo), `README.md` only if a screenshot or description is now wrong

- [ ] **Step 1:** `npx vitest run && npx tsc && npm run build`. Expected: all pass, build succeeds.
- [ ] **Step 2:** `grep -rnE "emerald-|red-[0-9]|amber-[0-9]|cyan-[0-9]|hsl\(225|JetBrains|DM Sans" client/src --include=*.tsx --include=*.ts | grep -v test`. Expected: no hits, except `chart-utils.ts` channel colors and `#22d3ee` delta tokens in `index.css`.
- [ ] **Step 3:** Start `./start.sh`, then capture all three screens in dark and light at 1280×800 and 1920×1080 (headless Chrome over CDP, as done during design). Compare against `redesign-v4.html` and list any visual differences. Fix real ones.
- [ ] **Step 4: Offline check.** With Wi-Fi off, launch `npm run electron:dev`. Confirm the fonts are SF (Web Inspector → Computed → font-family resolves). Open Live, enter Edit, add a widget, save. The layout persists after reload.
- [ ] **Step 5: Windows check.** Run the GitHub Actions Windows build (`npm run dist:win` on CI) or use a Windows machine. Confirm Segoe UI Variable renders, the title bar is native, and the icon shows in the taskbar. If no Windows machine is available, record that as an open item in the PR description, not as done.
- [ ] **Step 6: Commit** `chore(ui): phase 1 verification fixes` (only if changes were made), then hand off to superpowers:finishing-a-development-branch.

---

## Calls made in this plan (beyond the spec)

- The track/event pill is removed from session rows entirely. The track now always appears in the row subtitle, as in the approved mockup. The spec's "only when it varies" rule is dropped as unnecessary.
- The Sessions row menu omits "Session info", which needs a loaded session. Info stays available from the analysis header.
- Tooltip primitive and `lib/platform.ts` (⌘/Ctrl display) are deferred to Phase 2, where shortcuts exist. Phase 1 uses `title` attributes.
- Channel groups are collapsed by default, and search expands the matching ones.
- Analysis tab label "XY Plot" is shortened to "XY" to fit the 288 px default panel.
- The live channel picker keeps its existing tags ("Live now" / "Seen on EV" / "Built-in"). Per-channel "Seen Oct 27" dates need backend data and move to Phase 2.
- Icon PNG is rendered with an Electron offscreen script, since no SVG rasterizer is installed and Electron is already a dev dependency.
