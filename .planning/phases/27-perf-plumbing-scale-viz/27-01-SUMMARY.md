---
phase: 27-perf-plumbing-scale-viz
plan: "01"
subsystem: projections / optimizer
tags: [perf, read-side, projections, twin-snapshot, determinism]
dependency_graph:
  requires: []
  provides:
    - trailer_fuel incremental projection (PERF-02)
    - induction_deadline incremental projection (PERF-02)
  affects:
    - packages/projections (inline applier, rebuild, schema, index)
    - packages/api (twin-snapshot — two readAll(0n) scans replaced)
tech_stack:
  added: []
  patterns:
    - Key-scoped incremental projection fold (load affected key → fold → persist delta)
    - Closed-switch pure reducer + assertNeverEvent (exhaustiveness compile gate)
    - Persisted-index reuse (geo_route / geo_inflight_trip seeded at fold time)
    - serializeTwin surface extension (sorted-PK byte-stable serialization)
key_files:
  created:
    - packages/projections/src/reducers/induction-deadline.ts
    - packages/projections/test/induction-deadline.unit.test.ts
    - packages/projections/test/trailer-fuel-rebuild.unit.test.ts
  modified:
    - packages/projections/src/schema.ts
    - packages/projections/src/schema.sql
    - packages/projections/src/runner/inline.ts
    - packages/projections/src/runner/rebuild.ts
    - packages/projections/src/index.ts
    - packages/api/src/optimizer/twin-snapshot.ts
    - packages/api/test/projections-golden-replay.int.test.ts
decisions:
  - "PERF-02 applier for trailer_fuel seeds routes+inflight from geo_route/geo_inflight_trip (M-4 pattern) rather than a separate in-memory index"
  - "applyTrailerFuel also maintains geo_inflight_trip (insert on TrailerDeparted, delete on TrailerArrivedAtHub) so incremental fold resolves the same leg as a full rebuild"
  - "induction_deadline row retained after PackageDelivered (optimizer may still read deadline post-delivery)"
metrics:
  duration: "~12 min"
  completed: "2026-06-27"
  tasks_completed: 3
  files_changed: 10
---

# Phase 27 Plan 01: PERF-02 Incremental Cursor-Fold Twin-Snapshot Summary

Replaces two per-epoch full-event-log scans in `buildTwinSnapshot` with bounded reads of two new incremental projections: `trailer_fuel` (milesSinceRefuel, folded from the existing pure `trailerFuelReducer`) and `induction_deadline` (packageId → epoch-minutes, LWW from `PackageInducted`). Optimizer epoch read cost for fuel/deadline is now O(live entity count), not O(event log length).

## What Was Built

### Task 1: induction-deadline reducer + schema DDL

- Created `packages/projections/src/reducers/induction-deadline.ts` — trivial LWW reducer keyed by `packageId`, closed switch + `assertNeverEvent`, pure `(state, event) => state`.
- Added `TrailerFuelTable` + `InductionDeadlineTable` to `ProjectionDatabase` interface in `schema.ts`.
- Added `"trailer-fuel"` + `"induction-deadline"` to `OPERATIONAL_PROJECTIONS` (drives the inline skip-gate and checkpoint reset automatically).
- Appended idempotent DDL to `PROJECTIONS_SCHEMA_SQL` AND `schema.sql` (byte-identical — schema-sql.test passes).
- 5 unit tests GREEN (empty fold, LWW semantics, multi-package, reference equality for no-ops).

### Task 2: key-scoped appliers + rebuild/serialize surface + bounded twin-snapshot reads

- Added `applyTrailerFuel` to `inline.ts`: loads only the affected trailer's row, seeds the reducer's `routes`+`inflight` from the already-persisted `geo_route`/`geo_inflight_trip` tables (M-4 pattern), folds with `trailerFuelReducer`, persists only `(trailer_id, miles_since_refuel)`. Also maintains `geo_inflight_trip` (insert on `TrailerDeparted`, delete on `TrailerArrivedAtHub`).
- Added `applyInductionDeadline`: loads only the affected package's row, folds with `inductionDeadlineReducer` (LWW), upserts. O(1) rows read per event.
- Both registered in `APPLIERS` — `applyInline` picks them up with zero additional loop code.
- Extended `OperationalTwin` interface + `readOperationalTwin` to read `trailer_fuel` + `induction_deadline`.
- Updated `rebuild.ts` TRUNCATE to include both new tables; `serializeTwin` now emits `trailerFuel` + `inductionDeadline` blocks (sorted by PK for byte-stability).
- Replaced `computeMilesSinceRefuel` + `buildInductionDeadlines` in `twin-snapshot.ts` with bounded `db.selectFrom("trailer_fuel"|"induction_deadline").selectAll().execute()` reads. Both full-log-scan functions removed. `readAll` import removed.
- 2 unit tests GREEN: cost-invariance (10-trailer vs 100-trailer state reads identical bounded count) + rebuild-equivalence (incremental applier output == full `trailerFuelReducer` fold, byte-identical via `canonicalRows`).

