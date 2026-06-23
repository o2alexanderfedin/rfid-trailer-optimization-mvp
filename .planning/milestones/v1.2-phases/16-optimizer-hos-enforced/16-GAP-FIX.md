# Phase 16 — GAP-FIX: OPT-HOS-02/03 now fire on the LIVE optimizer path

**Status:** fixed
**Branch:** `feature/v1.2-audit-gap-opt-hos-live`
**Gap:** v1.2 Milestone Audit → GAP-1 (and dependent GAP-2)
**Date:** 2026-06-22

## What was dark

The v1.2 milestone audit found that **OPT-HOS-02** (the hard HOS feasibility gate)
and **OPT-HOS-03** (the `insertRest`/`relay` driver-relay recommendation) were fully
implemented and unit-tested, but **never fired on the LIVE optimizer path** — the
"passes unit tests but is never wired onto the live path" dark-requirement class.

Root cause — one missing data link in the live optimizer snapshot:

- `packages/api/src/optimizer/twin-snapshot.ts` built `TwinDriver` as exactly
  `{ driverId, remainingDriveMinutes }` and **never set `hosClock`**.
- `packages/optimizer/src/rolling/epoch.ts` `driverHosContextFor` returns
  `undefined` whenever `hosClock` is absent → `routeTrailers` was called without a
  `driver` context → `route-trailers.ts hosLegsFeasible` (the OPT-HOS-02 gate)
  never activated → `route.hosFeasible` stayed `undefined`.
- Because the gate never set `hosFeasible === false`, `epoch.ts firstHosInfeasibleLeg`
  (OPT-HOS-03, gated on `route.hosFeasible === false`) was unreachable, so the
  `insertRest`/`relay` recovery never surfaced through `EpochRecommendation`.
- The data was missing because the `driver_status` projection persisted only the
  *derived* summary (`remaining_drive_minutes`, …), **not** the full `HosClock` the
  gate needs to re-walk each driving leg. The clock IS in the event log
  (`DriverDutyStateChanged.payload.clock` — the reducer already read it to derive
  `remaining_drive_minutes`) — it was just never stored or carried forward.

## The 3-step fix

1. **Persist the full `HosClock`** in the `driver_status` read model.
   - `packages/projections/src/reducers/driver-status.ts`: `DriverStatus` gains a
     `hosClock: HosClock | null` field; `driverStatusReducer` folds
     `DriverDutyStateChanged.payload.clock` verbatim into it and carries it forward
     on the other driver-lifecycle events (`null` before the first duty transition).
   - `schema.sql` + `schema.ts` (kept byte-identical): a new `hos_clock JSONB`
     column on `driver_status`, mirroring `zone_estimate.posterior`.
   - `runner/inline.ts`: `applyDriverStatus` writes `JSON.stringify(clock)` (null
     stays null) and `readOperationalTwin` reads it back parsed; the `TRUNCATE`
     rebuild path is unchanged (it reuses `applyInline`).
   - `runner/rebuild.ts` `serializeTwin`: adds `hosClock` to the driver-status
     serialization, so the live==rebuilt golden replay now **also covers
     `hos_clock`** with a fixed key order. Deterministic / keyed off `occurredAt` —
     no wall clock, no RNG.

2. **Attach it to `TwinDriver`** in `packages/api/src/optimizer/twin-snapshot.ts`.
   - The snapshot query now selects `hos_clock`; when a driver has a persisted clock
     (a duty transition has carried one), the built `TwinDriver` sets
     `hosClock`. `hosConfig` is omitted so the gate uses `DEFAULT_HOS_CONFIG` (the
     same full FMCSA rule-set the simulator runs). A driver with no clock yet keeps
     the Phase-15 soft-only shape (`{ driverId, remainingDriveMinutes }`), so
     driverless / pre-duty twins reproduce their prior snapshot byte-identically.
   - With `hosClock` set, `epoch.ts driverHosContextFor` builds a real
     `DriverHosContext`, the OPT-HOS-02 gate activates, and OPT-HOS-03 becomes
     reachable on the live path.

3. **Prove it fires live (TDD).** RED → GREEN.

## The test that proves it now fires live

`packages/api/test/optimizer-hos-live.int.test.ts` (integration, real Postgres):

1. Appends a real driver-lifecycle stream whose `DriverDutyStateChanged` carries a
   **depleted** `HosClock` (`driveTodayMin: 655` of 660 → only 5 legal drive
   minutes left), plus a `RouteRegistered` H1→H2 leg (~30 min) and a trailer that
   arrives at H1 bound to that driver.
2. Folds the whole log through the SAME `applyInline` the running system uses, so a
   real `driver_status` row (with `hos_clock`) exists.
3. Builds the snapshot with the LIVE `buildTwinSnapshot` and asserts the live-built
   `TwinDriver` now carries `hosClock` (was `undefined` — the RED failure).
4. Runs `runEpoch` over the live snapshot and asserts the depleted driver's trailer
   is **`hosFeasible: false` ⇒ recommendation `feasible: false`** (OPT-HOS-02) and
   that an **`insertRest`/`relay` `EpochRecommendation`** naming the driver is
   surfaced (OPT-HOS-03).

This is the assertion the audit needs to flip OPT-HOS-02 / OPT-HOS-03 to `passed`.

## Determinism & back-compat

- The simulation determinism goldens (`determinism.unit`, `rfid-determinism.unit`,
  `hos-determinism.unit`) are **untouched** and green — none of the engine code was
  changed.
- The projections live==rebuilt golden-replay int test stays green and now also
  covers `hos_clock`.
- The optimizer stays pure/deterministic (integer minutes, no RNG, no `Date.now()`).
  The soft `restCost` default stays neutral (0). glpk oracle + planner-vs-validator
  stay green.
