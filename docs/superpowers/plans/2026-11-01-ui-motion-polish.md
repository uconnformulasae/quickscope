# UI & Motion Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QuickScope feel responsive and refined (press feedback, overlay enter/exit motion, sliding selection indicators, calmer Live chrome) without changing any feature, layout, or behavior.

**Architecture:** One CSS motion layer (tokens + utility classes + reduced-motion/transparency overrides) in `client/src/index.css`, plus one tiny React module `client/src/lib/motion.tsx` providing a `<Presence>` wrapper that delays unmount for exit animations. Components opt in by adding classes and wrapping conditional mounts in `<Presence>`; no logic changes.

**Tech Stack:** React 18, Tailwind v4, Vitest + Testing Library (jsdom for `*.test.tsx`), Electron.

**Spec:** `docs/superpowers/specs/2026-11-01-ui-motion-polish-design.md`

## Global Constraints

- **No commits.** User instruction: do not `git commit` anything (spec, plan, or code). Leave all changes in the working tree.
- No new runtime or dev dependencies.
- No feature/layout/behavior changes: every button, menu (including the ⋮ menus), pill, panel stays where it is and does the same thing.
- No emojis anywhere in UI; keep lucide icons.
- Never animate live data values (numbers, bars, gauges); no transitions on chart zoom/pan/cursor, typing, channel toggling.
- Do not rename visible text, `title`s, roles, or `data-testid`s.
- Existing tests pass unchanged: `npm run check` and `npm run test:client`.
- Motion tokens (exact): `--ease-out: cubic-bezier(.32,.72,0,1)`, `--ease-in-out: cubic-bezier(.65,0,.35,1)`, `--dur-press: 100ms`, `--dur-fast: 150ms`, `--dur-base: 220ms`, `--dur-panel: 280ms`. Exits ≈70% of enter. No overshoot.
- Press feedback: `transform: scale(.97)` on `:active`, `--dur-press` ease-out.
- Exit animations are skipped (instant unmount) when `window.matchMedia` is unavailable, `prefers-reduced-motion: reduce` matches, or `import.meta.env.MODE === 'test'`. (Last condition is a plan-level addition: `live-components.test.tsx` stubs `matchMedia` with `matches:false`, which would otherwise enable exits under test.)
- In-place swaps (status text, tab content) use **entrance-only** fades: the old node unmounts immediately, the new one fades in. Never two copies of the same text in the DOM.
- Everything must look right in dark (primary) and light mode.

## Review Focus

1. Reopening a dialog/menu while it is still playing its exit → it returns to open from where it is, one copy in the DOM, `onClose` not re-fired. (Test in Task 1.)
2. A dialog whose parent condition also depends on data that vanishes on close (e.g. `exportDialogOpen && session`) → the exiting copy renders the last element it was given and never re-renders with null props. (Test in Task 1.)
3. Clicking where a closing dialog/menu was → goes to the UI underneath; the exiting copy is `aria-hidden` and `pointer-events: none`, so its buttons can't fire. (Test in Task 1.)
4. macOS Reduce Motion on → no exit delay, no scale/slide, pulses static (warning stays red). (Test in Task 1 for delay; CSS checked in Task 8 manual pass.)
5. Live streaming → values update every frame with no added transition. (Grep check in Task 5.)

---

### Task 1: Motion foundation (tokens, utilities, `<Presence>`)

**Files:**
- Modify: `client/src/index.css` (append after the existing `@layer base` block; keep the react-grid-layout section, Task 5 edits it)
- Create: `client/src/lib/motion.tsx`
- Test: `client/src/lib/motion.test.tsx`

**Interfaces:**
- Produces (TS, `client/src/lib/motion.tsx`):
  - `export function prefersReducedMotion(): boolean` — true if `import.meta.env.MODE === 'test'`, `typeof window.matchMedia !== 'function'`, or `matchMedia('(prefers-reduced-motion: reduce)').matches`.
  - `export function Presence(props: { show: boolean; exitMs?: number; children: React.ReactNode }): JSX.Element | null` — `exitMs` default `150`. When `show` is true renders `<div data-presence="open" className="contents">{children}</div>` and caches `children`. When `show` flips false: if `prefersReducedMotion()` render null immediately; else render cached children in `<div data-presence="closing" aria-hidden="true" className="contents">` for `exitMs`, then null. If `show` returns true during closing, clear the timer and go back to `open` with the new children.
