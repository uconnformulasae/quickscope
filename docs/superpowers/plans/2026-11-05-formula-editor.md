# Easier Formula Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people build derived (math) channels using plain-English channel names, recipes, and live preview, without knowing the logger's channel codes. Works for both EV and IC logs.

**Architecture:**
- A static channel dictionary maps raw codes to a label, description, category and role. Lookup is car-aware, with the car type inferred from the channel list.
- Formulas are still stored with raw codes. The editor shows a "display" form where channels appear as `[Friendly Label]`, and converts both ways losslessly.
- The engine gains bracket-quoted identifiers and position-aware friendly diagnostics.
- Recipes are data, filtered by the roles present in the session.

**Tech Stack:** React 18 + TypeScript + Tailwind, Vitest + Testing Library (jsdom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-formula-editor-design.md`

## Global Constraints

- Stored `DerivedChannel.expression` and live `ChannelRef.expr` keep raw codes. Existing formulas evaluate exactly as before.
- Unknown codes stay usable and display as their raw code.
- Never commit (standing user preference). Run `npx vitest run` and `npx tsc` instead.
- IC names come from `client/src/components/live/live-channels.ts` (`IC_ENGINE_STATS`, `IC_WHEEL_SPEEDS`, `IC_ENGINE_FLAGS`, `IC_BRAKE_TEMPS`, `IC_TIRE_TEMPS`, `FBrakePressCorr`) plus common generic IC names (`Lambda`, `OilPress`, `WaterTemp`, `FuelPress`, `Fuel Flow`, `Gear`, `MAP`, `IAT`).
- Role choices: `RBrakePressCorr` → `brake_pressure_rear`; `RBrakePressure` → "Rear Brake Pressure (raw)" with no role; `Pack_Current` → `pack_current`; `MCU_DC_Current` → "Inverter DC Current" with no pack role.

## Review Focus

1. **Two channels that share the same friendly label** (or a user rename that collides with another label). Each must still round-trip to its own code. Test in Task 2.
2. **A channel code with spaces or brackets**, like `GPS Speed`. It must be stored as `[GPS Speed]` and evaluate. Tests in Tasks 1 and 2.
3. **Expressions that reference a derived channel by its name**, which is not in the dictionary. They must display and round-trip unchanged. Test in Task 2.
4. **Editing an existing invalid or half-typed formula.** Converting it for display must not throw or lose text. Test in Task 2.
5. **`RPM` on an EV log.** It must be labeled "Motor RPM", and IC-only recipes must stay hidden. Tests in Tasks 2 and 3.

---

### Task 1: Engine — bracket identifiers and friendly diagnostics

**Files:**
- Modify: `client/src/lib/formula-engine.ts`
- Test: `client/src/lib/formula-engine.test.ts`

**Interfaces:**
- Produces:
  - Tokenizer accepts `[any chars except ]]` as an `ident` token whose value is the inner text. A bracketed ident is never treated as a function call or as `e`/`pi`.
  - `export interface FormulaProblem { message: string; start: number; end: number }`
  - `export function checkFormula(expr: string, isKnown: (name: string) => boolean): FormulaProblem | null`. It parses and checks function names and argument counts, and checks every channel ref with `isKnown`. It does not evaluate.
  - `export function formatChannelRef(code: string): string`. Returns `code` if it matches `/^[A-Za-z_][A-Za-z0-9_]*$/` and isn't a function name, otherwise `[code]`.
  - `export const FUNCTION_HELP: { name: string; signature: string; description: string }[]`, covering abs, sqrt, min, max, pow, sin, cos, tan, log, exp, round, floor, ceil, sign, diff, smooth, mavg, delay.

- [ ] Step 1: Write failing tests:
  - `evaluateFormula('[GPS Speed] * 2', {'GPS Speed': ch})` doubles the values.
  - `extractChannelNames('[GPS Speed] - Spd1')` equals `['GPS Speed','Spd1']`.
  - `formatChannelRef('GPS Speed') === '[GPS Speed]'`, `formatChannelRef('Spd1') === 'Spd1'`, `formatChannelRef('sqrt') === '[sqrt]'`.
  - `checkFormula` messages:
    - `'A B'` → `"Add an operator (+ − × ÷) between A and B"`
    - `'A -'` → `"Missing something after the '-'"`
    - `'(A'` → `"A '(' is never closed"`
    - `'Nope'` with isKnown=false → `"There's no channel called 'Nope' in this session"`, start 0, end 4
    - `'mavg(A)'` → message containing `"mavg(channel, milliseconds)"`
    - `'foo(A)'` → `"Unknown function 'foo'"`
    - valid `'A + 1'` → null
- [ ] Step 2: Run `npx vitest run client/src/lib/formula-engine.test.ts` and confirm the new tests fail.
- [ ] Step 3: Implement. Tokens carry `pos` and `end`. The parser throws an internal `ParseError` with a range, mapped to the friendly messages above. Existing `evaluateFormula` error strings stay unchanged.
- [ ] Step 4: Run the test file and confirm it passes.

### Task 2: Channel dictionary, car type, display↔stored conversion

**Files:**
- Create: `client/src/lib/channel-dictionary.ts`, `client/src/lib/channel-dictionary.test.ts`
- Create: `client/src/lib/formula-text.ts`, `client/src/lib/formula-text.test.ts`
- Modify: `client/src/lib/usePreferences.tsx` (add `channelLabels: Record<string,string>`, sanitized to a string map, default `{}`)

**Interfaces:**
- Produces (`channel-dictionary.ts`):
  - `export type CarType = 'ev' | 'ic' | 'unknown'`
  - `export type ChannelCategory = 'Driver Inputs' | 'Brakes' | 'Chassis & IMU' | 'GPS' | 'Battery' | 'Motor & Inverter' | 'Engine' | 'Fuel' | 'Temperatures' | 'Faults & Alarms' | 'Status' | 'Logger' | 'Other'`
  - `export interface ChannelInfo { code: string; label: string; description: string; category: ChannelCategory; role?: string; uncertain?: boolean; known: boolean }`
  - `export function inferCarType(codes: Iterable<string>): CarType`. EV if any of Pack_Voltage, Pack_Current, State_of_Charge, InverterEnable, Motor_Temp, Torque_Command is present. IC if any code starts with `S8_` or normalizes to lambda/oilpress/oiltemp/fuelpress/fuelflow/watertemp. Otherwise unknown.
  - `export function describeChannel(code: string, car: CarType, overrides?: Record<string,string>): ChannelInfo`. Lookup order: exact → normalized (lowercase, strip space, `_`, `-`) → pattern rules → unknown (label = code, category 'Other', known false). An override replaces the label and clears `uncertain`.
  - Roles used by recipes: `lat_accel`, `long_accel`, `brake_pressure_front`, `brake_pressure_rear`, `pack_voltage`, `pack_current`, `phase_current_a|b|c`, `motor_rpm`, `engine_rpm`, `lambda`, `fuel_flow`, `wheel_speed`, `gps_speed`.
- Produces (`formula-text.ts`):
  - `export interface LabelIndex { labelOf(code: string): string; codeOf(label: string): string | undefined }`
  - `export function buildLabelIndex(codes: string[], describe: (code: string) => ChannelInfo): LabelIndex`. Labels are made unique: a duplicate gets ` (code)` appended. `codeOf` is case-insensitive and also accepts a raw code.
  - `export function storedToDisplay(stored: string, idx: LabelIndex): string`. Every channel ref becomes `[label]`. Text the tokenizer can't read is returned unchanged.
  - `export function displayToStored(display: string, idx: LabelIndex): string`. Every `[x]` or bare ident that resolves to a code becomes `formatChannelRef(code)`. Unresolved refs are left as typed. Whitespace and operators are preserved.

- [ ] Step 1: Write failing tests:
  - `describeChannel('FBrakePressure','ev').label === 'Front Brake Pressure'`, with role `brake_pressure_front`.
  - `describeChannel('RBrakePressCorr','ev').role === 'brake_pressure_rear'`.
  - `describeChannel('RPM','ev').label === 'Motor RPM'` with role `motor_rpm`. `describeChannel('RPM','ic').role === 'engine_rpm'`. `describeChannel('RPM','unknown').role` is undefined.
  - `describeChannel('Channel01','ev').uncertain === true`.
  - `describeChannel('oil_press','ic').label === 'Oil Pressure'` (normalized match).
  - `describeChannel('Mystery','ev')` → `{label:'Mystery', known:false}`.
  - An override `{FBrakePressure:'Front Brakes'}` wins.
  - `inferCarType(['Pack_Voltage'])==='ev'`, `inferCarType(['S8_RPM'])==='ic'`, `inferCarType(['GPS Speed'])==='unknown'`.
  - Every code in the five repo sessions and in live-channels.ts returns `known: true`. The list is embedded as a fixture array in the test.
  - Formula-text round-trip: `displayToStored(storedToDisplay(s))===s` for `'FBrakePressure - RBrakePressCorr'`, `'[GPS Speed] * 0.621'`, `'MyDerived * 2'`, and `'Spd1 +'` (invalid, unchanged).
  - Two codes with the same label get distinct labels.
- [ ] Step 2: Run the tests and confirm they fail.
- [ ] Step 3: Implement. Write every entry by hand with honest descriptions.
- [ ] Step 4: Run the tests and confirm they pass. Also run `client/src/lib/usePreferences.test.tsx`.

### Task 3: Recipes

**Files:**
- Create: `client/src/lib/formula-recipes.ts`, `client/src/lib/formula-recipes.test.ts`

**Interfaces:**
- Consumes: `ChannelInfo`, `formatChannelRef`.
- Produces:
  - `export type RecipeSlot = { key: string; label: string } & ({ kind: 'channel'; role?: string } | { kind: 'number'; default: number; unit: string } | { kind: 'choice'; options: { value: string; label: string }[]; default: string })`
  - `export interface Recipe { id: string; title: string; blurb: string; requires: string[]; slots: RecipeSlot[]; build(v: Record<string,string>): { expression: string; name: string; units: string } }`. Channel slot values are raw codes; `build` uses `formatChannelRef`.
  - `export const RECIPES: Recipe[]`. The spec table: convert, difference, ratio, smooth (mavg ms, default 200), rate (diff), combined-g, brake-balance, battery-power, power-500ms, phase-current-avg, afr, fuel-flow-convert, gear-ratio.
  - `export function availableRecipes(channels: ChannelInfo[]): Recipe[]`. Keeps recipes whose every `requires` role is present.
  - `export function prefillSlots(r: Recipe, channels: ChannelInfo[]): Record<string,string>`. Channel slots take the first channel with a matching role, else empty; number and choice slots take their default.

- [ ] Step 1: Write failing tests:
  - An EV channel list includes `battery-power` and `brake-balance` and excludes `afr` and `gear-ratio`.
  - An IC list includes `afr` and `gear-ratio` and excludes `battery-power`.
  - An empty list contains exactly the five generic recipes.
  - `brake-balance` prefilled on EV builds `'FBrakePressure / (FBrakePressure + RBrakePressCorr) * 100'`.
  - `battery-power` builds `'Pack_Voltage * Pack_Current / 1000'` with units `kW`.
  - `convert` with value `kmh_mph` on `[GPS Speed]` builds `'[GPS Speed] * 0.621371'`.
- [ ] Step 2: Fail. Step 3: Implement. Step 4: Pass.

### Task 4: FormulaInput component

**Files:**
- Create: `client/src/components/formula/FormulaInput.tsx`, `client/src/components/formula/FormulaInput.test.tsx`

**Interfaces:**
- Consumes: `LabelIndex`, `ChannelInfo`, `storedToDisplay`/`displayToStored`, `checkFormula`, `FUNCTION_HELP`.
- Produces: `export function FormulaInput(props: { value: string; onChange(stored: string): void; channels: ChannelInfo[]; labelIndex: LabelIndex; showCodes?: boolean; rows?: number; testId?: string }): JSX.Element`, plus `export interface FormulaInputHandle { insertChannel(code: string): void }` via `forwardRef`.
- Behavior:
  - A textarea holds the display text, or the stored text when `showCodes` is on. A mirror div behind it, with the same font and padding and transparent text over the overlay, renders `[label]` runs as tinted chips without changing width.
  - Typing a word of 2 or more characters (or `[` + text) opens a suggestion list. It searches label, code, description and category, plus function names, and shows at most 8 rows: label, grey code, unit. ↑/↓ move, Enter/Tab accept, Esc closes. Accepting replaces the partial word with `[label]` (or `name(` for a function).
  - Backspace directly after a `]` that closes a chip deletes the whole chip.
  - Below the box, the `checkFormula` problem (if any) appears as a red line.
  - `insertChannel` inserts at the caret.

- [ ] Step 1: Write failing tests (jsdom):
  - Rendering with value `'FBrakePressure - RBrakePressCorr'` shows textarea value `'[Front Brake Pressure] - [Rear Brake Pressure]'`.
  - Typing `'brake'` shows a suggestion "Front Brake Pressure"; Enter sets onChange to `'FBrakePressure'`.
  - Backspace after a chip removes it.
  - Value `'A B'` shows the operator message.
  - `showCodes` shows the raw text.
- [ ] Steps 2–4: Fail, implement, pass.

### Task 5: Rewrite DerivedChannelDialog

**Files:**
- Modify: `client/src/components/DerivedChannelDialog.tsx`, `client/src/components/DerivedChannelDialog.test.tsx`
- Modify: `client/src/App.tsx` (pass `derivedChannels={state.derivedChannels}`)

**Interfaces:**
- Consumes: Tasks 1–4. `usePreferences().prefs.channelLabels` and `update`.
- New optional prop: `derivedChannels?: DerivedChannel[]`, listed as category "Your channels".
- Layout:
  - Recipe chips (from `availableRecipes`) → slot controls (channel `<select>` by label, sorted; number input; choice select).
  - Then the FormulaInput, with a "Show codes" toggle and a collapsible "Functions" help listing `FUNCTION_HELP`.
  - Then the browse list, grouped by category with label and grey code. Click inserts at the caret. A pencil icon opens an inline rename that saves to `channelLabels`. Uncertain channels show "?".
  - Then the auto preview (debounced 300 ms, runs when `checkFormula` returns null; name not required), then name and units, then Create.
- Selecting a recipe sets the expression and suggests a name and units (only into empty fields or fields the recipe previously filled). After a manual edit of the formula, the recipe is detached: slots are disabled and a "Start over from recipe" button appears.
- Python lives behind a link "Advanced: write Python instead" (`data-testid="btn-mode-python"`). Python mode has a "Back to formula" link (`btn-mode-formula`) and a manual Preview button (`btn-preview`), as before. Editing an existing python channel opens in Python mode.
- Remove `FORMULA_EXAMPLES`.

- [ ] Step 1: Update tests:
  - Recipe chips filter: a session with only `Spd1` has no "Battery power"; one with Pack_Voltage and Pack_Current has it.
  - Choosing "Battery power" fills the stored expression and the name "Battery Power" and units "kW". Submit sends `expression: 'Pack_Voltage * Pack_Current / 1000'`.
  - Clicking two channels inserts at the caret (no `'A B'` append bug: the second insertion lands at the caret, and the error line shows the operator hint).
  - Auto preview is called without a name (use fake timers).
  - The Python link and back link work. The existing edit, cancel, backdrop and submit-error tests are kept.
- [ ] Steps 2–4: Fail, implement, pass.

### Task 6: Friendly names elsewhere

**Files:**
- Modify: `client/src/App.tsx` (`buildAndSetSession`: `longName = describeChannel(code, inferCarType(codes), prefs.channelLabels).label`)
- Modify: `client/src/components/live/WidgetConfigDialog.tsx` (formula field → `FormulaInput`, with channels from `sources.live ∪ seen ∪ builtin`; car type from `inferCarType` over them)
- Test: `client/src/components/live/WidgetConfigDialog.test.tsx` if present, else add one case to the nearest existing test.

- [ ] Step 1: Write a test that the widget formula field shows `[Battery Voltage]` for a widget with expr `Pack_Voltage`, and that typing updates `expr` with raw codes.
- [ ] Steps 2–4: Fail, implement, pass. The sidebar needs no change: it already shows and searches `longName`.

### Task 7: Verify

- [ ] `npx tsc -p .` reports no errors.
- [ ] `npx vitest run` passes the whole suite.
- [ ] Run the app (`run` skill). Open an EV session and create a "Brake balance" recipe channel. Type "brake" in the formula box. Confirm the IC recipes are hidden. Take a screenshot.
