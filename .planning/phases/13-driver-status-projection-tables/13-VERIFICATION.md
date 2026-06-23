---
status: passed
---

# Phase 13 Verification: Driver-status projection + tables

**Requirements:** PRJ-01, PRJ-02
**Branch:** `feature/phase-13-driver-status-projection-tables` (not merged, not pushed)
**Verified:** 2026-06-22

## Gate — ALL GREEN

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm build` | PASS — 10/10 turbo tasks successful |
| Typecheck | `pnpm typecheck` | PASS — 0 errors (`tsc -p tsconfig.eslint.json --noEmit`) |
| Lint | `pnpm lint` | PASS — 0 problems (`eslint .`) |
| Tests | `pnpm test:all` | PASS — **130 test files, 1356 tests passed, 0 failed** (exit 0; unit + testcontainers integration + ui; 1453s) |

Focused evidence runs (subsets of the full gate):
- Unit project alone: 97 test files, **1089 tests passed** (incl. the new
  `driver-status.unit.test.ts` and the extended `reducers.unit.test.ts`, and the
  simulation determinism goldens).
- Driver replay-determinism + existing projection golden/idempotency int tests
  (testcontainers Postgres): **6 tests passed**
  (`driver-status-golden-replay`, `projections-golden-replay`,
  `projections-idempotency`).
- Projection-consumer int tests (regression): `queries`, `zone-projections`,
  `projections-audit-geo` — **18 tests passed** after the `trailer_state.driver_id`
  + index schema change.

## Replay determinism (live == rebuilt) — stated explicitly

**PASSES.** `packages/api/test/driver-status-golden-replay.int.test.ts` builds the
driver read models LIVE (append seeded driver-lifecycle stream + inline apply,
read-your-writes), captures the deterministic sorted-key `serializeTwin`, then
INDEPENDENTLY rebuilds by TRUNCATEing the projection tables, resetting checkpoints
to 0, and replaying `readAll(0n)` strictly by `global_seq` through the SAME
`applyInline`. It asserts the rebuilt serialization is **BYTE-IDENTICAL** to the
live one (and a second rebuild is identical). The driver read models are now part
of `serializeTwin`, so the byte-identity covers `driver_status`,
`driver_assignment`, and `trailer_state.driver_id`.

## Simulation determinism goldens — unaffected (confirmed)

This phase touches ONLY the projection read side; it emits no events and changes
no simulation behavior. `determinism.unit.test.ts`, `hos-determinism.unit.test.ts`,
and `rfid-determinism.unit.test.ts` were **NOT edited** and pass **unchanged** in
the unit run. The new reducers read time exclusively from `occurredAt` / the
carried `HosClock` snapshot — no `Date.now()`, no RNG, no order-dependent logic.

## Success-criteria → evidence checklist

| # | Success criterion | Evidence | Status |
|---|---|---|---|
| 1 | `driverStatusReducer` folds driver events into one deterministic row per driver | `src/reducers/driver-status.ts` (pure, `assertNeverEvent` exhaustive switch); HOS fields derived via the Phase-10 engine; `test/driver-status.unit.test.ts` asserts row shape, HOS derivation, swap handoff, purity/determinism/immutability (all green) | PASS |
| 2 | `DriverStatusTable` + `DriverAssignmentTable` DDL, registered OPERATIONAL; `driver_id` on `trailer_state`; index on `trailer_state(current_hub_id)` | `schema.ts`/`schema.sql` (idempotent DDL, byte-identical via drift test); `OPERATIONAL_PROJECTIONS` lists `driver-status` + `driver-assignment`; `idx_trailer_state_current_hub`; `trailerStateReducer` stamps `driver_id`; `runner/inline.ts` threads upserts; `runner/rebuild.ts` truncates both | PASS |
| 3 | Live == rebuilt (replay determinism) for driver state | `driver-status-golden-replay.int.test.ts` byte-identical live-vs-rebuilt assertion (testcontainers Postgres), passes; second rebuild identical | PASS |

## Requirements → evidence

| Req | Evidence | Status |
|---|---|---|
| **PRJ-01** — pure `driverStatusReducer` (one row per driver; HOS-derived remaining/deadline via reuse) | `src/reducers/driver-status.ts` + `src/reducers/driver-assignment.ts`; reuses `remainingLegalDriveMinutes` / `isoToEpochMinutes` / `epochMinutesToIso` / `DEFAULT_HOS_CONFIG`; keyed off `occurredAt`; `driver-status.unit.test.ts` (green) | PASS |
| **PRJ-02** — tables + OPERATIONAL registration + inline upserts + `trailer_state.driver_id` + `current_hub_id` index | `schema.ts`/`schema.sql`, `OPERATIONAL_PROJECTIONS`, `runner/inline.ts` (`applyDriverStatus`/`applyDriverAssignment`, `applyTrailerState` driver_id), `runner/rebuild.ts` (truncate + `serializeTwin`), `trailerStateReducer` stamping; `reducers.unit.test.ts` + the int replay test (green) | PASS |

## Conclusion
All 3 success criteria met, both requirements satisfied, full `test:all` gate green
(unit + testcontainers integration + ui), the replay-determinism (live == rebuilt)
test passes, and the simulation determinism goldens still pass unchanged.
**Status: passed.**
