---
phase: 26-coordinator-optimizer
plan: 02
subsystem: optimization
tags: [coordinator, optimizer, runEpoch, reroute, partitionScopeByCenter, NET-05, determinism, COORD-06, rolling-loop]

# Dependency graph
requires:
  - phase: 26-01 (coordinator-optimizer adapter)
    provides: "buildCenterTwinFromFold + epochResultToRerouteSuggestions (the pure fold→twin→reroute adapter) + the CenterFoldSlice input family"
  - phase: 04 (rolling optimizer)
    provides: "the pure runEpoch + detectAffectedScope + partitionScopeByCenter contract"
  - phase: 25-coordinator
    provides: "stepCoordinators (the in-fold reroute generation branch) + decideCoordinatorSuggestions (the rule-based fallback) + the five guards"
provides:
  - "coordinatorUsesOptimizer SimulateOptions sub-flag (strict === true, gated on coordinatorsEnabled, default OFF)"
  - "the optimizer-backed REROUTE branch in stepCoordinators: detectAffectedScope → partitionScopeByCenter → buildCenterTwinFromFold → runEpoch (pure, in-fold) → epochResultToRerouteSuggestions"
  - "partitionScopeByCenter (NET-05) wired as the LIVE per-center epoch scope — its first live consumer"
  - "exceedsCoordinatorOptimizerScopeCap: the pure, deterministic integer scope-size fallback predicate (+ the named caps)"
  - "the global RollingLoop disabled under the coordinator flag in makeSimRunner (no double-plan)"
affects: [26-03 (golden / determinism — bakes the optimizer-backed coordinator golden), 27 (continental reject-with-reason scenario tuning)]

# Tech tracking
tech-stack:
  added: ["@mm/optimizer value imports (detectAffectedScope, partitionScopeByCenter, runEpoch, DEFAULT_OBJECTIVE_WEIGHTS) into @mm/simulation engine.ts"]
  patterns:
    - "In-fold pure runEpoch: a per-center epoch built from FROZEN engine fold state, run SYNCHRONOUSLY in sorted-centerId order over pure inputs — never the async worker (ARCHITECTURE §5B; §5A async REJECTED)"
    - "Source-swap-only sub-flag: coordinatorUsesOptimizer changes ONLY the reroute candidate SOURCE; hold/consolidate/dispatch + the guard/emit path are untouched"
    - "Deterministic integer scope-size fallback: a pure predicate over slice.hubIds/trailerIds length, never wall-clock — the in-fold cost guard"

key-files:
  created:
    - packages/simulation/test/coordinator-optimizer.unit.test.ts
  modified:
    - packages/simulation/src/engine.ts
    - packages/api/src/sim/driver.ts
    - packages/api/src/server.ts
    - packages/api/src/sim/driver.test.ts

key-decisions:
  - "Reroute-driving events are synthetic TrailerArrivedAtHub events naming {congested-next-hub, trailer} derived from the FROZEN observation's congestion signal (the SAME signal the rule-based reroute reads) — so the optimizer reacts to the identical trigger, deterministically"
  - "The per-center twin's trailer route HEAD is the center (stopIndex 0) — the cross-dock relief target the optimizer endorses; epochResultToRerouteSuggestions reads route[0] as the chosen next hub"
  - "Scope-size cap exposed as the exported pure predicate exceedsCoordinatorOptimizerScopeCap so the engine + the fallback test share ONE canonical threshold (DRY, no drift)"
  - "The global-loop disable gate lives in makeSimRunner (driver.ts) — testable in isolation; the RollingLoop is still CONSTRUCTED at the server root (the scenario re-opt path uses it) but its per-tick global drive is disabled under the flag"

patterns-established:
  - "Pattern 1: optimizer-backed reroute = detectAffectedScope → partitionScopeByCenter(.get(centerId)) → buildCenterTwinFromFold → runEpoch → epochResultToRerouteSuggestions, merged reroute-first with the rule-based non-reroute candidates byte-stably"
  - "Pattern 2: NET-05 live — a center's per-epoch scope is bounded by that center's own hubs/trailers, independent of total network size (the scope-size-invariance witness)"
  - "Pattern 3: two-part flags-off gate for a SUB-flag — coordinatorsEnabled && opts.X === true; absent ⇒ zero behavior change, every golden byte-identical"

requirements-completed: [COORD-06]

# Metrics
duration: 14min
completed: 2026-06-27
---

# Phase 26 Plan 02: Coordinator ↔ Optimizer Engine Wiring Summary

