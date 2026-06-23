# Phase 18 — README features + screenshots (live-HOS demo) — SUMMARY

**Milestone:** v1.2 (FINAL phase) · **Branch:** `feature/phase-18-readme-features-screenshots`
**Requirements delivered:** DOC-01, DOC-02 (+ the live-HOS-enablement prerequisite)
**Method:** TDD for the live-HOS wiring + real screenshot capture (existing browser harness). Unit determinism goldens untouched / byte-identical.

## What shipped

### P1 — Driver HOS is now ON for the LIVE demo (the functional prerequisite)

The running demo (`main.ts → driveSimulationPaced → simulate`) now enables driver
Hours-of-Service by **default**, so the engine seeds drivers, assigns them per trip,
accrues driving minutes, parks/relays on a breach, and emits the driver-lifecycle +
load/unload events. As a result the `driver_status` projection is populated and
`GET /api/hubs/:id/detail` + the ws driver buckets carry **real driver duty data** — the
v1.2 hero feature is finally visible on the live map (duty coloring) and the Hub Detail
panel (duty status + remaining legal drive time).

- `hosEnabled`/`hosConfig` are threaded through `DriveSimulationOptions` into both
  `simulate(...)` calls (`driveSimulation`, `driveSimulationPaced`) via conditional
  spreads (`exactOptionalPropertyTypes`-safe).
- A clear toggle: `resolveDemoHosEnabled(env)` reads `HOS_ENABLED` (default ON; `0`/
  `false`/`off`/`no` ⇒ off). `main.ts` resolves it and passes `DEFAULT_HOS_CONFIG`.
- The real-stack e2e `globalSetup` now drives HOS-on (+ over-carry) so the panel +
  map show driver data for the live-path assertions and any real-stack capture.
- A `demo` script (`tsx src/main.ts`) was added so the README quickstart runs the
  actual live HOS-on entrypoint (the `dev` script runs `server.ts`, which does NOT
  drive the sim).

**Determinism keystone preserved:** the unit determinism goldens call `simulate(...)`
directly with the default (HOS-off) config and never read `HOS_ENABLED`. They remain
byte-identical. Only the LIVE runnable demo + the real-stack e2e turn HOS on.

### P2 — README (DOC-01)

`README.md` rewritten with a **Supported Features (v1.0 – v1.2)** section spanning:
event-sourced operational twin + deterministic replay; route-aware LIFO load planner +
independent validator; probabilistic RFID validation; rolling-horizon optimizer
(min-cost-flow + VRPTW + **HOS-enforced**); realistic ORS time model; **driver
Hours-of-Service (full FMCSA) + relay/swap at hubs**; live USA-map visualization;
**clickable Hub Detail panel** (driver duty + remaining legal drive time). Plus an
accurate **quickstart** (docker-compose up → `@mm/api demo` → `@mm/web dev`) and an
HOS-on note. Both screenshots are embedded.

### P3 — Screenshots (DOC-02)

REAL PNG screenshots captured via the existing **vitest browser (real headless
Chromium) harness** — the documented fallback path — rendering the genuine `MapView`
(real OpenLayers map) and `HubDetail` (real React panel) with representative driver-HOS
data, then `page.screenshot()`-ing into `docs/screenshots/`:

- `docs/screenshots/live-map.png` — the live USA map: the full MEM-centered
  hub-and-spoke network, trailers animating along routes, hubs colored by driver duty,
  with the Legend (driver duty / hub volume / route load).
- `docs/screenshots/hub-detail.png` — the Hub Detail panel opened on a hub, three
  trailers with driver duty (driving / on-break / resting) + remaining legal drive time.

**Why the fallback (not the chromium-real full-stack path):** with the realistic ORS
time model, no trailer reliably DOCKS at a destination hub within the e2e's 120-tick
window (the shortest spoke leg is ≈400 min), so the real-stack Hub Detail panel would
show no driver duty at capture time. The fallback renders the SAME real components with
deterministic driver-HOS data — a genuine UI render, always showing the hero feature.
The LIVE demo path itself is HOS-on and was verified end-to-end (see VERIFICATION).

## Files changed

### New
- `packages/api/src/detection-config.test.ts` — `resolveDemoHosEnabled` unit tests.
- `packages/web/src/screenshots.browser.test.tsx` — DOC-02 real screenshot capture (map + Hub Detail).
- `docs/screenshots/live-map.png`, `docs/screenshots/hub-detail.png` — the embedded PNGs.

### Modified
- `packages/api/src/sim/driver.ts` — `DriveSimulationOptions` gains `hosEnabled`/`hosConfig`; spread into both `simulate(...)` calls.
- `packages/api/src/detection-config.ts` — `resolveDemoHosEnabled(env)` (the `HOS_ENABLED` toggle, default ON).
- `packages/api/src/main.ts` — resolve `hosEnabled`, pass it + `DEFAULT_HOS_CONFIG` to `driveSimulationPaced`.
- `packages/api/src/index.ts` — export `resolveDemoHosEnabled`; re-export `DEFAULT_HOS_CONFIG` / `HosConfig` from `@mm/domain`.
- `packages/api/src/sim/driver.test.ts` — HOS-on flow block (driver events reach the optimizer; HOS-off has none; on ≠ off).
- `packages/api/package.json` — `demo` script (`tsx src/main.ts`).
- `packages/web/test/real-e2e.globalSetup.ts` — drive HOS-on (+ over-carry) so the panel + map show driver data.
- `README.md` — Supported Features (v1.0–v1.2) + quickstart + embedded screenshots.

## Notes / decisions

- The live-HOS toggle is an env var (`HOS_ENABLED`), default ON for the demo — a clear,
  simple toggle matching the `DEMO_*` config convention.
- `DEFAULT_HOS_CONFIG`/`HosConfig` are re-exported from `@mm/api` so `@mm/web`'s e2e
  globalSetup uses them without adding a `@mm/domain` dependency.
