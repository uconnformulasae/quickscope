# Easier Formula Editor: Design

Date: 2026-11-05
Status: implemented (2026-11-05), uncommitted

## Why

The derived-channel ("formula") feature in `client/src/components/DerivedChannelDialog.tsx` is only usable by people who already know the logger's channel codes. Team members who don't know that `FBrakePressure` is front brake pressure, or what `Id_Feeback` or `InvRunFaultB4` mean, can't build formulas. The logger provides only one name per channel. `App.tsx` sets `longName = shortName`, so there is no hidden friendly name to fall back on.

Other problems found while researching:
- Clicking a channel in the "Available channels" list appends it to the end of the expression with a space and no operator, which produces invalid formulas like `RTD_Alarm RTD_Fault`.
- Channels whose names contain spaces (`GPS Speed`, `GPS Latitude`, `External Voltage`, `Logger Temperature`, …) cannot be referenced at all. The tokenizer in `formula-engine.ts` only accepts `[A-Za-z0-9_]`.
- The example buttons are hard-coded to channel codes (`Spd1`, `InlA`, `LatA`, `RBRK`) that don't exist on the team's EV logger.
- Function arguments are inconsistent and undocumented in the UI: `smooth` uses samples, `mavg` uses milliseconds, `delay` uses samples.
- Errors are parser-speak ("Unexpected token ')' at position 14"). Preview is manual and needs a channel name to be typed first.
- Python mode sits next to Formula mode with equal weight, which makes the dialog look harder than it is.

## Who it's for

Team members, especially newer ones, who know what they want to calculate ("front minus rear brake pressure", "battery power") but don't know the logger codes. Success means someone can create a useful math channel without ever reading a raw channel code.

## Goals

