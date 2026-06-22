# Phase 2 Research: Load Planning

**Researched:** 2026-06-19
**Phase:** 2 — Load Planning
**Requirements:** AGG-01..04, LOAD-01..10
**Sources:** tech spec §6/§7/§11.5/§12, project research (FEATURES/PITFALLS), Phase-1 code (@mm/domain, @mm/event-store, @mm/projections), and a **Google AI Mode browser consult** (mandatory) on route-aware LIFO/partial-LIFO trailer load planning.

---

## Google AI Mode Consult (2026-06-19)

Query: route-aware LIFO trailer load planning — multi-stop unload order, partial-LIFO blockers, rehandle cost, greedy placement. The answer **converged on our locked design** and supplied framing:

- **Physical ↔ reverse-route mapping:** Stop 1 (earliest unload) at the tail/door; Stop N at the nose. Cargo for Stop i must be accessible before Stop i+1. → our `depth 0 = rear`, `unloadOrder(A)<unloadOrder(B) ⟹ depth(A) ≤ depth(B)`.
- **Blocker definition:** a partial-LIFO blocker = an item for a LATER stop physically in front of (closer to door than) an item for an EARLIER stop. → our blocker predicate.
- **Greedy placement:** sort items by stop sequence DESCENDING (N→1), pack the nose first; score slots by volume utilization + stop-sequence alignment. → our greedy.
- **Independent validator = "Virtual Unload Simulation":** at each stop, simulate the unload and COUNT how many blocking items must be temporarily moved — recomputed from the placed layout, not from planner bookkeeping. **This is exactly the anti-P1 independent validator.** Adopt this framing: the validator walks the route stop-by-stop over the placed slices and counts blockers per stop.
- **Threshold gating:** strict max rehandles per stop (e.g., 2) → our `maxAllowedBlockers` default 2; exceeding ⇒ HARD infeasible.
- **Stability filtering:** heavy items on the floor even at a minor LIFO cost → informs our handling-class / fragile-vs-heavy split (AGG-03) and a stability note in scoring.
- **Optional refinement (NOT MVP):** a look-ahead window (evaluate next ~3 blocks instead of 1) to avoid greedy lock-in. Note as a future enhancement; Phase-2 MVP keeps simple greedy + local feasibility.

---

## Implementation Guidance

### `@mm/aggregation` (pure)
- `aggregate(packages, config) -> LoadBlock[]`: group by key `(currentHub, nextUnloadHub, finalDestHub, slaClass, deadlineBucket, handlingClass, sizeWeightClass)`; sum volume/weight/count (AGG-02); deterministic stable iteration order.
- `splitBlock(block, config)`: split when `volume > maxBlockVolume` or on handling incompatibility (fragile⊄heavy) into stable sub-blocks (AGG-03).
- `priority(block)`: lexicographic `(slaClassWeight desc, deadline asc)` (AGG-04).
- `deadlineBucket(deadline, slaClass)`: deterministic coarse bucket from payload timestamps (NO wall-clock).

### `@mm/load-planner` (pure)
- Canonical invariant module (the P1 defense), imported by planner + validator + tests:
  `lifoOk(plan) ⟺ ∀ A,B: unloadOrder(A) < unloadOrder(B) ⟹ depth(A) ≤ depth(B)`.
