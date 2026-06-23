# Phase 15 Summary: Optimizer HOS-aware (SOFT awareness)

**Requirement:** OPT-HOS-01
**Branch:** `feature/phase-15-optimizer-hos-aware` (not merged, not pushed)
**Completed:** 2026-06-22

## What was built

The rolling-horizon optimizer now **consumes driver Hours-of-Service** and **soft-prefers more-rested drivers** — strictly neutral by default. The default weight reproduces prior plans + objective byte-identically; the `glpk` LP oracle cross-check and the `planner-vs-validator` property tests stay green unchanged. This is the safe stepping-stone before Phase 16 hard enforcement.

### Snapshot — DriverStatus enters the twin
- `packages/optimizer/src/rolling/types.ts`: new `TwinDriver` (`driverId`, `remainingDriveMinutes`) + **optional** `TwinTrailer.driver`. Exported from `rolling/index.ts`.
- `packages/api/src/optimizer/twin-snapshot.ts`: reads the Phase-13 `driver_status` projection (`remaining_drive_minutes`, computed by the Phase-10 HOS engine at projection time) and the `trailer_state.driver_id` link, attaching `driver` to each bound trailer. A trailer with no `driver_id`, or whose `driver_id` has no status row, gets no `driver` field (additive, fail-soft, back-compatible). Deterministic — no recompute, no `Date.now()`, no RNG; integer minutes via `Math.trunc`.

### Objective — soft `restCost` term
- `packages/optimizer/src/objective/types.ts`: **optional** `restCost?` weight + **optional** `restPenalty?` metric; `ObjectiveBreakdown` gains a required `rest` field.
- `packages/optimizer/src/objective/objective.ts`: `rest = (restPenalty ?? 0) * (restCost ?? 0)`, added to `total`. Neutral case ⇒ `rest = 0` ⇒ `total` byte-identical to pre-Phase-15 (`x + 0 === x`).
- `packages/optimizer/src/objective/weights.ts`: `DEFAULT_OBJECTIVE_WEIGHTS.restCost = 0` (explicit neutral default).
- `packages/optimizer/src/rolling/epoch.ts`: `restPenalty = max(0, DEFAULT_HOS_CONFIG.maxDriveMin − remainingDriveMinutes)` per trailer (bounded by the FMCSA 11h ceiling; 0 for a driverless / fully-rested trailer). Patterned after the existing `rehandleScoreFor` / `utilization` derivations in `metricsFor` — pure, integer, sorted-by-id determinism.

### Test-fixture follow-through
- 6 `ObjectiveBreakdown` literals in `packages/api/src/optimizer/live-loop.test.ts` and `packages/api/src/routes/optimizer.test.ts` gained `rest: 0` (the new required field).

## Analogs patterned after (cited)
- **Remaining-minutes derivation:** reuses the Phase-10 `remainingLegalDriveMinutes` value already materialized into `driver_status.remaining_drive_minutes` by the Phase-13 `driverStatusReducer` (DRY — the snapshot reads the projection, does not recompute).
- **Snapshot attach:** mirrors the `departureMinByTrailer` map + per-trailer assembly already in `buildTwinSnapshot`.
- **Metric derivation:** mirrors `rehandleScoreFor(trailer, config)` / `route.utilization` in `metricsFor`.
- **Optional/additive contract fields:** mirrors the existing optional `centerHubId` / `timing` additive pattern in the rolling contracts.

## Gate result (all green)
- `pnpm build` — 10/10 turbo tasks.
- `pnpm typecheck` — 0 errors.
- `pnpm lint` — 0 problems.
- `pnpm test:all` — **132 test files, 1398 tests passed, 0 failed** (unit + testcontainers integration + ui). Baseline before this phase was 1386; +12 new Phase-15 tests.

## Regression guards confirmed green
- `packages/optimizer/src/graph/glpk-oracle.test.ts` + `packages/optimizer/src/flow/glpk-oracle.test.ts` (LP/min-cost-flow oracle) — green, untouched.
- `packages/load-planner/test/planner-vs-validator.property.test.ts` (200-seed property cross-check) — green, untouched.
- `packages/optimizer/src/objective/select-plan.test.ts` — green.
- The default weight reproduces prior plans/objective (proven by `epoch.test.ts` keystone tests).