1. **Plain-English channel names.** Every channel shows a readable name and a short description wherever users choose channels for formulas.
2. **Option C editor (user's choice):** recipe buttons at the top that fill in channel dropdowns, plus a readable formula box underneath where channels appear as name tags and typing searches channels and functions.
3. **Works for both the EV and an internal-combustion (IC) car.** What's shown follows the channels in the open session. Gas/fuel recipes appear only on IC logs, and battery/inverter recipes appear only on EV logs. There is no manual "car type" switch.
4. Live preview as the user edits, with plain-language error messages.
5. Fix the click-to-insert bug and the spaces-in-names limitation.

## Non-goals

- Changing the math engine's evaluation semantics or adding big new signal-processing functions (integral, low-pass, and so on are tracked separately in `docs/race-studio-3-comparison.md` §10). The exception is any small helper a recipe strictly needs; see Recipes.
- Redesigning the Python sandbox. It stays, just de-emphasized.
- A team-shared, server-synced name dictionary. Names ship with the app, and user renames stay local.

## Anti-goals (would count as failure even if it technically works)

- Existing saved derived channels or live-dashboard widget formulas stop working or change meaning.
- A recipe shows up for a car that doesn't have the needed channels (for example "Fuel used" on an EV log).
- A channel the dictionary doesn't know becomes hidden or unusable. Unknown codes must still work and show their raw code.
- Wrong friendly names presented as fact. Channels we can't identify are visibly flagged, not guessed.

## Decisions made with the user

- Direction C (recipes plus readable editor).
- Claude writes all friendly names and descriptions; the team has no existing channel list, DBC, or spreadsheet to import.
- Must be dynamic for IC and EV cars. With no IC log available, use common IC channel names for now.

## Design

### 1. Channel dictionary (new: `client/src/lib/channel-dictionary.ts`)

A static table mapping a raw channel code to:
- `label`: plain-English name ("Front Brake Pressure")
- `description`: one line ("Hydraulic pressure in the front brake circuit")
- `category`: for grouping/search (Brakes, Driver Inputs, Battery, Inverter/Motor, Faults & Alarms, GPS, Chassis/IMU, Engine, Fuel, Logger)
- `role` (optional): a semantic tag recipes match on, e.g. `brake_pressure_front`, `pack_voltage`, `pack_current`, `lat_accel`, `long_accel`, `wheel_speed`, `gps_speed`, `engine_rpm`, `fuel_flow`, `lambda`
- `uncertain` (optional): true when the meaning is a best guess. The UI shows a small "?" with "Not sure what this is. Rename it if you know."

**EV entries:** every code seen in the repo sessions (`tests/fixtures/…a_5816.xrk`, `backend/data/sessions/a_0160.xrk`, `…a_0252.xrk`, plus the `.xrz` files `a_0173` and `a_0357`), about 110+ unique codes. Also every live-stream code in `client/src/components/live/live-channels.ts` (`CHANNEL_META`), which uses different spellings (`FrBrakePressure`/`RBrkPressure` vs `FBrakePressure`/`RBrakePressure`); those get explicit entries, not normalized matching. `Channel01`–`Channel08`, `Innovation_001`, `Flags` and similar get `uncertain: true` and a neutral label ("Unlabeled analog channel 1").

**IC entries:** common AiM and FSAE-ECU names with case and spelling variants, e.g. `RPM`/`Engine RPM`, `Lambda`/`Lambda1`/`AFR`, `OilPress`/`Oil Pressure`, `OilTemp`, `WaterTemp`/`ECT`/`Coolant Temp`, `FuelPress`, `Fuel Flow`/`FuelFlow`, `Fuel Used`, `Gear`, `TPS`/`Throttle`, `MAP`, `IAT`/`Air Temp`, `Ignition Angle`, `Injector PW`, `Battery`/`Batt Volt`. Generic shared names such as `GPS Speed`, `LateralAcc`, `InlineAcc`, `RPM` serve both cars.

**Matching:** exact code first, then a normalized match (lowercase, spaces/underscores/dashes removed) so `Oil_Press`, `Oil Press` and `OilPress` all hit. A pattern list is acceptable for families (`Phase_[ABC]_Current`, `TPS[12]_OOR_(Alarm|Fault)`).

**Car type is inferred, never chosen *(Claude's call)*:** the dictionary lookup takes a car-type hint (`ev` | `ic` | `unknown`) inferred from the session. EV if any EV-only code exists (pack voltage/current, inverter, BMS channels). IC if any IC-only code exists (lambda, fuel, oil, ignition). Otherwise unknown. Codes that both cars use but that mean different things on each get a label per car type: `RPM` is "Motor RPM" with role `motor_rpm` on EV and "Engine RPM" with role `engine_rpm` on IC; `Battery`/`Batt Volt` is the 12 V low-voltage battery, never pack voltage. When the type is unknown, ambiguous codes get a neutral label ("RPM") and no car-specific role. That way IC-only recipes like gear ratio never appear on EV logs.

**Role choices confirmed by the user:** `RBrakePressCorr` (corrected rear pressure) carries the `brake_pressure_rear` role; `RBrakePressure` is labeled "Rear Brake Pressure (raw)". `Pack_Current` carries `pack_current`; `MCU_DC_Current` is labeled "Inverter DC Current" with no pack role.

**Unknown codes:** label equals the raw code, no description, no role. They still work everywhere.

**User renames:** a user can rename any channel's label (and fix an `uncertain` one) from the channel picker. Overrides are stored locally (same mechanism as existing preferences, `usePreferences`) keyed by raw code and win over the built-in table. *(Claude's call.)*

### 2. Recipes (new: `client/src/lib/formula-recipes.ts`)

Each recipe has:
- a title and one-line explanation
- a list of **slots**. Each slot has a label ("First channel", "Battery voltage") and optionally a preferred `role` used to pre-fill it
- an `availability` rule: the roles that must exist in the open session for the recipe to be shown. Generic recipes (convert, difference, smooth) need no role and are always shown
- a template producing the formula from the slot values, plus suggested name and units

The recipe list is filtered against the open session's channels (through the dictionary roles). Initial set *(Claude's call; the user didn't name their most-used formulas)*:

| Recipe | Shown when | Formula shape |
|---|---|---|
| Convert units (km/h→mph, bar→psi, °C→°F, m/s²→g, …) | always | `X * k` or `X * k + c` |
| Difference of two channels | always | `A - B` |
| Ratio / percentage of two channels | always | `A / B` or `A / (A + B) * 100` |
| Smooth out noise | always | `mavg(X, ms)` (time-based, so the user picks a duration, not samples) |
| Rate of change | always | `diff(X)` |
| Combined G-force | lateral + longitudinal accel exist | `sqrt(Lat^2 + Long^2)` |
| Brake balance (% front) | front + rear brake pressure exist | `F / max(F + R, 2) * 100` (guard: off-brake F+R≈0) |
| Battery power (kW) | EV: pack voltage + pack current | `V * I / 1000` |
| Rolling-average power (FSAE EV 500 ms rule) | EV: pack voltage + pack current | `mavg(V * I / 1000, 500)` |
| Motor phase current (RMS) | EV: phase A/B/C current | `sqrt((A^2 + B^2 + C^2) / 3)` (a plain average of 3-phase AC is ≈0) |
| Air-fuel ratio from lambda | IC: lambda | `lambda * 14.7` |
| Fuel used / fuel flow conversions | IC: fuel flow | unit conversion on flow |
| Estimated gear ratio | IC: engine RPM + a speed channel | `RPM / max(speed, 5)` (guard: stopped car) |

Picking a recipe fills the formula box below. Slots are dropdowns of channels by friendly name, pre-filled when a matching role exists. Changing a dropdown rewrites the formula. Once the user hand-edits the formula box, the recipe is "detached" (dropdowns grey out with a "Start over from recipe" link) so their edits aren't silently overwritten. Recipes also suggest the channel name and units fields.

If a recipe truly needs an engine helper that doesn't exist, it can be added in `formula-engine.ts` with tests. None of the recipes above should need one.

**Reopening a recipe channel *(Claude's call)*:** no recipe ID is stored. Editing an existing channel opens the readable formula box with the saved formula (the recipe is shown as detached), so `DerivedChannel` and its persistence stay unchanged.

### 3. Readable formula editor (rewrite of the expression area in `DerivedChannelDialog.tsx`)

- **Display:** channel references render as tags showing the friendly label. Hovering shows the raw code, units and description. Operators and numbers render as normal text.
- **Typing:** typing letters opens a suggestion list that searches labels, codes, descriptions and categories ("brake" finds Front Brake Pressure, Rear Brake Pressure, Brake Bias…). Each row shows label, grey code and units. Function names appear in the same list with a plain description and argument hints ("Moving average — mavg(channel, milliseconds)").
- **Insertion** happens at the cursor. Inserting a channel right after another channel or a closing paren adds nothing automatically, but the live error explains "Add an operator (+ − × ÷) between Rear Brake Pressure and RTD Fault."
- **Implementation approach is left to the builder** (contenteditable with atomic tag spans, an overlay on a plain textarea, or a small token editor). Hard requirements: keyboard-only editing works (arrow keys, backspace deletes a whole tag, Enter/Tab accepts a suggestion, Esc closes it); copy/paste yields the stored text form; existing tests' `data-testid`s continue to exist or are updated with the tests.
- **"Show codes" toggle** flips the box between friendly tags and the raw stored text, for technical users.
- **Available channels list:** keep it, but grouped by category with friendly names, and clicks insert at the cursor.
- **Function help:** a compact, collapsible "Functions" reference listing each function in plain words with units of each argument.

### 4. Stored format and engine changes (`formula-engine.ts`)

- Formulas are still **stored with raw codes**, so every existing saved derived channel and live widget formula keeps working unchanged. Friendly labels are display-only.
- **Bracket-quoted channel names:** the tokenizer accepts `[GPS Speed]` (any characters except `]`) as a channel identifier. The editor writes brackets only when a code isn't a plain identifier. Bare identifiers keep working. `extractChannelNames` must handle both forms (used by `useXRKStore` lazy-fetch and `live/layout-schema.ts`). The backend Python mode is unaffected.
- **Friendlier errors:** the engine throws structured errors (message, start/end character range). The UI maps them to plain sentences and underlines the offending span. Examples: unknown channel → "There's no channel called 'Spd1' in this session"; dangling operator → "Missing something after the minus sign"; unbalanced parens → "A '(' is never closed"; wrong arg count → "Moving average needs a channel and a time in milliseconds".

### 5. Dialog layout and flow

Top to bottom: recipe buttons (filtered) → recipe slots (when a recipe is picked) → readable formula box → live preview chart → name + units (pre-filled by the recipe; editable) → Create.

- **Live preview** runs automatically (debounced ~300 ms) whenever the formula parses. It no longer needs the name filled in.
- **Python** moves behind a small "Advanced: write Python instead" link at the bottom. Editing an existing Python channel opens straight into Python mode as today.
- Remove the hard-coded `FORMULA_EXAMPLES`; recipes replace them.

### 6. Friendly names elsewhere *(Claude's call, confirm)*

The dictionary labels are also shown in:
- the channel sidebar (`ChannelSidebar.tsx`, which already has a second line for `longName`, so set `longName` from the dictionary in `App.tsx` and searching matches it too)
- the live dashboard widget formula field (`live/WidgetConfigDialog.tsx`), which gets the same readable editor component **without recipes or the preview chart** *(Claude's call)*. The live dialog has no session, only the live/seen/built-in channel list (`ChannelSources`), and evaluates one sample at a time, so the editor component must work with just a channel list and no session. Car type is inferred from that channel list.

## Constraints

- Client is React + TypeScript + Tailwind, tested with Vitest (`*.test.ts(x)` beside sources). The backend is FastAPI/Python with pytest. New logic (dictionary matching, recipe availability, bracket tokenizing, error ranges) needs unit tests. The dialog's existing test (`DerivedChannelDialog.test.tsx`) must be updated rather than deleted.
- No new heavy dependencies for the editor unless clearly justified. Follow the existing `qs-dialog` styling and light/dark theme tokens.
- Don't commit unless the user asks (standing user preference).

## Left to the builder

- Exact editor implementation technique (see §3).
- Exact dictionary wording, provided it's honest about uncertainty.
- Visual polish, spacing and icons, following existing dialog styles.
- Debounce timing, suggestion ranking details.