**Under the new `coordinatorUsesOptimizer` sub-flag, `stepCoordinators` now sources its REROUTE suggestions from a per-center PURE `runEpoch` (built from frozen fold state, scoped live via `partitionScopeByCenter` / NET-05, with a deterministic integer scope-size fallback to the rule-based reroute) while hold/consolidate/dispatch stay rule-based — and the global `RollingLoop` is disabled under the flag so the two plan sources never double-plan.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-06-27T04:36:50Z
- **Completed:** 2026-06-27T04:50:57Z
- **Tasks:** 3 (Task 2 was RED → GREEN)
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments
- Added the `coordinatorUsesOptimizer` `SimulateOptions` sub-flag (strict `=== true`, gated on `coordinatorsEnabled`, default OFF) and wired the optimizer-backed reroute branch into `stepCoordinators`: per center, build the congestion-driven events from the frozen observation, `detectAffectedScope` → `partitionScopeByCenter` → take this center's slice (the NET-05 live wiring) → `buildCenterTwinFromFold` → `runEpoch` SYNCHRONOUSLY IN-FOLD (default weights) → `epochResultToRerouteSuggestions`. Hold/consolidate/dispatch stay rule-based; the merged candidates flow through the EXISTING guard/emit/lease/pending path unchanged.
- Wired `partitionScopeByCenter` (NET-05, built in Phase 23, previously UNWIRED) as the live per-center epoch scope — its first live consumer. Proved the scope-size invariant now governs a live epoch: a fixed center's reroute set is byte-identical whether or not unrelated centers/hubs/trailers exist.
- Added the deterministic integer scope-size fallback: `exceedsCoordinatorOptimizerScopeCap` (a pure predicate over `slice.hubIds.length` / `slice.trailerIds.length` vs the named caps). Over-cap ⇒ the rule-based reroute for that center (NO `runEpoch` call) — a documented threshold, never wall-clock (T-26-07).
- Disabled the global `RollingLoop` under the coordinator flag in `makeSimRunner`: when `coordinatorUsesOptimizer` is on, the per-tick runner is a no-op (`loop.tick` never invoked), so the global optimizer and the per-center coordinators never double-plan (T-26-05). Off/absent ⇒ the loop runs exactly as today.
- Determinism preserved: sub-flag OFF/absent ⇒ byte-identical to the Phase-25 coordinator golden `edfa5a6d…` (6/6 golden tests GREEN) AND the flags-off `3920accc…` / OODA-on `94689f99…`; sub-flag ON is same-seed byte-identical (REPRODUCIBLE; the optimizer-backed golden is baked in Plan 03).

## Task Commits

Each task was committed atomically:

1. **Task 1: coordinatorUsesOptimizer flag + the optimizer-backed reroute branch** - `aee0415` (feat)
2. **Task 2 RED: failing test for the deterministic scope-size cap fallback** - `41528d9` (test)
3. **Task 2 GREEN: exceedsCoordinatorOptimizerScopeCap + the cap fallback wiring** - `4239e9e` (feat)
4. **Task 3: disable the global RollingLoop under the coordinator flag** - `f96bfaa` (feat)

_No refactor commits — the GREEN implementations were minimal/clean. Task 3 was amended twice for a stricter-typecheck fix (test mock typing) and a lint fix (unused-param), both within the same task._

