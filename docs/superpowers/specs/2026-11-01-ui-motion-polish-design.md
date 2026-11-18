# QuickScope UI & Motion Polish — Design

Date: 2026-11-01
Branch: `appletest`
Reference: `.agents/skills/apple-design/SKILL.md` (Apple fluid-interface principles, translated for the web)

## Intent

Make QuickScope *feel* more refined — responsive, calm, consistent — using Apple's
design principles, without changing what the app does or where anything lives.
The team spends most of its time in **Live view** and the **analysis screen**
(a loaded log shown as charts / table / analysis tabs), so polish effort is
weighted there. Other screens get the shared primitives for consistency.

## Goals

1. **Instant press feedback** on every button: respond on pointer-down, not release.
2. **Overlays arrive and leave with motion that has a source**: dialogs and the ⋮
   menus ease in (and out) instead of popping; menus grow from their trigger.
3. **Consistency**: one shared treatment for dialogs (backdrop, surface, radius,
   shadow), buttons, and small type, replacing today's per-file variations.
4. **Live view feels calm and trustworthy**: smooth chrome around the data,
   gentler warning/streaming pulses, nicer widget drag/resize in edit mode.
5. **Analysis screen feels fluid**: analysis tab switching and sidebar
   open/close have motion; chart interaction stays exactly as immediate as today.
6. **Accessibility**: all motion honors `prefers-reduced-motion`; translucency
   honors `prefers-reduced-transparency`.

## Non-goals

- No new features, removed features, renamed actions, or changed behavior.
- No layout/structure changes. Every button, menu, pill, and panel stays where
  it is. **The analysis screen's ⋮ menu stays a menu** (user explicitly rejected
  surfacing its items as toolbar buttons).
- No redesign of colors/brand, logo, or theme system.
- No backend changes.

## Anti-goals (would be a failure even if it "works")

- **Hiding anything behind menus** or collapsing visible controls. The user
  values having Live and the other main actions visible at the top.
- **Emojis anywhere in the UI.** Keep the existing lucide line icons.
- **Animating live data values** (counting/tweening numbers, bars easing toward
  new values). Readings must reflect the latest sample immediately.
- **Any added latency on the input path**: chart zoom/pan/cursor, typing,
  channel toggling, keyboard actions must not wait on an animation.
- Motion that blocks input — every transition must be interruptible
  (e.g. reopening a closing dialog, toggling a sidebar mid-slide).
- Janky Plotly/chart re-layout every animation frame.
- Bouncy/overshooting motion on things that weren't flicked (menus, dialogs).

## Constraints

- Stack: React 18 + Tailwind v4 (`client/src/index.css` holds tokens),
  Electron, `tailwindcss-animate` already installed, lucide-react icons.
- **No new runtime dependencies** (builder's call: CSS transitions/keyframes and
  small React state are enough for non-gesture UI; no Motion/Framer library).
- All existing tests must pass unchanged: `npm run test:client`, `npm run check`.
  Tests query by text/role/testid — don't rename text, roles, titles, or
  `data-testid`s. If a test must change, it may only be because of an added
  wrapper element, never because behavior changed.
- Dark mode is primary; light mode must look right too.
- Users sit at normal laptop distance — no need to enlarge live readouts.

## The design

### 1. Motion tokens (shared)

