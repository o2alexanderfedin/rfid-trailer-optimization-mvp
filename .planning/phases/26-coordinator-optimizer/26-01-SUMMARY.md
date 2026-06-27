---
phase: 26-coordinator-optimizer
plan: 01
subsystem: optimization
tags: [coordinator, optimizer, runEpoch, twin-snapshot, reroute, determinism, NET-05, COORD-06]

# Dependency graph
requires:
  - phase: 04 (rolling optimizer)
    provides: "the pure runEpoch contract — TwinSnapshot / EpochResult / EpochRecommendation types"
  - phase: 25-coordinator
    provides: "the CoordinatorSuggestion closed union (reroute|hold|consolidate|dispatch) + observe.ts plain-data surface"
provides:
  - "buildCenterTwinFromFold(slice, nowMin): a PURE projection from one center's partitioned fold slice → a scoped @mm/optimizer TwinSnapshot"
  - "epochResultToRerouteSuggestions(result, twin, currentNextHubByTrailer): a PURE translator from an EpochResult → reroute-only CoordinatorSuggestion[]"
  - "the CenterFoldSlice plain-data input family (CenterFoldTrailer, CenterFoldRouteLeg) Plan 02 fills from the engine fold maps"
affects: [26-02 (engine wiring — stepCoordinators in-fold runEpoch + partitionScopeByCenter), 26-03 (golden / determinism)]

# Tech tracking
tech-stack:
  added: ["@mm/optimizer as a @mm/simulation runtime dependency (type-only import of the rolling contract)"]
  patterns:
    - "Pure fold→twin adapter: project an already-partitioned per-center slice into the optimizer's TwinSnapshot, mirroring buildTwinSnapshot OUTPUT shape but from fold state (never a full event-log scan)"
    - "Pure result→suggestion translator: read the optimizer's chosen next hub from the twin route head (route[0]) since the EpochResult payload carries no route geometry"

key-files:
  created:
    - packages/simulation/src/coordinator/optimize.ts
    - packages/simulation/src/coordinator/optimize.unit.test.ts
  modified:
    - packages/simulation/src/coordinator/index.ts
    - packages/simulation/package.json
    - packages/simulation/tsconfig.json
    - pnpm-lock.yaml

key-decisions:
  - "Translator reads the optimizer's chosen next hub from the TWIN route head (route[0].hubId), not the EpochResult — the PlanAccepted/PlanGenerated/EpochRecommendation payloads carry only ids/cost/feasibility/frozen, no route geometry"
  - "Translator signature is (result, twin, currentNextHubByTrailer) — the twin is the only deterministic source of route geometry; CONTEXT grants discretion on the reroute derivation"
  - "Reroute gate: feasible AND not frozen AND has a current next hub AND optimizer-next differs from current (anti-P7 no churn)"
  - "Added @mm/optimizer as a @mm/simulation dependency (type-only; no circular dep — optimizer depends only on @mm/domain + @mm/load-planner)"

patterns-established:
  - "Pattern 1: per-center fold slice → scoped TwinSnapshot, bounded by the slice (NET-05 scope-size invariance), pure + byte-identical"
  - "Pattern 2: optimizer-backed reroute generation reads the twin route head; only the reroute kind is produced (hold/consolidate/dispatch stay rule-based)"

requirements-completed: [COORD-06]

# Metrics
duration: 6min
completed: 2026-06-27
---

# Phase 26 Plan 01: Coordinator ↔ Optimizer Adapter Summary