- Produces (CSS classes, all in `index.css`):
  - `:root` tokens listed in Global Constraints.
  - `.press` — press feedback (Global Constraints values), `transition: transform var(--dur-press) ease-out, background-color var(--dur-fast), color var(--dur-fast)`.
  - Global rule: `button:not(:disabled):active { transform: scale(.97) }` with the same transform transition on `button`; opt-out class `.no-press` sets `transform: none` on active. (Global so every button gets it without touching every file.)
  - `.qs-scrim` — fixed backdrop look: `background: rgb(0 0 0 / .55); backdrop-filter: blur(4px);` fades in (`--dur-base`, `--ease-out`).
  - `.qs-dialog` — enters from `opacity 0; transform: translateY(4px) scale(.96)` to rest over `--dur-base` `--ease-out`.
  - `.qs-menu` — enters from `opacity 0; scale(.95)` over `--dur-base`; `transform-origin` set by modifier `.qs-origin-tr` (top right) / `.qs-origin-tl` (top left).
  - Closing state: `[data-presence="closing"] .qs-scrim`, `.qs-dialog`, `.qs-menu` run the reverse over `--dur-fast` with `animation-fill-mode: forwards` and `pointer-events: none`.
  - `.qs-fade-in` — opacity 0→1, `--dur-fast`, `--ease-out` (entrance-only swaps).
  - `.qs-slide-in-left` / `.qs-slide-in-right` — opacity 0 + `translateX(∓8px)` → rest, `--dur-panel`, `--ease-out`.
  - `.qs-slide-down` — opacity 0 + `translateY(-4px)` → rest, `--dur-base` (banners).
  - `.qs-breathe` — opacity 1↔.45, 2.4s ease-in-out infinite.
  - `.qs-alert-pulse` — opacity 1 (held ~60% of cycle) → .35, 1s steps-ish via keyframes `0%,60%{opacity:1} 80%{opacity:.35} 100%{opacity:1}`, infinite.
  - `@media (prefers-reduced-motion: reduce)`: all `qs-*` animations → `animation: none` except `.qs-fade-in`, `.qs-dialog`, `.qs-menu`, `.qs-scrim` which become opacity-only at `--dur-fast`; button active transform none; `.qs-breathe`/`.qs-alert-pulse` static.
  - `@media (prefers-reduced-transparency: reduce)`: `.qs-scrim { backdrop-filter: none; background: rgb(0 0 0 / .7) }`.

- [ ] **Step 1: Write the failing tests** in `client/src/lib/motion.test.tsx` (first line `// @vitest-environment jsdom`, import `../test/dom-setup` is auto via setupFiles). Use `vi.useFakeTimers()` and `vi.stubEnv('MODE', 'development')` + `vi.stubGlobal('matchMedia', q => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){} }))` in a `beforeEach` for the animated cases; `vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers()` after.
  - `prefersReducedMotion returns true in test mode` — without env stub: `expect(prefersReducedMotion()).toBe(true)`.
  - `prefersReducedMotion honors the media query` — with env stubbed to development and matchMedia `matches: true` → `true`; `matches: false` → `false`.
  - `Presence keeps children mounted for exitMs after show turns false` — rerender `show={false}`; `getByText('Hi')` still present and its wrapper has `data-presence="closing"` and `aria-hidden="true"`; `act(() => vi.advanceTimersByTime(149))` still present; advance 1 more → `queryByText('Hi')` null.
  - `Presence renders the last children while closing` — rerender with `show={false}` and children `{null}` → `getByText('Hi')` still present.
  - `Presence reopens mid-exit with one copy` — show false, advance 50ms, show true with children `Hi2` → `getAllByText(/Hi/)` length 1, text `Hi2`, wrapper `data-presence="open"`; advance 500ms → still present.
  - `Presence unmounts immediately when reduced motion` — matchMedia `matches: true`, show false → `queryByText('Hi')` null without advancing timers.

