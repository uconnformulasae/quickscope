# Audit sweep plan (2026-11-09)

Source: `audit.md` (about 95 findings). Items 1-4 were already fixed on
`refactor/26-codebase-sweep` (commits 7e070b6, 61d73c5, 73dc173, e5126a4).
This plan covers everything else.

## Decisions

- **Scope:** everything, in tiers. Test suites run after each tier.
- **AiM device code:** fixes only. The duplicated framing, resync, discovery
  and host-resolution logic in `aim_connector` / `aim_live` is left alone
  because it can only be checked against the fake device here.
- **Network:** localhost-only by default. `QUICKSCOPE_ALLOWED_HOSTS`
  (comma-separated hostnames/IPs) re-enables access from other machines
  without a code change.
- **GPS time base:** absolute session time for GPS laps and `/api/gps`.
- **No commits** unless asked.

## Tier 1: high severity

| # | Change | Where |
|---|--------|-------|
| 1b | Case-insensitive duplicate-name lookup for upload and rename | `session_store.find_by_filename` |
| 5 | One session generation counter, bumped on every session change and checked after each `await`; block a second load while one is in flight | `useXRKStore.ts`, `SessionBrowser.tsx`, `App.tsx` |
| 6 | Middleware rejecting foreign `Host` and `Origin` on every HTTP route; Docker ports bound to 127.0.0.1; Vite `allowedHosts` restricted | `origins.py`, `main.py`, `docker-compose*.yml`, `vite.config.ts` |
| 7 | `connected` detects a peer-closed socket; a failed session list closes the connection | `aim_live.py`, `aim_primary_hub.py` |

## Tier 2: medium severity

Backend
- Run `/channels`, `/data`, `/laps`, `/gps`, `/export` conversion off the event loop.
- Active session can't be evicted from `session_cache`; each upload gets its own pending slot.
- Device errors: timeouts and other failures on the list route return a clear error, not HTTP 500; "live view is active" gets its own message; a failed list is an error, not `[]`.
- Download reassembler refuses offsets beyond the expected file size.
- Keep-alive replies only update the device cache when they come from the device being kept alive.
- Skip UDP discovery when the primary connection is already open.
- GPS laps and `/gps` trail in absolute session time.
- `Content-Disposition` handles non-ASCII names (RFC 5987).
- Rename handles `OSError` and keeps file and index in step.

Frontend and Electron
- One shared modal shell with the press-and-release-on-backdrop rule from `WidgetConfigDialog`; the five dialogs use it.
- TelemetryChart: no `setState` in move handlers; hover cursor leaves the global store.
- Session-load errors shown in the browser view.
- Electron kills the backend on every exit path and treats signal exits as exits.

## Tier 3: redundancy and dead code

- Delete the unused code the audit lists (`_drain_download_frames`, `state.get_log`, `SessionCache.keys`, `settings_store.save`, `LIVE_FRAME_SIZE_LEGACY`, `POLL_INTERVAL_S`, `_get_device_ip`, `AimLiveTrace.log_frame`, ignored reconnect parameters).
- One JSON persistence helper (atomic save, corrupt-file quarantine, UTF-8) for the four stores.
- One unit table, one binary search, one `formatBytes`, one backend-URL helper, `saveBlob` for all downloads.
- Stale config: `environmentMatchGlobs`, `electron:dev` on Windows, committed `.DS_Store`, tests in `tsc`.

## Tier 4: optimizations

- Backend: read timecodes from Arrow, numpy masks in `channel_data` / `extract_session_info`; per-chunk CSV formatting; base64 only when raw is requested; lower download memory.
- Chart: index ranges from `getVisibleSamples`, single scan in overlay mode, drop the unread `globalMinMaxCache`.
- Live view: memoized widgets and parsed formulas; no `JSON.stringify(draft)` per render.
- Lap table: binary search per lap.
- Installer: move bundled-by-Vite packages to `devDependencies`.

## Tests added

Corrupt upload under an existing name (exists, verify), case-variant
collisions, closures/generators in derived scripts (exists, verify), `-x^2`
(exists), session switch during an in-flight fetch, GPS laps when GPS starts
after t=0, `Host`/`Origin` enforcement.

## Verification

`python -m pytest -m "not dll and not libxrk"`, `npx vitest run`, `npx tsc`
after each tier. Baseline before the sweep: 691 passed / 612 passed / one
existing `tsc` error in `saveBlob.ts`.

## Outcome

All four tiers are done, including the items first left partial. `tsc` is clean
and now also checks test files.

Where the work differs from the audit:

- **`SessionCache.keys` stays.** The cache tests use it to inspect eviction order.
- **`globalMinMaxCache` was read** by the image export. The per-data-change scan
  is gone; the export now finds the session extremes when it is opened.
- **A session list with no CSV now raises** instead of returning `[]`.
- **File sizes are 1024-based everywhere.** The AiM picker used 1000, so a
  2,500,000-byte session reads 2.4 MB there now.

Second pass (the items the first pass left partial):

- **AiM framing is shared.** The download handshake and ack are built from the
  live client's payload constants (and pinned to the captured bytes by a test),
  every reader skips noise with `resync_offset`, both discovery entry points
  end in `remember_device`, and `resolve_device_host` is the one host rule.
  This reversed the earlier "fixes only" decision at the user's request.
- **Downloads no longer keep the raw stream.** The failure trace gets the same
  summary from running counters.
- **One `Modal` component** carries the scrim, panel chrome, backdrop rule and
  Escape handling for all seven dialogs.
- **One unit table** in `lib/units.ts`; live tiles and formula recipes read it.
- **The chart draws from index ranges** and walks each series once per zoom
  (`scanSeries`); the delta readout subscribes to a store, so dragging a
  cursor no longer re-renders the chart.

Not exercised here: a real AiM logger, Windows, a packaged Electron build, and
the UI in a real browser (component tests run in jsdom).