### Task 3: live==rebuilt witness + golden confirmation

- Extended `projections-golden-replay.int.test.ts` with `RouteRegistered` + `TrailerDeparted` + `TrailerArrivedAtHub` + `PackageInducted` seeds so the serialize surface now covers both new tables.
- Asserts `trailer_fuel.get(T1).miles > 0` (leg miles accrued) + `induction_deadline.get(D/E)` defined.
- Determinism goldens `3920accc` / `94689f99` / `edfa5a6d` confirmed byte-identical (all 33 determinism unit tests pass).

## Commits

| Hash | Message |
|------|---------|
| `3c4ed96` | feat(27-01): induction-deadline reducer + schema DDL for PERF-02 |
| `6644ce3` | feat(27-01): key-scoped appliers + bounded twin-snapshot reads (PERF-02) |
| `e06a860` | test(27-01): extend golden-replay int test with trailer_fuel + induction_deadline surface |
| `3efb5e8` | chore(27-01): export PERF-02 types + applier functions from projections index |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing `RouteRegistered` case in `inductionDeadlineReducer` closed switch**
- **Found during:** Task 1 typecheck
- **Issue:** The `induction-deadline.ts` reducer was missing `RouteRegistered` from the no-op cases; the closed switch + `assertNeverEvent` pattern requires all union members to be listed. TypeScript surfaced this as a TS2345 error.
- **Fix:** Added `case "RouteRegistered":` to the no-op arm.
- **Files modified:** `packages/projections/src/reducers/induction-deadline.ts`
- **Commit:** `3c4ed96`

**2. [Rule 2 - Missing geo_inflight_trip maintenance in applyTrailerFuel]**
- **Found during:** Task 2 implementation
- **Issue:** The `applyTrailerFuel` applier needed to maintain the `geo_inflight_trip` table (insert on `TrailerDeparted`, delete on `TrailerArrivedAtHub`) so that subsequent arrivals correctly resolve the leg distance. Without this, the rebuild path (which processes events in order from seq=0) would find an empty `geo_inflight_trip` and accrue 0 miles.
- **Fix:** Added `geo_inflight_trip` upsert on `TrailerDeparted` and delete on `TrailerArrivedAtHub` within `applyTrailerFuel`.
- **Files modified:** `packages/projections/src/runner/inline.ts`
- **Commit:** `6644ce3`

## Known Stubs

None — both projections are fully wired end-to-end (applier → schema → serializeTwin → twin-snapshot bounded reads).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: T-27-01 mitigated | `inline.ts:applyTrailerFuel` | `trailer_fuel` is bounded by live trailer count (M-4 delete on arrival removes the in-flight entry; fuel rows are one-per-trailer, not one-per-trip). Cost-invariance test witnesses. |
| threat_flag: T-27-02 mitigated | `inline.ts` + `test/` | rebuild-equivalence test witnesses byte-identical fold; live==rebuilt int test witnesses the DB path. |

## Self-Check: PASSED

- `packages/projections/src/reducers/induction-deadline.ts` — FOUND
- `packages/projections/src/runner/inline.ts` (applyTrailerFuel, applyInductionDeadline) — FOUND
- `packages/projections/src/schema.ts` (trailer_fuel, induction_deadline DDL) — FOUND
- `packages/projections/src/schema.sql` (byte-identical DDL) — FOUND
- `packages/projections/src/runner/rebuild.ts` (TRUNCATE + serializeTwin) — FOUND
- `packages/api/src/optimizer/twin-snapshot.ts` (bounded reads) — FOUND
- Commits `3c4ed96`, `6644ce3`, `e06a860`, `3efb5e8` — FOUND
- Determinism goldens `3920accc`/`94689f99`/`edfa5a6d` — BYTE-IDENTICAL (33/33 tests)
