# Phase 2: Load Planning - Context

**Gathered:** 2026-06-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver explainable, route-aware LIFO/partial-LIFO trailer load planning as **pure, IO-free modules**
on top of the Phase-1 operational twin: group packages into load blocks, model the trailer rear-to-nose,
greedily place blocks so earlier-unload freight is more accessible, gate feasibility with an **independent
validator**, score rehandle + utilization, emit human-readable loading instructions with a per-placement
rationale, and run a **naive baseline planner** on the same inputs through shared KPI plumbing.

**In scope (requirements):** AGG-01..04 (load-block aggregation), LOAD-01..10 (trailer model, route
unload-order map, LIFO/partial-LIFO planner, independent validator, rehandle + utilization scoring,
loading instructions, baseline planner, explainability).

**Out of scope (later phases):** RFID/sensor validation & detection (Phase 3); min-cost flow / VRP /
rolling re-optimization / plan-lifecycle events (Phase 4); animation / scenario knobs / before-after
dashboard wiring (Phase 5). Plan persistence as `PlanGenerated` events is deferred to Phase 4.

This is the load-bearing correctness phase. The two cardinal risks are defended explicitly:
- **P1 (inverted LIFO depth↔unload-order):** ONE canonical invariant asserted everywhere + an independent
  validator that recomputes blockers from placed slices + a golden "deliberately-reversed plan" fixture
  (the single most important test) + a property test fuzzing planner output against the validator.
- **P2 (feasibility folded into score):** feasibility (hard gate) and rehandle cost (soft score) are two
  separate validator outputs, never collapsed until the gate passes.
</domain>

<decisions>
## Implementation Decisions

### Load-Block Aggregation (AGG)
- Block key (AGG-01): `(currentHub, nextUnloadHub, finalDestHub, slaClass, deadlineBucket, handlingClass, sizeWeightClass)`.
- Aggregates (AGG-02): each block computes total volume, total weight, package count.
- Split rule (AGG-03): split a block into feasible sub-blocks when aggregate volume exceeds a configurable `maxBlockVolume` (~one trailer-zone capacity) OR on handling incompatibility (e.g., fragile must not be mixed with heavy). Deterministic, stable splitting.
- Priority (AGG-04): lexicographic — SLA-class weight first, then earliest deadline (higher SLA + sooner deadline ⇒ higher priority).
- `deadlineBucket`: coarse time bucket derived from the SLA class window + deadline (deterministic; no wall-clock — derived from event/payload timestamps).

### Trailer Model & LIFO Invariant (LOAD-01..04)
- Trailer model (LOAD-01): an ordered sequence of slices, **depth 0 = rear (easiest access) → N = nose**; each slice tracks usedVolume, usedWeight, and the load blocks placed in it. Nose/middle/rear **zone labels** are derived from depth ranges for instructions.
- Route unload-order map (LOAD-02): from the route's hub stop order, earlier-unload hubs map to **lower depth** (closer to the rear door).
- **Canonical invariant (anti-P1), asserted in ONE shared module and reused everywhere:**
  `unloadOrder(A) < unloadOrder(B)  ⟹  depth(A) ≤ depth(B)` (earlier unload ⇒ closer to rear).
- Greedy placement (LOAD-03): sort blocks by unload-order **descending** (latest-unload first) and place from the nose toward the rear.
- **Independent validator (LOAD-04):** a SEPARATE code path that recomputes blockers directly from the placed slices — `blockers(target) = blocks at smaller depth (closer to rear) whose unloadOrder is LATER than target`. More than `maxAllowedBlockers` (default 2) ⇒ HARD violation; 1..max ⇒ SOFT violation. **Feasibility is a hard gate, never folded into the optimization score.** The validator must NOT import or trust the planner's placement bookkeeping — it re-derives from slice contents.
- Partial-LIFO (LOAD-05): bounded blockers (≤ maxAllowedBlockers) are accepted with an assigned rehandle cost instead of rejecting the plan; exceeding the bound is infeasible (HARD).

