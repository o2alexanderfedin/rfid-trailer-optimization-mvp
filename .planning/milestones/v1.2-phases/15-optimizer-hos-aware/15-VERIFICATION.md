---
status: passed
---

# Phase 15 Verification: Optimizer HOS-aware (SOFT awareness)

**Requirement:** OPT-HOS-01
**Branch:** `feature/phase-15-optimizer-hos-aware` (not merged, not pushed)
**Verified:** 2026-06-22

## Gate — ALL GREEN

| Gate | Command | Result |
|---|---|---|
| Build | `pnpm build` | PASS — 10/10 turbo tasks successful |
| Typecheck | `pnpm typecheck` | PASS — 0 errors (`tsc -p tsconfig.eslint.json --noEmit`) |
| Lint | `pnpm lint` | PASS — 0 problems (`eslint .`) |
| Tests | `pnpm test:all` | PASS — **132 test files, 1398 tests passed, 0 failed** (exit 0; unit + testcontainers integration + ui; ~472s) |

Baseline before this phase: 1386 tests. After: 1398 (+12 new Phase-15 tests).

Focused regression-guard run (subset of the full gate), all green:
- `graph/glpk-oracle.test.ts` + `flow/glpk-oracle.test.ts` (LP / min-cost-flow exact-optimum oracle).
- `load-planner/test/planner-vs-validator.property.test.ts` (200-seed planner↔validator agreement).
- `objective/select-plan.test.ts` (feasibility-gated selection keystone).

## Default weight reproduces prior plans/objective — stated explicitly

**PROVEN.** The default `restCost = 0` makes the new `rest` objective term contribute exactly `0` (`(restPenalty ?? 0) * 0`), and `total + 0 === total` for every finite value, so the objective value is byte-identical to pre-Phase-15. Evidence:

- `objective.test.ts > "DEFAULT reproduces prior behavior"` — an absent/explicit-but-unweighted `restPenalty`/`restCost` is a strict no-op; `breakdown.rest === 0`.
- `epoch.test.ts > "at the default weight, attaching driver info does NOT change the plan output"` — the same snapshot with vs without driver info yields identical per-trailer objective costs, identical breakdowns (`rest === 0`), and the same winning trailer + clock at the default weights.
- `epoch.test.ts > "every trailer's objective is identical for rested vs tired at the default weight"` — remaining-hours differences have zero objective effect until the weight is raised.
- The pre-existing optimizer suite (134 tests incl. both glpk oracles + select-plan) passes **unchanged**.

## Purity / determinism — stated explicitly

The optimizer remains PURE: `restPenalty` is integer math (`max(0, maxDriveMin − remainingDriveMinutes)`), read deterministically off the Phase-13 `driver_status` projection; no `Date.now()`, no RNG; sorted-by-id determinism preserved. `epoch.test.ts > "identical inputs ... ⇒ byte-identical result"` (with driver info + raised `restCost`) and the existing idempotency keystone tests pass.

## Success-criteria → evidence checklist

| # | Success criterion | Evidence | Status |
|---|---|---|---|
| 1 | The rolling-epoch snapshot includes `DriverStatus`. | `rolling/types.ts` `TwinDriver` + optional `TwinTrailer.driver` (exported via `rolling/index.ts`); `api/.../twin-snapshot.ts` reads `driver_status.remaining_drive_minutes` + `trailer_state.driver_id` and attaches `driver`; `twin-snapshot.test.ts` (attach / back-compat / fail-soft / determinism — 4 tests green). `epoch.ts` consumes it into `restPenalty`. | PASS |
| 2 | A `restCost` objective weight soft-prefers higher-remaining-hours drivers; default weight reproduces prior plans (deterministic). | `objective/types.ts` (`restCost?`, `restPenalty?`, `rest` breakdown); `objective.ts` (`rest` term); `weights.ts` (`restCost: 0`); `epoch.ts` (`restPenalty` derivation). `objective.test.ts` + `epoch.test.ts`: default-reproduces-prior (keystone) AND raising `restCost` makes the tired driver's trailer cost strictly more (preference). | PASS |
| 3 | glpk LP oracle + planner-vs-validator property tests stay green. | `graph/glpk-oracle.test.ts`, `flow/glpk-oracle.test.ts`, `load-planner/.../planner-vs-validator.property.test.ts` all green in the focused run AND the full `test:all`; none edited. | PASS |

## Requirement → evidence

| Req | Evidence | Status |
|---|---|---|
| **OPT-HOS-01** — consume `DriverStatus` in the rolling-epoch snapshot + soft `restCost` weight (default 0) | Snapshot: `TwinDriver`/`TwinTrailer.driver` + `buildTwinSnapshot` `driver_status` read. Objective: optional `restCost`/`restPenalty` + `rest` term, default 0. Epoch: deterministic `restPenalty` from the driver. Tests: `objective.test.ts` (5 new), `epoch.test.ts` (4 new), `twin-snapshot.test.ts` (4 new) — all green. | PASS |

## Conclusion
All 3 success criteria met, OPT-HOS-01 satisfied, the full `test:all` gate is green (unit + testcontainers integration + ui), the default weight provably reproduces prior plans/objective byte-identically, and the glpk oracle + planner-vs-validator regression guards stay green unchanged. The optimizer stays pure/deterministic and SOFT-only (neutral by default), as required for the Phase-16 stepping-stone. **Status: passed.**
