---
phase: 23-multi-center-topology
plan: 04
subsystem: simulation
tags: [multi-center, topology, buildRoutes, centerOf, continentalTopology, backbone, scope-partition, determinism, tdd, flags-off-golden]

# Dependency graph
requires:
  - phase: 23 (plan 03)
    provides: "pure topology fns — generateBigCityHubs / pickRegionalCenters / assignSpokesToNearestCenter / buildBackbone (network/centers.ts)"
  - phase: 23 (plan 01)
    provides: "committed us-big-cities.generated.json — 92 continental big-city hubs"
provides:
  - "RouteTopology { centerOf, backbone } + optional `topology` arg on buildRoutes/buildTransitParamsByLeg (legacy byte-identical degeneration when absent)"
  - "continentalTopology / centerCount / legCapKm options on SimulateOptions (DEFAULT OFF, strict === true gate)"
  - "centerOf(spokeHubId) engine resolver — OFF => hubs[0] (byte-identical), ON => spoke's assigned center"
  - "cross-center freight flow: spoke -> origin center -> backbone -> dest center -> dest spoke (backbone hop in arriveConsolidationAtCenter)"
  - "additive centerHubId on arriveOverCarried/arriveConsolidation SimTask variants (absent => hubs[0]; continuation-equivalent)"
  - "partitionScopeByCenter(scope, centerOf, events) — per-center OptimizerScope slices (NET-05 scaling fix)"