Defined once in `client/src/index.css` as CSS custom properties / utilities:

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(.32,.72,0,1)` (iOS-like, critically damped feel) | enter/move |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | on-screen moves |
| `--dur-press` | `100ms` | press scale |
| `--dur-fast` | `150ms` | hover/color, menu exit |
| `--dur-base` | `220ms` | menu/dialog enter, tabs |
| `--dur-panel` | `280ms` | sidebars |

Exits are faster than enters (~70%). No overshoot anywhere.

### 2. Press feedback

A shared utility (e.g. `.press`) — `transform: scale(.97)` on `:active`,
`--dur-press` ease-out — applied to buttons: toolbar/action-bar buttons, icon
buttons, segmented controls, menu items, dialog buttons, Live
Connect/Pause/Disconnect, edit-mode buttons. Not applied to: chart canvas,
table rows, inputs, the live grid items themselves.

### 3. Overlays: dialogs and menus

Dialogs today (`ExportDialog`, `SessionInfoModal`, `AimSessionPicker`,
`ImageExportDialog`, `DerivedChannelDialog`, `SettingsDialog`,
`live/WidgetConfigDialog`) each hand-roll a `fixed inset-0` backdrop with
inconsistent opacity/blur.

- Unify backdrop: one scrim style (dim + light blur), fades in/out.
- Dialog surface: fades + scales from `0.96 → 1` and slight upward settle on
  enter; reverse, faster, on exit.
- Exit animation requires delaying unmount: implement a small shared hook or
  wrapper (e.g. `useExitTransition` / `<Overlay>`) that keeps the node mounted
  for the exit duration. Close callbacks (`onClose`) must fire exactly as today;
  the delay is purely visual (parent state can flip immediately; the wrapper
  handles the lingering exit). If reopening during exit, it reverses from the
  current state.
- Close behavior (backdrop click, Escape where it exists, buttons) unchanged.
- ⋮ menus (analysis `SessionHeader`, Live view's layout menu): scale+fade from
  the trigger corner (`transform-origin` matching where the menu is anchored:
  top-right for `SessionHeader`, top-left for the Live layout menu, which opens
  at `left-0`), `--dur-base` in, `--dur-fast` out.
- Dialogs are mounted conditionally in their parents (e.g.
  `exportDialogOpen && session && <ExportDialog/>` in `App.tsx`), so the exit
  wrapper lives at the parent call site and keeps the last props while exiting.
- **Exit animations are skipped (instant unmount) when `window.matchMedia` is
  unavailable or `prefers-reduced-motion: reduce` matches.** jsdom has no
  `matchMedia`, so existing tests that assert a menu disappears immediately
  (`simple-components.test.tsx`: "opens the menu for export and session info",
  "closes the menu on an outside click") keep passing unchanged. *(Decision:
  builder-check call — accepted trade-off is that exit motion isn't unit-tested.)*

### 4. Live view

- **Data stays raw**: no transitions on values, gauges, bars, or numbers.
- Status indicator (Connecting / Streaming / Reconnecting / Paused /
  Disconnected / Not connected): crossfade between states (~150ms opacity).
- Streaming dot: replace `animate-pulse` with a slower, subtler "breathing"
  (small opacity range). Warning lights in `widgets.tsx` (currently
  `animate-pulse` red): keep attention-grabbing but use a sharper, less
  "throbbing" pulse; both become static under reduced motion (warning stays red).
- Edit mode (react-grid-layout): dragged item lifts (shadow + slight scale
  ~1.02) while dragging; placeholder styled softly (already themed in
  `index.css`); items settle smoothly into place on drop. Enter/exit of edit mode
  chrome (banner, draft controls) fades rather than pops.
- Widget panels: consistent radius/border/padding; uppercase labels keep
  tracking; numbers keep `tabular` figures.
- Banners (connection messages) fade/slide in from top.

### 5. Analysis screen

- **Chart/Table segmented control** in `SessionHeader`: sliding highlight
  between the two options: a filled primary-color pill behind the active label
  that slides (transform + width) with `--ease-out` over ~320ms, retargetable
  mid-slide. Same shape/size as today's active button. (Reference mockup,
  local only: `.superpowers/brainstorm/27247-1793579104/content/analysis-toolbar.html`,
  "Proposed" section — only the segmented control from it applies; the toolbar
  buttons shown there were rejected.)
- **Analysis tabs** (`AnalysisPanel`): sliding active indicator; tab content
  crossfades quickly (≤150ms) — content swap must not delay rendering.
- **Sidebars** (channels left, analysis right): slide/fade open and closed.
  Must not trigger Plotly re-layout every frame. Approach left to builder
  (e.g. animate a transform/opacity overlay and change width once, or let the
  chart resize once at the end). If no approach is smooth, skip sidebar
  animation rather than ship jank — note this in the PR.
- Chart zoom/pan/cursor, channel toggling, table scrolling: untouched.
- Empty-state drop zone: drag-over highlight transitions smoothly (already
  partially does).

### 6. Type & surface consistency

- Small-text hierarchy: consistent sizes/weights for labels, secondary text,
  and pills across headers and panels; slight positive tracking on tiny
  uppercase labels, none on body.
- Headers (`SessionBrowser`, `SessionHeader`, `LiveView`): consistent height,
  padding, icon-button size and hover treatment.
- Optional subtle translucency on top bars (`backdrop-filter`) only where
  content actually scrolls beneath; otherwise skip.

### 7. Reduced motion / transparency

- `@media (prefers-reduced-motion: reduce)`: press scale off, slides/scales
  become short opacity fades, pulses become static.
- `@media (prefers-reduced-transparency: reduce)`: blur off, solid surfaces.

## Left to the builder

- Exact component boundaries for the shared overlay/press helpers.
- Precise per-element durations within the token ranges.
- Sidebar animation technique (with the "skip if janky" escape hatch).
- Session browser, settings, and other screens: apply shared primitives
  (press, overlays, consistency) but no bespoke work.

## Verification

- `npm run check` and `npm run test:client` pass.
- Manual pass in `npm run dev`/Electron: every button, menu, dialog, and Live
  control does the same thing as before; with macOS Reduce Motion on, nothing
  slides or scales.
- Live view with streaming (or offline preview): values update with no added
  lag.
