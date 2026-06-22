# Phase 7: Time-Aware Optimizer — Summary

**Completed:** 2026-06-21 · **Branch:** `feature/v1.1-realistic-time-model` · **Status:** ✅ COMPLETE & verified.

## What was delivered

| REQ | Status | Notes |
|-----|--------|-------|
| **OPT-09** — optimizer plans against expected dwell + transit | ✅ Done | The rolling optimizer no longer uses a flat `TRANSIT_MIN=30`. `TwinRoute.travelMin` (the single upstream source feeding BOTH the time-expanded min-cost-flow graph AND the VRPTW oracle) is now per-leg **expected transit**; VRPTW `RouteStop.serviceMin` carries **role-based expected dwell** (center vs spoke, one per stop, no double-count). Changing the timing config changes the plan. |
| **OPT-10** — deterministic estimate from the shared config | ✅ Done | The planning estimate is the log-normal **MEAN** via the single pure `expectedMinutes` in `@mm/domain` (with VIZ-06's ORS-`duration_s` as the per-leg source, haversine fallback). Integer-rounded at the graph boundary (anti-P12). Identical inputs ⇒ identical plan. |

## Architecture

- The geography→transit derivation (`haversineKm`, `transitParamsForLeg`, `expectedTransitMinutes`, `expectedDwellMinutes`) was moved into **`@mm/domain`** (`fa02cf7`) — the leaf both `@mm/simulation` and `@mm/optimizer` import — so there is ONE source of truth and no circular dependency. `@mm/simulation` re-imports it (byte-identical, golden-replay keystone untouched).
- The optimizer's two time surfaces are fed from one value: `TwinRoute.travelMin` in `@mm/api`'s `twin-snapshot.ts` (`c36a7fb`). Both `epoch.ts buildTravelModel` (VRPTW oracle) and `freight-stage.ts` (flow-graph `OptimizerRoute.travelMin`) read it verbatim.
- DIP injection added (`EpochInput.timing?`, `TwinSnapshot.centerHubId?`) — additive, non-breaking.

## Verification (independently re-run by the orchestrator)

- `pnpm build` 10/10 · `pnpm typecheck` 0 · `pnpm lint` 0
- **Unit: 949 passed** (incl. new `time-aware.test.ts` proving the plan shifts with timing, the estimate is the MEAN, integer-rounding, one-dwell-per-stop; glpk LP oracle + planner-vs-validator property tests green).
- **Integration: 82 passed / 20 files** — the `scenario-reopt` keystone + `projections-golden-replay` determinism keystone stayed green (structural assertions survived the realistic cost-model change; replay determinism intact).

## Key decisions

- Estimate = **MEAN** (`median·exp(σ²/2)`), not median/percentile (OPT-10) — unbiased vs realized throughput.
- Dwell modeled as VRPTW `serviceMin` only (not an additional flow-graph offset) to avoid double-counting against the existing `wait`/`hold` edges (PITFALLS P4).
- Realistic-absolute transit scale (user-confirmed) — the optimizer plans against real durations.

## Process note (the P6 lesson, applied)

The build workflow's gate/audit agents **timed out** on the ~30-min integration run and returned null — so the workflow could not self-confirm integration. The orchestrator therefore ran the integration keystones via **Bash** (no agent token limit) and confirmed green independently. Takeaway reinforced: long keystone suites must be run outside an agent's budget; never treat an audit as a substitute for running them.

## Incidental fix

`epoch.ts` carried 3 stray NUL bytes (used as Map-key separators — behavior-correct but flagged the file as binary, blocking grep/Edit); replaced with spaces (behavior-neutral).

## Commits

`fa02cf7` (S0 — geography derivation → `@mm/domain`) · `c36a7fb` (OPT-09 + OPT-10 — optimizer consumes expected timing) · `c65c45f` (plan).
