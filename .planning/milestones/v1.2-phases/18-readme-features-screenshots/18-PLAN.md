# Phase 18 — README features + screenshots (live-HOS demo) — PLAN

**Milestone:** v1.2 (FINAL phase)
**Branch:** `feature/phase-18-readme-features-screenshots`
**Type:** DOCS + a functional prerequisite (enable driver-HOS on the LIVE demo path)
**Requirements:** DOC-01, DOC-02 (+ the live-HOS-enablement prerequisite)
**Method:** TDD for the live-HOS wiring (new unit tests) + real screenshot capture via the existing browser harness; keep the unit determinism goldens byte-identical.

## Goal

Make the v1.2 driver-HOS feature **visible in the running demo**, then document it:
(1) enable HOS on the live runnable path so the demo produces driver/HOS/relay events →
`driver_status` populated → `GET /api/hubs/:id/detail` + ws driver buckets carry real
data; (2) update `README.md` with a Supported-Features list (v1.0–v1.2) + a quickstart
(DOC-01); (3) capture REAL PNG screenshots of the live map (driver-duty hub coloring) +
the Hub Detail panel (driver duty + remaining legal drive time) and embed them (DOC-02).

## Approach (cite the analogs)

| Concern | Analog reused | New work |
|---|---|---|
| Thread HOS into the live driver | `driveSimulationPaced` already threads `rfid`/`overCarry`/`timing` into `simulate(...)` | Add `hosEnabled`/`hosConfig` to `DriveSimulationOptions`; spread them into both `simulate(...)` calls |
| Toggle HOS on the demo | `DEMO_RFID_CONFIG` / `DEMO_OVER_CARRY_CONFIG` env-aware demo config in `detection-config.ts` | `resolveDemoHosEnabled(env)` — `HOS_ENABLED` env, default ON; wired in `main.ts` with `DEFAULT_HOS_CONFIG` |
| Real-stack e2e seeds HOS | `real-e2e.globalSetup.ts` `driveSimulation({ rfid, broadcast, loop })` | add `overCarry` + `hosEnabled:true` + `hosConfig:DEFAULT_HOS_CONFIG` so the panel shows driver data |
| Run the live demo | `main.ts` (the runnable entrypoint, built to `dist/main.js`) — `dev` script runs `server.ts` (no sim) | add a `demo` script (`tsx src/main.ts`) so the README quickstart drives the live HOS-on stream |
| Real screenshots | `MapView.browser.test.tsx` (real Chromium + real OpenLayers + MSW) | `screenshots.browser.test.tsx` renders `MapView` (duty coloring) + `HubDetail` (driver-HOS data) and `page.screenshot()`s into `docs/screenshots/` |
| README | the existing ~95-line README | Supported-Features (v1.0–v1.2) + quickstart + two embedded screenshots |

## Tasks

1. **Thread HOS through the driver (P1).** `DriveSimulationOptions` gains `hosEnabled`/`hosConfig`; spread into `simulate(...)` in `driveSimulation` + `driveSimulationPaced` (conditional spreads — `exactOptionalPropertyTypes`).
2. **Demo toggle.** `resolveDemoHosEnabled(env=process.env)` in `detection-config.ts` (default ON; `HOS_ENABLED=0/false/off/no` ⇒ off). Export from the api index. Re-export `DEFAULT_HOS_CONFIG`/`HosConfig` from `@mm/domain` via the api index (so `@mm/web` can use it without a new dep).
3. **Wire `main.ts`.** Resolve `hosEnabled`, pass `hosEnabled` + `DEFAULT_HOS_CONFIG` to `driveSimulationPaced`.
4. **Wire the real-stack e2e** (`real-e2e.globalSetup.ts`) to HOS-on (+ over-carry) so the panel + map show driver data.
5. **`demo` script** in `packages/api/package.json` (`tsx src/main.ts`).
6. **Tests (TDD).** `detection-config.test.ts` for `resolveDemoHosEnabled`; extend `driver.test.ts` with a HOS-on flow block (driver events reach the optimizer; HOS-off has none; on ≠ off).
7. **README (DOC-01).** Supported-Features section + quickstart + embedded screenshots.
8. **Screenshots (DOC-02).** `screenshots.browser.test.tsx` → `docs/screenshots/live-map.png` + `hub-detail.png`.
9. **Gate** (build/typecheck/lint/test:all + browser) and **verify the live demo** boots HOS-on and hub-detail returns driver duty.

## Hard constraints

- **Unit determinism goldens stay byte-identical & green** — they call `simulate(...)` with the default (HOS-off) config and never read `HOS_ENABLED`. Only the live runnable demo + the real-stack e2e turn HOS on.
- Strict TS, no `any`. Match conventions.

## Verification

- `driver_status` populated on the live demo; `GET /api/hubs/:id/detail` returns `{ driver: { dutyStatus, remainingDriveMinutes } }` for a trailer at a hub.
- `simulation` determinism goldens byte-identical.
- Two real PNGs embedded in the README.
- Full gate green.
