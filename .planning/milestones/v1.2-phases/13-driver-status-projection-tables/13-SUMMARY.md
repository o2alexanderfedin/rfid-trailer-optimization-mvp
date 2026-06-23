# Phase 13 Summary: Driver-status projection + tables

**Requirements:** PRJ-01, PRJ-02
**Branch:** `feature/phase-13-driver-status-projection-tables` (not merged, not pushed)
**Completed:** 2026-06-22

## What was built

The v1.2 **driver read models** in `@mm/projections` — pure reducers + OPERATIONAL
Postgres tables that make a driver's duty status and remaining legal drive time
queryable, feeding the Phase-14 hub-detail endpoint. All built TDD, mirroring the
existing `trailer-state` one-row-per-entity reducer + inline-applier conventions.

### PRJ-01 — `driverStatusReducer` (pure)
- New `src/reducers/driver-status.ts`: folds `DriverRegistered` /
  `DriverAssignedToTrip` / `DriverDutyStateChanged` / `DriverSwappedAtHub` into
  ONE `DriverStatus` row per driver:
  `{ driverId, status, remainingDriveMinutes, dutyWindowDeadline,
  totalDrivenMinutes, weeklyOnDutyMin, currentHubId, currentTripId, lastEventAt }`.
- The HOS-derived fields (`remainingDriveMinutes`, `dutyWindowDeadline`) are
  computed from the `HosClock` snapshot in `DriverDutyStateChanged` by **reusing**
  the Phase-10 `@mm/domain` engine (`remainingLegalDriveMinutes` +
  `isoToEpochMinutes`/`epochMinutesToIso` + `DEFAULT_HOS_CONFIG`) — not
  reimplemented. `now` is the event `occurredAt`, never wall-clock, so the 14h
  ELAPSED-wall-clock window evaluates correctly.
- Sibling `src/reducers/driver-assignment.ts`: `driverAssignmentReducer` tracks
  driver↔trip/trailer/hub (carries `trailerId`, which the status row omits) for
  join-free hub-detail queries; a relay swap moves the trip to the incoming
  driver and frees the outgoing one.
- Both reducers are exhaustive-switch pure functions (`assertNeverEvent` guard),
  keyed off `occurredAt`, with non-driver events as no-ops (same state reference).

### PRJ-02 — tables, runner threading, `trailer_state` changes
- `schema.ts` + `schema.sql`: `DriverStatusTable` + `DriverAssignmentTable`
  interfaces + idempotent DDL (mirroring `trailer_state`); both registered in
  `OPERATIONAL_PROJECTIONS` (read-your-writes). Embedded `PROJECTIONS_SCHEMA_SQL`
  kept byte-identical to `schema.sql` (drift test green).
- `trailer_state`: new `driver_id TEXT` column + `idx_trailer_state_current_hub`
  index (the hub-scoped query backing for Phase 14 — no full-table scan).
- `trailerStateReducer`: the `DriverAssignedToTrip` / `DriverSwappedAtHub` no-ops
  replaced with real `driver_id` stamping (incoming driver on a relay swap),
  carried across the trailer lifecycle.
- `runner/inline.ts`: `applyDriverStatus` + `applyDriverAssignment`
  load→fold→upsert appliers added to `APPLIERS`; `applyTrailerState`,
  `OperationalTwin`, and `readOperationalTwin` extended for `driver_id` + the two
  driver maps.
- `runner/rebuild.ts`: the two new tables added to the TRUNCATE; `serializeTwin`
  extended so the driver read models are part of the byte-identical determinism
  guarantee.

### Replay determinism (PRJ-02 criterion 3)
- `packages/api/test/driver-status-golden-replay.int.test.ts` (testcontainers
  Postgres): builds the driver read models LIVE (append + inline apply), then
  rebuilds via TRUNCATE + replay from `global_seq=0` through the SAME applier, and
  asserts the rebuilt serialization is BYTE-IDENTICAL to the live one (live ==
  rebuilt), plus a second rebuild is identical. Includes sanity assertions on the
  documented driver/HOS/swap semantics.

## Files changed
- `packages/projections/src/reducers/driver-status.ts` (new)
- `packages/projections/src/reducers/driver-assignment.ts` (new)
- `packages/projections/src/reducers/trailer-state.ts` (driver_id stamping)
- `packages/projections/src/reducers/index.ts` (exports)
- `packages/projections/src/index.ts` (exports)
- `packages/projections/src/schema.ts` (tables, DDL, OPERATIONAL registration, index)
- `packages/projections/src/schema.sql` (mirrored DDL)
- `packages/projections/src/runner/inline.ts` (appliers, twin read, driver_id)
- `packages/projections/src/runner/rebuild.ts` (truncate + serializeTwin)
- `packages/projections/test/driver-status.unit.test.ts` (new — PRJ-01)
- `packages/projections/test/reducers.unit.test.ts` (driver_id stamping tests)
- `packages/api/test/driver-status-golden-replay.int.test.ts` (new — replay determinism)

## Determinism note (read model — sim goldens unaffected)
This phase touches only the projection READ side; it emits no events and changes
no simulation behavior. The simulation determinism goldens
(`determinism.unit.test.ts`, `hos-determinism.unit.test.ts`,
`rfid-determinism.unit.test.ts`) were NOT edited and pass unchanged. The new
read models read time exclusively from `occurredAt` / the carried `HosClock`
snapshot — no `Date.now()`, no RNG, no order-dependent logic — so live state ==
state rebuilt from the log, byte-for-byte (FND-04, P3).