- [ ] **Step 2: Run** `npx vitest run client/src/lib/motion.test.tsx` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `client/src/lib/motion.tsx`** per Interfaces (useState for phase + cached node in a ref; useEffect on `show` sets/clears a `setTimeout`). Add the CSS from Interfaces to `index.css`.

- [ ] **Step 4: Run** `npx vitest run client/src/lib/motion.test.tsx` — Expected: PASS. Then `npm run test:client` and `npm run check` — Expected: all pass (global button rule must not break anything).

- [ ] **Step 5: Audit `.no-press`.** Add `no-press` to buttons where a scale would look wrong: buttons that span a full row or column (session list action rows if any are `<button>`, `ChannelSidebar` channel rows if `<button>`, `TableView` header cells if `<button>`). Search: `grep -rn "<button" client/src/components | grep -E "w-full"` and judge each; menu items (`w-full` in menus) keep press. Re-run `npm run test:client` — PASS.

- [ ] **Step 6: Do not commit** (Global Constraints).

### Task 2: Dialogs — unified scrim/surface + exit via `<Presence>`

**Files:**
- Modify: `client/src/components/ExportDialog.tsx:141`, `SessionInfoModal.tsx:117`, `AimSessionPicker.tsx:201`, `ImageExportDialog.tsx:69`, `DerivedChannelDialog.tsx:186`, `SettingsDialog.tsx:56`, `live/WidgetConfigDialog.tsx:209` (backdrop + surface classes)
- Modify mount sites: `client/src/App.tsx` (SettingsDialog in browser view, DerivedChannelDialog, ExportDialog, SessionInfoModal), `SessionBrowser.tsx:685` (AimSessionPicker), `TelemetryChart.tsx:850` (ImageExportDialog), `LiveView.tsx:454` (WidgetConfigDialog)

**Interfaces:**
- Consumes: `Presence` from `client/src/lib/motion.tsx`; classes `.qs-scrim`, `.qs-dialog`.

- [ ] **Step 1: Backdrops.** In each of the 7 dialogs replace the backdrop's `bg-black/50|60` and `backdrop-blur-sm` with `qs-scrim` (keep `fixed inset-0 z-50 flex items-center justify-center` and every handler: `onClick`, `onMouseDown`, keyboard). Add `qs-dialog` to the dialog surface element (the direct child card). Keep each surface's own size/padding; unify radius to `rounded-xl` and shadow to `shadow-2xl` where they differ.

- [ ] **Step 2: Mount sites.** Wrap each conditional mount: `{cond && <X …/>}` → `<Presence show={!!cond}>{cond && <X …/>}</Presence>`. Keep the condition expression byte-identical.

- [ ] **Step 3: Run** `npm run test:client` and `npm run check` — Expected: PASS with no test edits.