### Scoring, Baseline & Explainability (LOAD-06..10)
- Rehandle cost (LOAD-06): `blockersCount·unloadReloadMin + blockersVolume·volCost + fragilePenalty + dockDelayPenalty + slaImpactPenalty`, with weights in a config object carrying spec-derived defaults (spec §7.5/§12.3). Computed per block and aggregated per plan.
- Utilization (LOAD-07): soft band 75–90%; quadratic penalty on BOTH under- and over-utilization (spec §12.1): `lowUtilPenalty = max(0, 0.75−u)²·wLow`, `highUtilPenalty = max(0, u−0.90)²·wHigh`.
- Loading instructions (LOAD-08): human-readable load order by nose/middle/rear zone per trailer (the dock-worker card).
- Baseline planner (LOAD-09): a naive arrival/FIFO-order planner (ignores LIFO) that runs on the SAME inputs and flows through the SAME scoring/KPI plumbing as the optimizer — so the before/after "money slide" in Phase 5 is wiring, not a rebuild.
- Explainability (LOAD-10): every placement carries a generated plain-English rationale built from scoring internals (e.g., "LB-H8 placed rear: unloads first; avoids 18-min rehandle"); plan-level explanation aggregates these.

### Module Structure & Integration
- New **pure, IO-free** packages: `@mm/aggregation` (packages -> load blocks) and `@mm/load-planner` (blocks + route -> {plan, slices, instructions, validation, scores, rationale}). Both deterministic, no DB/clock/RNG — fully unit/property testable.
- Consume `@mm/domain` types (Package, LoadBlock, TrailerSlice, Route — the Phase-1 LoadBlock/TrailerSlice stubs get fleshed out here, keeping the build-gated event union intact). Read inputs as plain data; the modules do NOT read the event store directly.
- Thin API exposure: ONE read endpoint in `@mm/api` (e.g., `POST /plan` or `GET /trailers/:id/plan`) that assembles inputs from the current twin (or a request body), runs aggregation + planner + baseline, and returns plan + instructions + validation + scores — demoable, but the correctness lives in the pure modules.
- No plan persistence / `PlanGenerated` events in Phase 2 (deferred to Phase 4).

### Testing (the canonical fixtures)
- The single most important test: a golden fixture asserting a **deliberately-reversed** load plan is flagged HARD-infeasible by the independent validator.
- A property test fuzzing random block/route inputs: planner output must satisfy the canonical invariant AND the independent validator must agree with the planner on feasibility.
- Unit tests pinning the exact blocker predicate with same-hub and multi-block-slice fixtures.
- Baseline-vs-optimizer test: on a blocking-prone scenario, the optimizer's rehandle score ≤ baseline's (it must have something to beat, and beat it).
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@mm/domain` — entities (Package, Hub, Trailer, Route/Trip, LoadBlock/TrailerSlice stubs) + closed event union; extend the LoadBlock/TrailerSlice stubs here.
- `@mm/projections` / `@mm/event-store` — the operational twin (package locations, hub inventory) provides the package inputs the API endpoint aggregates; the pure modules take plain inputs.
- `@mm/simulation` — generates packages/trailers/routes that the planner can run against for demo/tests.
- Established conventions (Phase 1): pnpm+Turborepo, strict TS (no `any`, noUncheckedIndexedAccess), Vitest unit + Testcontainers integration, ESLint flat, downward-only deps, determinism discipline.

### Established Patterns
- Pure-reducer / pure-function modules with golden + property tests (mirrors `@mm/projections`).
- Git-flow: work on `feature/phase-2-load-planning`; pre-commit blocks main/develop (merges allowed).

### Integration Points
- `@mm/aggregation` + `@mm/load-planner` sit above `@mm/domain`; `@mm/api` wires them to the twin for the demo endpoint. Phase 4 (optimizer) and Phase 5 (dashboard) consume the planner + its KPI outputs.
</code_context>

<specifics>
## Specific Ideas
- Keep `aggregation` and `load-planner` 100% pure/IO-free (TDD-friendly, the roadmap's explicit ask).
- The canonical LIFO invariant lives in ONE place and is imported by planner, validator, and tests — never re-stated divergently (this is the P1 defense).
- Feasibility result shape: `{ hardViolations: Violation[], softViolations: Violation[] }` kept SEPARATE from `{ rehandleScore, utilizationScore }` — never merged before the hard gate passes (P2 defense).
</specifics>

<deferred>
## Deferred Ideas
- RFID/sensor-driven plan-vs-observed validation → Phase 3.
- Min-cost flow, VRP, rolling re-optimization, local repair, plan-lifecycle events → Phase 4.
- Before/after KPI dashboard + scenario knobs + animation → Phase 5.
</deferred>
