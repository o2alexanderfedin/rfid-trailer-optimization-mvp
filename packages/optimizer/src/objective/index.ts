/**
 * `@mm/optimizer` — the weighted-objective barrel (OPT-08).
 *
 * The ONE §12 weighted-objective scorer + the feasibility-hard-gate plan picker.
 * Feasibility (the Phase-2 `validatePlan` HARD gate) stays a SEPARATE output,
 * checked first in `selectPlan` and never folded into the objective (anti-P2).
 * The root `src/index.ts` re-exports this barrel; this plan FILLS this file and
 * never touches the root.
 */

// --- The pure §12 weighted objective + its explainable breakdown (OPT-08) ----
export { objective, objectiveBreakdown } from "./objective.js";

// --- Feasibility-gated, objective-ranked plan selection (OPT-08 keystone) -----
export { selectPlan } from "./select-plan.js";

// --- Default §12 weights + the single-sourced utilization band ----------------
export { DEFAULT_OBJECTIVE_WEIGHTS, UTIL_BAND } from "./weights.js";

// --- Contracts ----------------------------------------------------------------
export type {
  Candidate,
  ObjectiveBreakdown,
  ObjectiveWeights,
  PlanMetrics,
} from "./types.js";