**A pure in-fold adapter pair — `buildCenterTwinFromFold` (one center's partitioned fold slice → a scoped `@mm/optimizer` TwinSnapshot) + `epochResultToRerouteSuggestions` (an EpochResult → reroute-only CoordinatorSuggestions) — both byte-identical-reproducible, scope-size-invariant, and free of Date.now/Math.random/async.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-06-27T04:25:37Z
- **Completed:** 2026-06-27T04:31:45Z
- **Tasks:** 2 (each RED → GREEN)
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments
- `buildCenterTwinFromFold` projects a partitioned per-center fold slice into a small scoped `TwinSnapshot` — sorted-unique hubs (the self-consistent union of center + spokes + leg/stop/block hubs), `centerHubId`, 1:1 route legs, and trailers whose route is sorted by `stopIndex` with `departureMin = nowMin + departureOffsetMin` (integer, never `Date.now`).
- `epochResultToRerouteSuggestions` translates an `EpochResult` into reroute-only `CoordinatorSuggestion[]`: the optimizer's chosen next hub is the trailer's twin route head; a reroute fires only when the recommendation is actionable (feasible + not frozen), the trailer has a current next hub, and the optimizer next hub differs from it — output sorted by `targetAgentId`, pure.
- Proved NET-05 scope-size invariance: the twin a center produces is bounded by that center's slice, independent of total network size (byte-identical regardless of network scale).
- Re-exported both functions + the `CenterFoldSlice` input family from `coordinator/index.ts` — the tested contract Plan 02 wires into the engine fold.

## Task Commits

Each task was committed atomically (TDD RED → GREEN):

1. **Task 1 RED: buildCenterTwinFromFold failing test + @mm/optimizer dep wiring** - `8f6a9ff` (test)
2. **Task 1 GREEN: buildCenterTwinFromFold implementation** - `39e385d` (feat)
3. **Task 2 RED: epochResultToRerouteSuggestions failing test** - `a03eecc` (test)
4. **Task 2 GREEN: epochResultToRerouteSuggestions + barrel re-export** - `05198de` (feat)

_No refactor commits — both GREEN implementations were already minimal/clean._

## Files Created/Modified
- `packages/simulation/src/coordinator/optimize.ts` (created, 223 lines) - the two pure adapter functions + the `CenterFoldSlice`/`CenterFoldTrailer`/`CenterFoldRouteLeg` input types.
- `packages/simulation/src/coordinator/optimize.unit.test.ts` (created, 298 lines) - RED-first suite: twin shape from a fold slice, NET-05 scope-size invariance, purity/determinism (deep-equal + byte-identical), empty-trailers, reroute differs/same/frozen/infeasible/no-current-hub/sorted/empty cases.
- `packages/simulation/src/coordinator/index.ts` (modified) - re-export the new COORD-06 surface for Plan 02.
- `packages/simulation/package.json` (modified) - added `@mm/optimizer` as a dependency.
- `packages/simulation/tsconfig.json` (modified) - added the `../optimizer` project reference.
- `pnpm-lock.yaml` (modified) - lockfile update for the new workspace dependency.

## Decisions Made
- **Optimizer next hub is read from the twin, not the EpochResult.** Investigating the contract showed `PlanAccepted`/`PlanGenerated` (domain schemas) and `EpochRecommendation` carry only `{epochId, scopeHash, planId, trailerId, objectiveCost?, feasible, frozen}` — **no route geometry**. The only deterministic source of a trailer's planned next leg is the `TwinSnapshot` the epoch planned over, so the translator reads `route[0].hubId` (the `stopIndex`-0 head that `buildCenterTwinFromFold` already sorts).
- **Translator signature is `(result, twin, currentNextHubByTrailer)`** (a 3-arg shape) rather than the plan's literal 2-arg `(result, currentNextHubByTrailer)`, because the twin is the route-geometry source. CONTEXT explicitly grants Claude's discretion on the reroute-result→suggestion derivation; this is the faithful, pure realization. Documented in the function's doc comment.
- **Reroute is anti-churn (anti-P7):** emitted only on an actionable + changed plan (feasible, not frozen, has a current next hub, optimizer-next ≠ current-next); same/frozen/infeasible/between-legs ⇒ no suggestion.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added @mm/optimizer as a @mm/simulation dependency**
- **Found during:** Task 1 (buildCenterTwinFromFold)
- **Issue:** The plan's `key_links` require `coordinator/optimize.ts` to import the `@mm/optimizer` rolling contract types, but `@mm/optimizer` was not a dependency of `@mm/simulation` (only `@mm/domain` was) — the import would not resolve and typecheck would fail.
- **Fix:** Added `"@mm/optimizer": "workspace:*"` to `packages/simulation/package.json` dependencies and the `../optimizer` project reference to `tsconfig.json`; ran `pnpm install`. Verified no circular dependency (optimizer imports only `@mm/domain` + `@mm/load-planner`; nothing in optimizer imports `@mm/simulation`). The import is type-only, so it adds no runtime coupling.
- **Files modified:** packages/simulation/package.json, packages/simulation/tsconfig.json, pnpm-lock.yaml
- **Verification:** `pnpm install` clean; typecheck exit 0 across simulation + optimizer; the import resolves.
- **Committed in:** 8f6a9ff (Task 1 RED commit)

**2. [Plan-intent interpretation] Translator takes the twin as a third argument**
- **Found during:** Task 2 (epochResultToRerouteSuggestions)
- **Issue:** The plan's literal signature `(result, currentNextHubByTrailer)` cannot yield a next hub — the `EpochResult` carries no route geometry.
- **Fix:** Added the `twin` (the same snapshot the epoch planned over) as the route-geometry source, per CONTEXT's discretion grant. Pure + documented.
- **Files modified:** packages/simulation/src/coordinator/optimize.ts, optimize.unit.test.ts
- **Verification:** 10 tests GREEN; the derivation is deterministic and byte-identical.
- **Committed in:** a03eecc (RED) / 05198de (GREEN)

---

**Total deviations:** 2 (1 blocking dependency wiring, 1 plan-intent interpretation within the granted discretion)
**Impact on plan:** Both necessary for a correct, pure adapter. No scope creep — only the reroute kind is produced; no engine wiring (that is Plan 02).

## Issues Encountered
- The vitest path filter is repo-root-relative (`packages/*/src/**/*.test.ts`), so `pnpm --filter @mm/simulation exec vitest run <path>` finds no files. Resolved by running from the repo root: `pnpm exec vitest run packages/simulation/src/coordinator/optimize.unit.test.ts`.
- ESLint flagged unnecessary type assertions in the purity test's `Object.freeze` helper. Resolved by deep-freezing the slice in place (no casts) — which also makes the non-mutation proof stronger (a write would throw).

## Verification Results
- `pnpm exec vitest run packages/simulation/src/coordinator/optimize.unit.test.ts` — 10/10 GREEN
- Full coordinator suite — 66/66 GREEN (no regression)
- `pnpm typecheck` (simulation + optimizer via `tsc -b`) — exit 0
- `pnpm --filter @mm/simulation lint` (coordinator/** DET-03 guard) — exit 0
- TDD gate sequence in git log: `test(...)` precedes `feat(...)` for both tasks

## Known Stubs
None — both functions are fully implemented; no placeholder/empty-value paths.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The pure contract for Plan 02 is ready: Plan 02 fills `CenterFoldSlice` from the engine fold maps (via `partitionScopeByCenter`), calls `buildCenterTwinFromFold` + `runEpoch` in-fold at a deterministic tick in sorted center order, and feeds `epochResultToRerouteSuggestions` into `stepCoordinators`'s reroute branch under the `coordinatorUsesOptimizer` sub-flag.
- No engine.ts change in this plan (file ownership respected — this plan owns only `coordinator/optimize.ts` + its test + the index re-export).

## Self-Check: PASSED

- FOUND: packages/simulation/src/coordinator/optimize.ts
- FOUND: packages/simulation/src/coordinator/optimize.unit.test.ts
- FOUND: .planning/phases/26-coordinator-optimizer/26-01-SUMMARY.md
- FOUND commits: 8f6a9ff (T1 RED), 39e385d (T1 GREEN), a03eecc (T2 RED), 05198de (T2 GREEN)

---
*Phase: 26-coordinator-optimizer*
*Completed: 2026-06-27*