- [ ] **Step 4: Manual check** (`npm run dev`, open http://localhost:5173 or `npm run electron:dev`): open/close each dialog by button, backdrop click, and Escape (Image export, Settings, AiM picker); reopen quickly mid-close. Each closes the same way as before; no double dialogs.

- [ ] **Step 5: Do not commit.**

### Task 3: ⋮ menus — origin-aware enter/exit

**Files:**
- Modify: `client/src/components/SessionHeader.tsx:166-195`
- Modify: `client/src/components/LiveView.tsx:343-368`

**Interfaces:**
- Consumes: `Presence`, `.qs-menu`, `.qs-origin-tr`, `.qs-origin-tl`.

- [ ] **Step 1:** SessionHeader: wrap the menu in `<Presence show={menuOpen}>`, add `qs-menu qs-origin-tr` to the menu div. Outside-click and item handlers unchanged.

- [ ] **Step 2:** LiveView: `<Presence show={menuOpen}>` around the fragment; add `qs-menu qs-origin-tl` to the `role="menu"` div. The full-screen click-catcher (`fixed inset-0 z-40`) must not catch clicks while closing — it inherits `pointer-events:none` only if it's covered by the closing rule, so add class `qs-menu-catcher` to it and include `[data-presence="closing"] .qs-menu-catcher { pointer-events: none }` in `index.css`.

- [ ] **Step 3: Run** `npm run test:client` — Expected: PASS, including `simple-components.test.tsx` "opens the menu for export and session info" and "closes the menu on an outside click" unchanged.

- [ ] **Step 4: Do not commit.**

### Task 4: Sliding selection indicators (Chart/Table, analysis tabs)

**Files:**
- Modify: `client/src/components/SessionHeader.tsx:97-122` (segmented control)
- Modify: `client/src/components/AnalysisPanel.tsx:56-110` (tab bar + content)

- [ ] **Step 1: Chart/Table.** Make the container `relative grid grid-cols-2`; add an `aria-hidden` thumb `<span>` absolutely positioned at `top/bottom/left: 2px`, width `calc(50% - 2px)`, `bg-primary rounded shadow-sm`, `transform: translateX(viewMode === 'table' ? '100%' : '0')`, `transition: transform 320ms var(--ease-out)`. Buttons: remove `bg-primary` from active state (keep `text-white` active / `text-muted-foreground hover:text-foreground` inactive), add `relative z-10 text-center`. Buttons keep text "Chart"/"Table" and `onClick`.

- [ ] **Step 2: Analysis tabs.** Tab bar `relative`; remove `border-b-2 border-primary` from active tab (keep `text-primary bg-primary/5`); add an `aria-hidden` indicator span: `absolute bottom-0 left-0 h-0.5 bg-primary`, width `${100 / TABS.length}%`, `transform: translateX(${activeIndex * 100}%)`, `transition: transform var(--dur-base) var(--ease-out)`. `activeIndex = TABS.findIndex(t => t.id === analysisTab)`.

- [ ] **Step 3: Tab content.** Wrap the content area's children in `<div key={analysisTab} className="qs-fade-in">` (entrance-only; old tab unmounts immediately as today).

- [ ] **Step 4: Run** `npm run test:client` — Expected: PASS (`analysis-tabs.test.tsx`, `simple-components.test.tsx` unchanged).

- [ ] **Step 5: Manual check:** click Chart↔Table rapidly — pill retargets mid-slide; tabs indicator slides; Plotly tabs (Histogram/XY) still size correctly after the fade.

- [ ] **Step 6: Do not commit.**

### Task 5: Live view chrome

**Files:**
- Modify: `client/src/components/LiveView.tsx:208-245` (status), `:250-330` (action bar), `:397` area (banners), edit-mode chrome
- Modify: `client/src/components/live/widgets.tsx:222` (warning light), `Panel` (~line 85)
- Modify: `client/src/index.css` (react-grid-layout section)

- [ ] **Step 1: Status crossfade.** Wrap the status `<div>`'s children in a single `<span key={statusKey} className="qs-fade-in flex items-center gap-1.5">` where `statusKey = reconnecting && status === 'streaming' ? 'reconnecting' : status`. Exactly one status label in the DOM at a time.

- [ ] **Step 2: Pulses.** Streaming dot: `animate-pulse` → `qs-breathe`. `widgets.tsx:222` warning: `animate-pulse` → `qs-alert-pulse` (keep `bg-red-500`).

- [ ] **Step 3: Banners and edit chrome.** Add `qs-slide-down` to the root of the `Banner` component. Add `qs-fade-in` to each top-level element in the `draft ? (…)` branch of the action bar (name input, vehicle select, Add widget / Cancel / Save buttons — a `display: contents` wrapper can't animate) and to the editing hint banner (line ~422).

- [ ] **Step 4: Grid drag/settle (CSS only)** in the react-grid-layout section of `index.css`:
  - `.react-grid-item.cssTransforms { transition: transform var(--dur-panel) var(--ease-out), width var(--dur-panel) var(--ease-out), height var(--dur-panel) var(--ease-out); }`
  - `.react-grid-item.react-draggable-dragging, .react-grid-item.resizing { transition: none; z-index: 3; }`
  - `.react-grid-item.react-draggable-dragging > section { transform: scale(1.02); box-shadow: 0 12px 32px rgb(0 0 0 / .35); transition: transform var(--dur-base) var(--ease-out), box-shadow var(--dur-base); }`
  - `.react-grid-item > section { transition: transform var(--dur-base) var(--ease-out), box-shadow var(--dur-base); }`
  - Placeholder: `opacity: .12; transition: transform var(--dur-fast) var(--ease-out);`
  - Reduced motion: `.react-grid-item.cssTransforms { transition: none }` and dragging section `transform: none`.

- [ ] **Step 5: Panels.** `Panel` in `widgets.tsx`: keep colors; make radius `rounded-xl`, padding `p-3` (unchanged), header label stays `text-[10px] uppercase tracking-wider`. No transitions on any value element.

- [ ] **Step 6: Verify no value animation:** `grep -nE "transition|animate|qs-" client/src/components/live/widgets.tsx client/src/components/live/WidgetRenderer.tsx` — Expected: only `CLICKABLE` (`transition-shadow`, pre-existing), `qs-alert-pulse`, `Panel` root (no transition), nothing on value/bar elements.

- [ ] **Step 7: Run** `npm run test:client` — Expected: PASS (`live-components.test.tsx` "Streaming" assertions unchanged).

- [ ] **Step 8: Manual check:** in Live (offline preview is fine) enter edit mode, drag and resize widgets — lift while dragging, smooth settle on drop; Connect → Connecting → status fades; Pause/Resume.

- [ ] **Step 9: Do not commit.**

### Task 6: Sidebar entrance

**Files:**
- Modify: `client/src/App.tsx:386-398` (left panel), `:518-524` (right panel)

- [ ] **Step 1:** Add `qs-slide-in-left` to the left sidebar container div (the one with `ref={leftPanelRef}`) and `qs-slide-in-right` to the right one. Close stays instant (width disappears in one reflow). Do not animate `width`. (Spec allowed builder's technique; entrance-only keeps Plotly to a single resize.)

- [ ] **Step 2: Manual check:** toggle both sidebars repeatedly with a log loaded and several channels — chart resizes once per toggle, no stutter. If it stutters, remove the classes and note it in the final summary (spec escape hatch).

- [ ] **Step 3: Run** `npm run test:client` — PASS.

- [ ] **Step 4: Do not commit.**

### Task 7: Header & small-type consistency

**Files:**
- Modify: `client/src/components/SessionHeader.tsx`, `SessionBrowser.tsx:250-330`, `LiveView.tsx:183-190`

- [ ] **Step 1:** Icon buttons in the three headers: same `p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50` and `transition-colors` (SessionHeader currently uses `p-1 rounded`). **Do not change header heights** (`h-10` analysis, `h-12` browser/live) — that's layout.
- [ ] **Step 2:** Action-bar buttons in `SessionBrowser` and `LiveView` already share `px-3 py-1.5 rounded-md text-xs font-medium`; extract nothing, just fix any outliers found by `grep -n "rounded " client/src/components/SessionHeader.tsx client/src/components/SessionBrowser.tsx client/src/components/LiveView.tsx`.
- [ ] **Step 3:** Top-bar translucency: **skip** — no content scrolls beneath these bars (they're flex siblings), so the spec's "only where content scrolls beneath" condition isn't met.
- [ ] **Step 4: Run** `npm run test:client` and `npm run check` — PASS.
- [ ] **Step 5: Do not commit.**

### Task 8: Final verification

- [ ] **Step 1:** `npm run check` — Expected: no errors. `npm run test:client` — Expected: all pass, and `git diff --stat -- '*.test.ts*'` shows only the new `client/src/lib/motion.test.tsx`.
- [ ] **Step 2:** `npm run electron:dev` (or `npm run dev`). Walk: browser → upload/open a log → Chart/Table, tabs, sidebars, ⋮ menu items (Load File, Export CSV, Session Info), Derived channel dialog, Image export → back → Live → edit mode → Settings. Every action behaves as before; light and dark mode both look right.
- [ ] **Step 3:** macOS System Settings → Accessibility → Display → Reduce motion ON: dialogs/menus fade only, no scale/slide, close instantly; pulses static; buttons don't scale. "Reduce transparency" ON: scrim not blurred.
- [ ] **Step 4:** Report to user: summary of changes, anything skipped (e.g. sidebar fallback), and that nothing was committed.