- `buildUnloadOrderMap(route) -> Map<hubId, orderIndex>` (LOAD-02): earlier stop ⇒ lower depth.
- `planLoad(blocks, route, config) -> LoadPlan` (LOAD-03): sort blocks by unloadOrder DESC, greedily place nose→rear into slices honoring per-slice volume/weight capacity; produce ordered slices (depth 0=rear) with zone labels (rear/middle/nose) derived from depth.
- **`validatePlan(plan, route, config) -> { hardViolations, softViolations }`** (LOAD-04) — INDEPENDENT "virtual unload simulation": walk the route stop-by-stop, and for each target block recompute `blockers = blocks at smaller depth whose unloadOrder is LATER`; `count > maxAllowedBlockers ⇒ HARD`, `1..max ⇒ SOFT`. MUST re-derive from slice contents; MUST NOT import planner placement bookkeeping. Feasibility (this output) is kept SEPARATE from the score (P2 defense) and is the hard gate.
- Partial-LIFO (LOAD-05): bounded blockers accepted with a rehandle cost; over-bound ⇒ HARD.
- `rehandleScore(plan, config)` (LOAD-06): `Σ blocks (blockersCount·unloadReloadMin + blockersVolume·volCost + fragilePenalty + dockDelayPenalty + slaImpactPenalty)`.
- `utilizationScore(plan, config)` (LOAD-07): `lowUtilPenalty = max(0,0.75−u)²·wLow`, `highUtilPenalty = max(0,u−0.90)²·wHigh` (spec §12.1).
- `instructions(plan)` (LOAD-08): human-readable load order by nose/middle/rear zone.
- `baselinePlan(blocks, route, config)` (LOAD-09): naive arrival/FIFO order, no LIFO awareness, scored through the SAME `rehandleScore`/`utilizationScore`/KPI plumbing.
- Explainability (LOAD-10): every placement carries a rationale string from scoring internals; plan-level explanation aggregates.

### Config shape (defaults from spec §7.5/§12)
`{ maxAllowedBlockers: 2, maxBlockVolume, unloadReloadMin, volCost, fragilePenalty, dockDelayPenalty, slaImpactPenalty, targetUtil: 0.80, utilLow: 0.75, utilHigh: 0.90, wLow, wHigh }`.

### API exposure (`@mm/api`, thin)
- One endpoint (e.g. `POST /plan`) assembling inputs from the twin (or request body): runs aggregate → planLoad + baselinePlan → validatePlan → scores → instructions; returns `{ plan, baseline, instructions, validation:{hard,soft}, scores:{rehandle,utilization}, explanation }`. Read-only; no `PlanGenerated` persistence (Phase 4).

---

## Validation Architecture

### The keystone (P1 defense)
- **Golden "reversed-plan" fixture (single most important test):** a hand-built load plan with the LIFO order deliberately reversed (earliest-unload freight buried at the nose) MUST be flagged HARD-infeasible by the independent validator. If this ever passes, the system is silently lying.
- **Property test:** for random (blocks, route), `planLoad` output satisfies the canonical invariant AND `validatePlan` agrees with the planner's own feasibility classification (no divergence). Fuzz seeds enumerated/deterministic.

### Blocker predicate (exactness)
- Unit tests pin the blocker count with same-hub fixtures (two blocks same unloadOrder ⇒ not blockers) and multi-block-per-slice fixtures; HARD vs SOFT boundary at `maxAllowedBlockers`.

### Feasibility-vs-score separation (P2 defense)
- Test that an infeasible plan (HARD violation) is rejected by the gate regardless of a low rehandle score, and that `rehandleScore`/`utilizationScore` never short-circuit the hard gate (the two outputs are distinct objects).

### Scoring correctness
- Utilization penalty: 0 inside [0.75,0.90], increasing quadratically outside (table-driven cases). Rehandle: hand-computed expected cost for a fixture with known blockers/volume/fragile.

### Baseline (P8) + AGG
- Baseline-vs-optimizer: on a blocking-prone scenario the optimizer's rehandle score ≤ baseline's (and strictly < on at least one designed case). AGG: grouping/splitting/priority deterministic and correct on fixtures.

### Purity / determinism
- `@mm/aggregation` + `@mm/load-planner` import only `@mm/domain`; grep-guard no `Date.now()`/`Math.random()`; same input ⇒ same output.

---

## Pitfalls Carried Into Plans
- **P1 inverted LIFO mapping** → one canonical invariant + independent virtual-unload validator + golden reversed-plan fixture + property test.
- **P2 feasibility folded into score** → `{hard,soft}` violations kept separate from `{rehandle,utilization}`; hard gate first.
- **Stability vs LIFO** (consult) → handling-class split keeps heavy on floor; a minor stability-driven LIFO exception is a SOFT (scored) cost, never a silent HARD bypass.
- **Greedy lock-in** (consult) → acceptable for MVP; look-ahead window noted as a future enhancement (not Phase 2).

---
*Phase 2 research — incorporates mandatory Google AI Mode consult on route-aware LIFO load planning.*