affects: [23-05 (center-count checkpoint + 10k golden gate witness), 24-28 (read this topology + the per-center scope)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional-last-arg degeneration: a feature param added LAST to buildRoutes/buildTransitParamsByLeg/registerDriver/arriveAtCenter so absent === legacy byte-identical (the flags-off keystone), never restructuring the legacy branch"
    - "centerOf(spokeHubId) lookup collapses to hubs[0] when off — every legacy `center.hubId` call site is unchanged; the multi-center path is reached only behind the strict `=== true` flag"
    - "Additive optional task fields (centerHubId) on the serializable SimTask union — absent => hubs[0] fallback in the dispatcher — keep the continuation byte-identical AND resumable for the new path"
    - "Per-center scope partition derives trailer<->hub linkage from the SAME events the flat scope flattens away (one center never pulls another's trailers)"

key-files:
  created:
    - packages/simulation/test/network/routes.unit.test.ts
    - packages/simulation/test/multi-center-flow.unit.test.ts
    - packages/optimizer/src/rolling/scope-partition.test.ts
  modified:
    - packages/simulation/src/network/routes.ts
    - packages/simulation/src/engine.ts
    - packages/simulation/src/continuation.ts
    - packages/optimizer/src/rolling/scope.ts
    - packages/optimizer/src/rolling/index.ts

key-decisions:
  - "centerOf(spokeHubId) resolver: OFF returns the single hubs[0] center so every existing `center.hubId` consumption is byte-identical; ON returns the spoke's assigned center from assignSpokesToNearestCenter"
  - "Cross-center freight crosses the backbone INSIDE arriveConsolidationAtCenter: when centerOf(destSpoke) != arrivalCenter, emit a directed center->center TrailerDeparted + a re-staging arrival at the dest center, then distribute. The OFF path always takes the direct cross-dock (centerOf returns hubs[0])"
  - "The continentalTopology flag constructs NO new RNG substream (the topology is PURE committed data + deterministic fns) — so the flag-off run draws the exact same sequence and the 3920accc golden is byte-identical"
  - "partitionScopeByCenter takes the events (not just the flat scope) because the flat OptimizerScope flattens the trailer<->hub linkage; the events re-supply it so trailers bucket into the center(s) of the hubs THEY touched"

patterns-established:
  - "Optional-last-arg byte-identical degeneration (the flags-off keystone vehicle)"
  - "Strict `=== true` flag gate mirrored from outboundDeliveryEnabled — never ??/||"

requirements-completed: [NET-01, NET-05]

# Metrics
duration: ~50min
completed: 2026-06-26
---

# Phase 23 Plan 04: Multi-Center Engine Flow + Per-Center Scope Partition Summary

**`buildRoutes`/`buildTransitParamsByLeg` and the engine freight flow are generalized off the hard-wired single Memphis center to a `centerOf(spoke)` model behind the `continentalTopology` flag — byte-identical to the legacy single-center stream when off (the seed-42 10k golden `3920accc…` is unchanged), routing freight spoke → its center → backbone → dest center → dest spoke when on — and `detectAffectedScope` gains an additive `partitionScopeByCenter` so one center's epoch never pulls another's trailers.**

## Performance

- **Duration:** ~50 min
- **Started:** 2026-06-26T11:40Z
- **Completed:** 2026-06-26
- **Tasks:** 3 (all `type=tdd`: RED -> GREEN per task)
- **Files:** 8 (3 created, 5 modified)

## Accomplishments

- **NET-01 — multi-center route builders (Task 1).** `buildRoutes`/`buildTransitParamsByLeg` gained an OPTIONAL `topology` argument (added LAST so every existing caller is unchanged). When **absent**, the legacy single-center star branch runs EXACTLY as before — the test reconstructs today's directed-pair-per-spoke star and asserts deep equality (the flags-off keystone). When **present**, a `RouteTopology { centerOf, backbone }` is expanded by `topologyLegs` into sorted, deduped directed legs (spoke<->assigned-center + center<->center backbone), each via the UNCHANGED `applyRoadGeometry`/`routeId`/`ROUTE_POINTS`. `greatCircle` is untouched.
- **NET-01 — continentalTopology engine flow (Task 2).** `SimulateOptions` gained `continentalTopology?` (DEFAULT OFF, **strict `=== true`**) + `centerCount?`/`legCapKm?`. OFF ⇒ `hubs = USA_HUBS`, `buildRoutes(hubs)` (no topology), `centerOf` collapses to `hubs[0]` ⇒ the ENTIRE existing path is byte-identical. ON ⇒ `generateBigCityHubs()` + `pickRegionalCenters` + `assignSpokesToNearestCenter` + `buildBackbone` drive a `RouteTopology`; package creation, the induction deadline estimate, `departTrailer`, the over-carry/consolidation return legs, and the driver-pool home all resolve through `centerOf(spokeHubId)`. Cross-center freight **hops the backbone** (origin center → dest center) inside `arriveConsolidationAtCenter` before final center→spoke distribution. The new `centerHubId` task fields are ADDITIVE on the serializable `SimTask` union (absent ⇒ `hubs[0]`), proven continuation-equivalent.
- **NET-05 — per-center scope partition (Task 3).** `partitionScopeByCenter(scope, centerOf, events)` groups the flat `detectAffectedScope` result into per-center `OptimizerScope` slices: disjoint-by-center, each slice a subset of its center's hubs, the UNION equal to the flat scope (no hub lost), sorted + deduped (anti-P7). A **scope-size invariant** test proves a single-center event's slice is independent of the other centers' hub counts (the real scaling fix). `detectAffectedScope`/`hubsOf`/`trailersOf`/`sortedUnique` are UNCHANGED — the legacy flat scope is byte-identical.

## The Keystone Results (explicitly stated)

- **Legacy `Route[]` equivalence (Task 1):** `buildRoutes(USA_HUBS)` WITHOUT a topology is asserted deep-equal (id + order + endpoints) to the canonical single-center Memphis star, and `buildRoutes(USA_HUBS, undefined, undefined) === buildRoutes(USA_HUBS)`. Same for `buildTransitParamsByLeg`. **PASS.**
- **Flags-off golden (Task 2):** the seed-42 10,000-tick determinism golden `3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861` is **byte-identical** after all three tasks (`determinism.unit.test.ts`, 18 tests green). `continentalTopology: false` is byte-identical to the flag being absent over a seed-42 short run. **PASS.**
- **Per-center scope (Task 3):** disjoint-by-center + subset-of-center + union-equals-flat + scope-size-invariant + trailer-never-cross-pulled. **PASS** (6 tests).
- **No determinism leak:** engine `Date.now`/`Math.random` count UNCHANGED at 5 (all comments — no new clock/RNG). NO new RNG substream constructed for the topology (it is pure committed data).

## Task Commits

1. **Task 1 (RED):** `101e679` (test) — multi-center builders + legacy degeneration
2. **Task 1 (GREEN):** `b25c26c` (feat) — RouteTopology + topologyLegs + optional `topology` arg
3. **Task 2 (RED):** `7fa782b` (test) — continentalTopology flow + flags-off keystone
4. **Task 2 (GREEN):** `14021af` (feat) — centerOf(spoke) engine flow + backbone hop + additive task fields
5. **Task 3 (RED):** `d086041` (test) — per-center scope partition
6. **Task 3 (GREEN):** `765abc9` (feat) — partitionScopeByCenter

## TDD Gate Compliance

Each task is a full RED → GREEN cycle with the test commit preceding the feat commit:

- Task 1: `101e679` (test) → `b25c26c` (feat). RED verified: 7 multi-center assertions failed before the `RouteTopology`/`topologyLegs` implementation.
- Task 2: `7fa782b` (test) → `14021af` (feat). RED verified: the route-set + backbone-departure assertions failed while the flag was ignored.
- Task 3: `d086041` (test) → `765abc9` (feat). RED verified: `partitionScopeByCenter is not a function` (6 fails) before implementation.

No REFACTOR commits were needed (each GREEN landed clean: typecheck + lint green, all tests pass). Gate sequence (test → feat) satisfied for all three.

## Files Created/Modified

- `packages/simulation/src/network/routes.ts` *(modified)* — `RouteTopology` + `BackboneLeg` + `topologyLegs`; optional `topology` arg (last param) on `buildRoutes` + `buildTransitParamsByLeg`; legacy single-center branch verbatim.
- `packages/simulation/src/engine.ts` *(modified, +251 lines)* — `continentalTopology`/`centerCount`/`legCapKm` options; the topology bootstrap (hubs/centers/centerOf/backbone/routeTopology); the `centerOf(spokeHubId)` resolver; freight-flow + driver-home wiring through the spoke's center; the cross-center backbone hop.
- `packages/simulation/src/continuation.ts` *(modified)* — additive optional `centerHubId` on the `arriveOverCarriedAtCenter` + `arriveConsolidationAtCenter` `SimTask` variants.
- `packages/optimizer/src/rolling/scope.ts` *(modified, +79 lines)* — `partitionScopeByCenter` + `centerForHub`; `detectAffectedScope` unchanged.
- `packages/optimizer/src/rolling/index.ts` *(modified)* — re-export `partitionScopeByCenter`.
- `packages/simulation/test/network/routes.unit.test.ts` *(created, 13 tests)*.
- `packages/simulation/test/multi-center-flow.unit.test.ts` *(created, 7 tests, incl. continuation-equivalence)*.
- `packages/optimizer/src/rolling/scope-partition.test.ts` *(created, 6 tests)*.

## Decisions Made

- **`centerOf(spokeHubId)` collapses to `hubs[0]` when off** — the single mechanism that makes every legacy `center.hubId` consumption byte-identical without restructuring the engine. The flag is read with a strict `=== true` (mirroring `outboundDeliveryEnabled`).
- **Cross-center freight crosses the backbone inside `arriveConsolidationAtCenter`** — when the dest spoke's center differs from the arrival center, a directed center→center `TrailerDeparted` + a re-staging arrival at the dest center precede the final center→spoke distribution. This is the observable `spoke → origin center → BACKBONE → dest center → dest spoke` flow; the OFF path always takes the direct cross-dock.
- **No new RNG substream for the topology** — `pickRegionalCenters`/`assignSpokesToNearestCenter`/`buildBackbone` are pure functions of committed data, so the flag-off run draws the identical sequence and the golden holds. The backbone hop reuses the existing `timingRng` transit draw in deterministic queue order.
- **`partitionScopeByCenter` takes the events** — the flat `OptimizerScope` flattens the trailer↔hub linkage; the events re-supply it so a trailer buckets into the center(s) of the hubs it touched (never replicated into an unrelated center).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Over-specified geometry-vertex-count assertion in the routes test**
- **Found during:** Task 1 GREEN.
- **Issue:** The RED test asserted every legacy leg's geometry has exactly `ROUTE_POINTS` (24) vertices. The committed `road-geometry.generated.json` provides a real road LineString (40 vertices) for `MEM->ORD`, so a legacy leg can be longer than the great-circle density — that is the EXISTING byte-identical behavior the flags-off keystone preserves.
- **Fix:** Relaxed the legacy assertion to `geometry.length >= 2` with endpoints snapped to hub coords; the shape/order/id deep-equality (the actual keystone) is unchanged. The multi-center fixture legs (not in the road file) still assert exactly 24 great-circle points.
- **Files modified:** `packages/simulation/test/network/routes.unit.test.ts`
- **Committed in:** `b25c26c` (folded into Task 1 GREEN).

**2. [Rule 3 - Blocking] Cross-center backbone freight requires the consolidation path**
- **Found during:** Task 2 GREEN (the backbone-departure assertion was RED with `inductionEnabled` only).
- **Issue:** The backbone hop lives in `arriveConsolidationAtCenter`, which only runs when `consolidationEnabled`. With induction alone, inducted spoke→spoke freight is never staged for a spoke→center leg, so no backbone hop fires — the cross-center witness could not be produced.
- **Fix:** Enabled `consolidationEnabled: true` (alongside `inductionEnabled`) in the multi-center flow test + lengthened the horizon so at least one cross-center package completes its multi-leg journey. This matches the plan's intended `spoke -> center -> backbone -> center -> spoke` flow (consolidation IS the spoke→center return path). No production change — the engine's consolidation/induction flags are unchanged.
- **Files modified:** `packages/simulation/test/multi-center-flow.unit.test.ts`
- **Committed in:** `14021af` (folded into Task 2 GREEN).

### Additive (beyond-plan, in-scope) hardening

- Added a **continuation-equivalence** assertion to the multi-center flow test (chunked `runToHorizon` === all-at-once for the continental+consolidation run), proving the new `centerHubId` task fields + the backbone-hop tasks serialize + resume byte-identically. The plan listed the additive task fields; this is the witness they hold across a chunk boundary.

---

**Total deviations:** 2 auto-fixed (1 test bug, 1 blocking test setup). Both are test-side; no production behavior was changed by either. Every stated acceptance criterion is met.

## Requirements Completed

- **NET-01** — `buildRoutes`/`buildTransitParamsByLeg` + the engine freight flow generalized off `USA_HUBS[0]` to a `centerOf(spoke)` model behind `continentalTopology`; legacy `Route[]` byte-identical; freight flows spoke → center → backbone → center → spoke when on.
- **NET-05** — `detectAffectedScope` gains an additive per-center partition (`partitionScopeByCenter`) so one center's epoch never pulls another center's trailers; proven disjoint-by-center + scope-size-invariant.

## Threat Model Coverage

- **T-23-09 (Tampering — flags-off drift / anti-P8):** mitigated. `buildRoutes`/`buildTransitParamsByLeg` degenerate byte-identically (deep-equal test); the engine reads the flag with strict `=== true`; explicit-false === absent asserted here; the seed-42 10k golden `3920accc…` is byte-identical (the 23-05 gate is the longer witness). NO new RNG substream is constructed for the topology.
- **T-23-10 (Tampering — scope-detector misclassification / anti-P15):** mitigated. `partitionScopeByCenter` is disjoint-by-center + scope-size-invariant + trailers never cross-pulled, all proven by tests; additive (legacy `detectAffectedScope` unchanged when no partition is applied).
- **T-23-11 (Tampering — float divergence from new great-circle legs / anti-P2):** mitigated. Geometry stays out of hashed decisions (`greatCircle` untouched, used for the map only); transit minutes are rounded at the boundary as today (`transitParamsForLeg`/`transitParamsFromDuration` unchanged); ids/integers drive decisions.

## Known Stubs

None. All three deliverables are fully wired and independently tested. The empirical `centerCount` value (a real continental run) + the committed partition snapshot are plan 23-05's checkpoint by design; `DEFAULT_CENTER_COUNT = 6` is a documented default, never a hard-coded selection literal.

## Next Phase Readiness

- Plan 23-05 (the center-count checkpoint) consumes this flag-gated flow to run a real continental simulation, finalize the empirical `centerCount`, commit the partition snapshot, and assert the **10k-tick continental golden on a small fixture** — and re-assert the seed-42 single-center golden `3920accc…` stays byte-identical (the witness this plan already holds green).
- Phases 24-28 read this topology + the per-center scope (`partitionScopeByCenter`) as the substrate for OODA agents, coordinators, and the consolidated determinism audit.

## Self-Check: PASSED

- Files exist: `packages/simulation/src/network/routes.ts`, `packages/simulation/src/engine.ts`, `packages/simulation/src/continuation.ts`, `packages/optimizer/src/rolling/scope.ts`, `packages/optimizer/src/rolling/index.ts` (modified); `packages/simulation/test/network/routes.unit.test.ts`, `packages/simulation/test/multi-center-flow.unit.test.ts`, `packages/optimizer/src/rolling/scope-partition.test.ts` (created) — all present.
- Commits present: `101e679`, `b25c26c`, `7fa782b`, `14021af`, `d086041`, `765abc9` — all in git history.
- Gates re-run green: routes (13) + determinism golden `3920accc` (18) + multi-center flow incl. continuation-equivalence (7) + scope (7) + scope-partition (6) = 51 acceptance tests pass; full sim + optimizer unit suites 525 pass; `pnpm typecheck` exit 0; eslint clean on every changed file; engine `Date.now`/`Math.random` count unchanged at 5 (all comments); no new RNG substream constructed.

---
*Phase: 23-multi-center-topology*
*Completed: 2026-06-26*
