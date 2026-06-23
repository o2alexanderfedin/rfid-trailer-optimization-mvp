# Phase 15 Plan: Optimizer HOS-aware (SOFT awareness)

**Requirement:** OPT-HOS-01
**Branch:** `feature/phase-15-optimizer-hos-aware` (do NOT merge, do NOT push)
**Mode:** TDD (tests first → green → refactor). SOFT awareness only — default reproduces prior plans.

## Goal

Make the rolling-horizon optimizer **aware** of driver Hours-of-Service:
1. Feed Phase-13 `DriverStatus` (remaining legal drive minutes) into the rolling-epoch snapshot.
2. Add a **soft** `restCost` objective term that prefers assigning drivers with more remaining hours.

**The keystone constraint:** the default weight must reproduce prior plans + objective **byte-identically**, so the `glpk` LP oracle cross-check, the `planner-vs-validator` property tests, `select-plan`, and ALL existing optimizer tests stay green unchanged. Hard enforcement is Phase 16.

## Design decisions

### Snapshot side (where DriverStatus enters)
- Add a `TwinDriver` value shape (`driverId`, `remainingDriveMinutes`) and an **optional** `TwinTrailer.driver` field in `packages/optimizer/src/rolling/types.ts`. Optional + additive → every pre-Phase-15 (driverless) snapshot is unchanged.
- Extend `packages/api/src/optimizer/twin-snapshot.ts` to read the Phase-13 `driver_status` projection (`remaining_drive_minutes`, already computed by the Phase-10 HOS engine at projection time) and the `trailer_state.driver_id` link, attaching `driver` to each trailer whose trip has a bound driver with a status row. **Deterministic** read — no recompute, no `Date.now()`, no RNG; integer minutes (`Math.trunc`).
- **Reuse (cited analogs):** the Phase-10 engine's `remainingLegalDriveMinutes` is already materialized into `driver_status.remaining_drive_minutes` by the Phase-13 `driverStatusReducer`, so the snapshot reads the projection (the DRY, deterministic path) rather than recomputing. The attach logic mirrors the existing `departureMinByTrailer` map + per-trailer assembly in `buildTwinSnapshot`.

### Objective side (the soft term)
- Add an **optional** `restCost?: number` weight to `ObjectiveWeights` and an **optional** `restPenalty?: number` metric to `PlanMetrics` (`packages/optimizer/src/objective/types.ts`). Optional → every existing `ObjectiveWeights` / `PlanMetrics` literal compiles unchanged.
- Add a `rest` term to `objective` / `objectiveBreakdown` (`objective.ts`): `rest = (metrics.restPenalty ?? 0) * (weights.restCost ?? 0)`. With both neutral the product is exactly `0`; `total + 0 === total` for every finite value, so the objective is **byte-identical** to pre-Phase-15.
- Add `restCost: 0` to `DEFAULT_OBJECTIVE_WEIGHTS` (`weights.ts`) — explicit neutral default.
- In `runEpoch` (`epoch.ts`), derive `restPenalty = max(0, DEFAULT_HOS_CONFIG.maxDriveMin − remainingDriveMinutes)` from the trailer's `driver` (bounded by the FMCSA 11h ceiling; monotonic decreasing in remaining hours). A driverless trailer → `0`. This mirrors the existing `rehandleScoreFor` / `utilization` derivations in `metricsFor` (pure, integer, sorted-by-id determinism; no clock, no RNG).
- `ObjectiveBreakdown` gains a required `rest` field (always emitted by `objectiveBreakdown`, exactly 0 in the neutral case) so the breakdown stays additive and "breakdown sums to total" holds.

### Purity / determinism
- Optimizer stays PURE: no RNG, no `Date.now()`, integer costs, sorted-by-id determinism. `DriverStatus` is read deterministically from the projection.
- Wire the previously no-op driver-event handling into real DriverStatus consumption (the snapshot now carries the data; the epoch now reads it).

## Tasks (TDD)

| # | Task | Files | Tests |
|---|---|---|---|
| 1 | Objective `restCost` term + neutral default | `objective/types.ts`, `objective.ts`, `weights.ts` | `objective.test.ts` — default reproduces prior; `restPenalty × restCost`; preference; breakdown sums |
| 2 | `TwinDriver` + optional `TwinTrailer.driver`; epoch `restPenalty` derivation | `rolling/types.ts`, `rolling/index.ts`, `rolling/epoch.ts` | `epoch.test.ts` — default reproduces prior plan; raised weight prefers rested; purity |
| 3 | Snapshot reads `driver_status` + `trailer_state.driver_id` | `api/.../twin-snapshot.ts` | `twin-snapshot.test.ts` — attach, back-compat, fail-soft, determinism |
| 4 | Fix `ObjectiveBreakdown` fixtures (add `rest: 0`) | api optimizer/route test fixtures | typecheck green |

## Gate (ALL must be green)
`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:all`.

## Out of scope (Phase 16)
Hard HOS feasibility gate, `restMin`-as-`serviceMin` fold, reject-illegal-leg gate, `insertRestStop` / relay recommendation.
