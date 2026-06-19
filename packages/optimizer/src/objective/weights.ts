import { DEFAULT_PLANNER_CONFIG } from "@mm/domain";

import type { ObjectiveWeights } from "./types.js";

/**
 * `@mm/optimizer` — the DEFAULT §12 objective weights (OPT-08).
 *
 * The single source of plan-ranking tuning. Positive demo defaults chosen so the
 * dominant operational costs (rehandle, SLA-lateness, the utilization bands, and
 * the anti-P7 churn anchor) outweigh the linear travel terms — i.e. a plan that
 * re-handles freight or misses an SLA never out-ranks a slightly longer but clean
 * plan. Callers may override any subset (the API merges tuned knobs over these).
 *
 * Pure: a frozen value object, no clock / RNG.
 */
export const DEFAULT_OBJECTIVE_WEIGHTS: ObjectiveWeights = {
  miles: 1,
  driverTime: 1,
  fuel: 1,
  dockWait: 1,
  handling: 2,
  rehandle: 1,
  slaLateness: 5,
  // §12.1 quadratic band weights single-sourced from the planner config so the
  // optimizer and the load-planner agree on the utilization penalty scale.
  lowUtil: DEFAULT_PLANNER_CONFIG.wLow,
  highUtil: DEFAULT_PLANNER_CONFIG.wHigh,
  overCarry: 10,
  imbalance: 4,
  // Anti-P7: a non-trivial anchor to the previous plan so equivalent re-plans do
  // not oscillate (small churn must be cheaper than any real improvement it buys).
  churn: 3,
};

/**
 * The §12.1 utilization band edges, single-sourced from the planner config
 * (`utilLow` = 0.75, `utilHigh` = 0.90). The objective penalizes utilization
 * BELOW `low` and ABOVE `high`, quadratically (matching `scorePlan`'s
 * `utilizationScore`), and is exactly 0 inside the band. Re-using the planner
 * edges keeps the optimizer from restating the 0.75/0.90 magic numbers (DRY).
 */
export const UTIL_BAND = {
  low: DEFAULT_PLANNER_CONFIG.utilLow,
  high: DEFAULT_PLANNER_CONFIG.utilHigh,
} as const;
