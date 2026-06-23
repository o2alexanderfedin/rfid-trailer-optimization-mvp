# Phase 13 Plan: Driver-status projection + tables

**Requirements:** PRJ-01, PRJ-02
**Depends on:** Phase 12 (relay/swap), Phase 10 (HOS engine), Phase 9 (driver events)
**Branch:** `feature/phase-13-driver-status-projection-tables` (no merge, no push)
**Mode:** TDD (tests first → green → refactor). This phase has an integration
test, so `pnpm test:all` (unit + testcontainers integration + ui) is the gate.

## Goal

Build the **driver-status read model** in `@mm/projections`: pure reducers folding
the four driver-lifecycle events into one deterministic row per driver, with
OPERATIONAL (read-your-writes) Postgres tables, plus the supporting schema
changes (`driver_id` on `trailer_state`, a `trailer_state(current_hub_id)`
index). The read model feeds the Phase-14 hub-detail endpoint.

## Approach (mirror existing `@mm/projections` conventions exactly)

Closest analog: `reducers/trailer-state.ts` (one-row-per-entity pure reducer) +
its `applyTrailerState` inline applier + `TrailerStateTable` DDL.

### Task 1 — PRJ-01: `driverStatusReducer` (pure, TDD)
- New `src/reducers/driver-status.ts`: pure reducer over `(state, OccurredEvent)`
  folding `DriverRegistered` / `DriverAssignedToTrip` / `DriverDutyStateChanged` /
  `DriverSwappedAtHub` into one `DriverStatus` row per driver:
  `{ driverId, status, remainingDriveMinutes, dutyWindowDeadline,
  totalDrivenMinutes, weeklyOnDutyMin, currentHubId, currentTripId, lastEventAt }`.
- Derive `remainingDriveMinutes` + `dutyWindowDeadline` from the `HosClock`
  snapshot carried in `DriverDutyStateChanged`, **reusing** the Phase-10
  `@mm/domain` engine (`remainingLegalDriveMinutes`, `isoToEpochMinutes`,
  `epochMinutesToIso`, `DEFAULT_HOS_CONFIG`). `now` = the event `occurredAt`
  (never wall-clock) so the 14h ELAPSED window evaluates correctly.
- All other domain events are exhaustive-switch no-ops (`assertNeverEvent` guard).
- Sibling `src/reducers/driver-assignment.ts`: pure `driverAssignmentReducer`
  folding driver↔trip/trailer/hub (carries `trailerId`, which the status row does
  not) for join-free hub-detail queries.
- RED first: `test/driver-status.unit.test.ts` asserts the documented row shape,
  HOS derivation (vs the engine), swap handoff, purity/determinism/immutability.

### Task 2 — PRJ-02: tables + runner threading + `trailer_state` changes
- `schema.ts` / `schema.sql`: add `DriverStatusTable` + `DriverAssignmentTable`
  Kysely interfaces + **idempotent** DDL (mirroring `trailer_state`); add
  `driver_id TEXT` to `trailer_state`; add `idx_trailer_state_current_hub` index.
  Keep the embedded `PROJECTIONS_SCHEMA_SQL` byte-identical to `schema.sql` (the
  drift test guards it).
- Register `driver-status` + `driver-assignment` in `OPERATIONAL_PROJECTIONS`
  (read-your-writes — NOT catch-up).
- `runner/inline.ts`: add `applyDriverStatus` + `applyDriverAssignment`
  load→fold→upsert appliers; add to `APPLIERS`; extend `applyTrailerState` +
  `readOperationalTwin` + `OperationalTwin` to carry `driver_id` and the two
  driver maps.
- `runner/rebuild.ts`: TRUNCATE the two new tables; extend `serializeTwin` so the
  driver read models are part of the byte-identical determinism guarantee.
- `trailerStateReducer`: replace the `DriverAssignedToTrip` / `DriverSwappedAtHub`
  no-ops with real `driver_id` stamping (incoming driver on swap); carry it
  across the lifecycle. RED: extend `reducers.unit.test.ts`.

### Task 3 — Replay determinism (PRJ-02 success criterion 3)
- `packages/api/test/driver-status-golden-replay.int.test.ts` (testcontainers
  Postgres, mirroring `projections-golden-replay.int.test.ts`): build the driver
  read models LIVE (append + inline apply), then rebuild via TRUNCATE + replay
  `readAll(0n)` strictly by global_seq through the SAME applier; assert
  BYTE-IDENTICAL serialization (live == rebuilt) + a second rebuild is identical.

## Hard constraints
- Pure reducers, deterministic, key off `occurredAt`, no `Date.now()` / RNG.
- Strict TS, no `any`. Mirror the cited analogs.
- Do NOT break existing projection/integration tests; the simulation determinism
  goldens are unaffected (this is a read model) — confirm they still pass.

## Gate (ALL green)
`pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test:all`.
