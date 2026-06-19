/**
 * `@mm/load-planner` — the PURE, IO-free load-planning foundation (LOAD-01/02).
 *
 * It imports ONLY `@mm/domain` (+ Node stdlib): no DB, no clock (`Date.now()`),
 * no RNG (`Math.random()`). Every export is deterministic — same input ⇒ same
 * output — so the planning pipeline replays identically (PITFALLS P3).
 *
 * This plan lays the interface-first foundation every later load-planner plan
 * (04 planner+validator, 05 scoring+baseline) builds against:
 *
 *  - **The canonical LIFO invariant + blocker predicate** (`lifo-invariant.ts`):
 *    the ONE place stating `unloadOrder(A) < unloadOrder(B) ⟹ depth(A) ≤
 *    depth(B)` and `isBlocker`. The planner, the independent validator, and all
 *    tests import these and NEVER re-state them (the anti-P1 single source).
 *  - **The trailer rear-to-nose slice model** (`trailer.ts`, LOAD-01): depth
 *    0 = rear, with nose/middle/rear zone labels derived from depth thirds.
 *  - **The route unload-order map** (`unload-order.ts`, LOAD-02): earlier
 *    unload ⇒ lower order ⇒ (per the invariant) lower depth.
 *  - **The shared type contracts** (`types.ts`): `FeasibilityResult` and
 *    `ScoreResult` are DISTINCT types, baking the anti-P2 feasibility-vs-score
 *    separation into the type system before any scoring exists.
 */

// --- Canonical LIFO invariant + blocker predicate (the P1 single source) -----
export {
  canonicalInvariantHolds,
  countBlockers,
  isBlocker,
  lifoOk,
} from "./lifo-invariant.js";

// --- Trailer rear-to-nose slice model + zone labels (LOAD-01) ----------------
export { emptyTrailer, zoneForDepth, type Zone } from "./trailer.js";

// --- Route unload-order map (LOAD-02) ----------------------------------------
export { buildUnloadOrderMap } from "./unload-order.js";

// --- Greedy route-aware planner (LOAD-03 / LOAD-05) --------------------------
export { planLoad } from "./plan-load.js";

// --- Independent feasibility validator (LOAD-04, anti-P1/anti-P2) ------------
export { isFeasible, placementsFromSlices, validatePlan } from "./validator.js";

// --- Soft scoring: rehandle + utilization (LOAD-06 / LOAD-07) -----------------
export {
  type BlockRehandle,
  rehandleBreakdown,
  rehandleScore,
  scorePlan,
  utilizationScore,
} from "./scoring.js";

// --- Loading instructions by zone (LOAD-08) ----------------------------------
export {
  type InstructionLine,
  type LoadingInstructions,
  instructions,
  type ZoneInstruction,
} from "./instructions.js";

// --- Explainability: per-placement + plan-level rationale (LOAD-10) -----------
export { planExplanation, placementRationale } from "./rationale.js";

// --- Naive FIFO baseline planner (LOAD-09, shared scoring plumbing / P8) ------
export { baselinePlan } from "./baseline.js";

// --- Shared type contracts (P2 feasibility-vs-score separation baked in) ------
export type {
  FeasibilityResult,
  LoadPlan,
  Placement,
  ScoreResult,
  Violation,
  ViolationKind,
  ViolationSeverity,
} from "./types.js";
