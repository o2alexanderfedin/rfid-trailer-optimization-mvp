---
status: passed
---

# Phase 18 — README features + screenshots (live-HOS demo) — VERIFICATION

**Milestone:** v1.2 (FINAL phase) · **Branch:** `feature/phase-18-readme-features-screenshots`
**Requirements:** DOC-01, DOC-02 (+ the live-HOS-enablement prerequisite)

## Gate results

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm build` | PASS (turbo, 10/10 packages) |
| Typecheck | `pnpm typecheck` | PASS (0 errors, strict TS, no `any`) |
| Lint | `pnpm lint` | PASS (0 problems) |
| Unit + integration + ui | `pnpm test:all` | PASS — 138 files / 1472 tests |
| Browser (Chromium / real OpenLayers) | `pnpm test:browser` | PASS — 2 files / 9 tests |

The new `detection-config.test.ts` (4 tests) + the extended `driver.test.ts` HOS-on
block (3 tests) + `screenshots.browser.test.tsx` (2 tests, captures both PNGs) are
green; no existing suite regressed.

## Determinism keystone (the hard constraint)

- `packages/simulation/test/determinism.unit.test.ts` and the rest of the
  `@mm/simulation` suite (14 files / 139 tests) — **PASS, byte-identical**. They call
  `simulate({ seed, durationTicks })` with the default (HOS-off) config and never read
  `HOS_ENABLED`. The live-HOS change touches only `main.ts` / the real-stack e2e
  `globalSetup` / the driver's *optional* `hosEnabled` plumbing — not the goldens.
- No API integration test passes `hosEnabled`; they drive the sim HOS-off (default), so
  the live-HOS change leaves their assertions unaffected.

## Live-demo prerequisite — verified end-to-end (running stack)

Booted the actual quickstart path against Postgres 17 (OrbStack): `docker compose up -d`
+ `pnpm --filter @mm/api demo` (the new `demo` script → `main.ts`, HOS default ON).

- `driver_status` projection **populated** — 15 drivers, with `driving` rows carrying
  real `remaining_drive_minutes` (35–480), proving driver assignment + HOS accrual fire
  on the live path.
- `GET /api/hubs/MEM/detail` returned a trailer with
  `driver: { driverId: "D010", dutyStatus: "driving", remainingDriveMinutes: 480 }` —
  the endpoint carries real driver duty data, end-to-end.
- The fresh-schema run confirmed `trailer_state.driver_id` is present (the earlier
  empty-driver result was a stale Docker volume from a pre-Phase-14 schema, not a bug).

## Checklist

| Item | Requirement | Evidence |
|---|---|---|
| Live demo runs HOS-on | prerequisite | `main.ts` resolves `resolveDemoHosEnabled()` (default ON) → `driveSimulationPaced({ hosEnabled, hosConfig: DEFAULT_HOS_CONFIG })`; `pnpm --filter @mm/api demo` populated `driver_status` (15 drivers, 9 driving) |
| Hub-detail returns driver duty | prerequisite | live `GET /api/hubs/MEM/detail` → `driver.dutyStatus="driving"`, `remainingDriveMinutes=480` |
| Determinism goldens byte-identical | hard constraint | `@mm/simulation` 14 files / 139 tests PASS; goldens pass HOS-off explicitly, untouched |
| README Supported Features (v1.0–v1.2) | DOC-01 | `README.md` "Supported Features" section: twin+replay, LIFO planner+validator, RFID validation, optimizer (MCF+VRPTW+HOS-enforced), realistic ORS time, driver HOS (FMCSA)+relay/swap, live USA map, clickable Hub Detail (driver duty + remaining drive time) |
| README quickstart | DOC-01 | `README.md` quickstart: docker-compose up → `@mm/api demo` → `@mm/web dev`; HOS-on note + `HOS_ENABLED` toggle |
| Live USA map screenshot | DOC-02 | `docs/screenshots/live-map.png` (full hub-and-spoke network, trailers, driver-duty hub coloring, legend) embedded in README |
| Hub Detail panel screenshot | DOC-02 | `docs/screenshots/hub-detail.png` (3 trailers, driver duty driving/on-break/resting + remaining legal drive time) embedded in README |
| Screenshot capture path documented | DOC-02 | fallback browser harness (`screenshots.browser.test.tsx`, real Chromium + real OpenLayers); rationale recorded in SUMMARY (realistic-timing ⇒ no docked trailer at 120 ticks) |

## Status

**passed** — DOC-01 done, live-HOS enabled on the running demo (hub-detail returns
driver data), determinism goldens byte-identical, real screenshots captured + embedded,
full gate green.