## Files Created/Modified
- `packages/simulation/src/engine.ts` (modified) — the `coordinatorUsesOptimizer` sub-flag + read; the COORD-06 named constants (freeze window 15 min, leg travel 30 min, trailer cap 50 / route cap 200 mirroring the API twin-snapshot, scope-size caps 64/64); the `@mm/optimizer` value imports; `buildCenterOfMap` + `optimizerRerouteFor` (the in-fold per-center pipeline); the exported `exceedsCoordinatorOptimizerScopeCap` predicate; the candidate-merge branch in `stepCoordinators`.
- `packages/simulation/test/coordinator-optimizer.unit.test.ts` (created, 314 lines) — engine-level: reroute sourced from the optimizer, hold/consolidate persist, same-seed byte-identical, off-path inertness (absent flag + coordinators-off); NET-05 scope-size-invariance witness (a fixed center's reroute set unchanged by unrelated network growth, the slice bounded by its own hubs/trailers); Task-2 fallback: sub-cap ⇒ optimizer path, over-cap (hubs OR trailers) ⇒ fallback, the verdict a pure function of integer scope size.
- `packages/api/src/sim/driver.ts` (modified) — `coordinatorUsesOptimizer` on `SimRunnerOptions` + `DriveSimulationOptions`; `makeSimRunner` returns the no-op runner under the flag; threaded through all three `makeSimRunner` call sites.
- `packages/api/src/server.ts` (modified) — documented the loop-disable decision at the `RollingLoop` composition root (the gate lives in `makeSimRunner`; the loop is still constructed for the scenario re-opt path).
- `packages/api/src/sim/driver.test.ts` (modified) — the COORD-06 gate tests: `loop.tick` NOT called when the flag is on; STILL called when off/absent (strict `=== true`, backward-compatible).

## Decisions Made
- **Reroute-driving events mirror the rule-based congestion signal.** The optimizer reacts to the SAME deterministic trigger the Phase-25 rule reads — an in-region truck whose next hub (≠ this center) is congested beyond `COORDINATOR_THRESHOLDS.congestionQueueDepth`. Each becomes a synthetic `TrailerArrivedAtHub` naming `{trailerId, congested-next-hub}`, so `detectAffectedScope` pulls both into scope. This keeps the optimizer path a route-aware REPLACEMENT of the same decision, not a different trigger.
- **The twin route head IS the cross-dock relief center.** Each in-scope trailer's twin route is `[center(stopIndex 0), current-next-hub(stopIndex 1)]`, so `epochResultToRerouteSuggestions` reads `route[0] = center` as the optimizer's chosen next hub and emits a reroute to the center only when the recommendation is actionable (feasible + not frozen) AND the optimizer-next differs from the current next (anti-P7 no-churn, inherited from Plan 01's translator).
- **The scope-size cap is an exported pure predicate.** `exceedsCoordinatorOptimizerScopeCap(slice)` is the single canonical threshold the engine branch AND the fallback test call (DRY — no drift between code and test), and it is provably a pure function of the integer slice size.
- **The loop-disable gate lives in `makeSimRunner`, not the `RollingLoop` construction.** This is the precise, testable choke point every driver path funnels through; the `RollingLoop` is still constructed at the server root because the scenario re-opt path consumes it directly. Documented at the server composition root.

## Deviations from Plan

**None — plan executed exactly as written.**

The plan granted Claude discretion on the per-center twin shape, the reroute event source, the horizon cap value, and the fallback threshold; all were realized within that discretion (documented in Decisions Made above). The Plan-01 translator's 3-arg signature `(result, twin, currentNextHubByTrailer)` (the documented Plan-01 deviation) was honored as-is. No bugs, missing critical functionality, blocking issues, or architectural changes were encountered.

## Issues Encountered
- **Repo-root-relative vitest path filter** (carried from 26-01): `pnpm --filter @mm/api exec vitest run <path>` finds no files because the include globs are repo-root-relative. Resolved by running from the repo root: `pnpm exec vitest run packages/api/src/...`.
- **`typecheck` gate is stricter than build/lint/vitest** (the `typecheck-gate-separate-from-build-lint` memory): the full `pnpm typecheck` (`tsconfig.eslint.json`) caught a `vi.fn(() => ...)` whose `mock.calls[0]` typed to `[]` (no args), where build/vitest passed. Resolved by typing the mock's parameter (and then capturing `simMs` inside the mock to satisfy the no-unused-vars lint rule, since underscore-prefix is not honored by this eslint config).

## Verification Results
- `pnpm exec vitest run packages/simulation/test/coordinator-optimizer.unit.test.ts` — 14/14 GREEN
- `pnpm exec vitest run packages/simulation/test/coordinator-determinism.unit.test.ts` — 6/6 GREEN (the `edfa5a6d…` coordinator golden + the flags-off/OODA-on distinctness, sub-flag absent ⇒ byte-identical)
- `pnpm exec vitest run .../coordinator-engine.unit.test.ts + determinism.unit.test.ts` — GREEN (no regression; 65 sim tests in the lane)
- `pnpm exec vitest run packages/api/src/optimizer/live-loop.test.ts packages/api/src/sim/driver.test.ts` — 45/45 GREEN (loop.tick NOT invoked under the flag; STILL invoked off/absent)
- `pnpm typecheck` (full monorepo) — exit 0
- `pnpm --filter @mm/simulation lint` + `pnpm --filter @mm/api lint` — exit 0
- Sub-flag ON: same-seed byte-identical (deep-equal two runs) confirmed in both the engine and fallback suites
- TDD gate sequence in git log: `test(...)` (`41528d9`) precedes `feat(...)` (`4239e9e`) for Task 2

## Known Stubs
None — the optimizer-backed reroute branch is fully wired (real fold state → real per-center twin → real `runEpoch` → real reroute suggestions); the fallback is a real deterministic predicate; the loop-disable is a real gate. No placeholder/empty-value paths.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 03 (golden / determinism) can now capture the optimizer-backed coordinator golden reproducibility-first: run `simulate({ ...coordinator-on stack, coordinatorUsesOptimizer: true })` twice (in-process + cross-process) and bake the SHA-256, plus pin the two-part flags-off gate (sub-flag absent ⇒ `edfa5a6d…`). The behavior is established here; Plan 03 pins it.
- NET-05's `partitionScopeByCenter` is now live; the scope-size-invariant test governs a live per-center epoch.
- The global RollingLoop / per-center coordinator double-plan conflict is resolved under the flag (Phase 27's continental reject-with-reason tuning can build on the coordinators owning the live plan).

## Self-Check: PASSED

- FOUND: packages/simulation/test/coordinator-optimizer.unit.test.ts
- FOUND: .planning/phases/26-coordinator-optimizer/26-02-SUMMARY.md
- FOUND commits: aee0415 (T1), 41528d9 (T2 RED), 4239e9e (T2 GREEN), f96bfaa (T3)

---
*Phase: 26-coordinator-optimizer*
*Completed: 2026-06-27*
