import { isFeasible } from "@mm/load-planner";

import { objective } from "./objective.js";
import type { Candidate, ObjectiveWeights } from "./types.js";

/**
 * `@mm/optimizer` — `selectPlan`: the feasibility-gated, objective-ranked plan
 * picker (OPT-08).
 *
 * THE KEYSTONE (anti-P2 / threat T-04-10): feasibility is checked FIRST and is
 * structurally separate from the objective. The pipeline is, in order:
 *
 *   1. FILTER to candidates that pass the REUSED Phase-2 hard gate
 *      (`isFeasible(c.feasibility)`) — an infeasible candidate is dropped here,
 *      BEFORE any objective is read, regardless of how low its score is. A cheap
 *      but un-unloadable plan can never win.
 *   2. Among the survivors pick the MINIMUM {@link objective}.
 *   3. Break ties by `planId` lexicographically — deterministic, so the same
 *      inputs always select the same winner and the rolling optimizer never
 *      thrashes (anti-P7).
 *
 * The objective number and the feasibility verdict are NEVER collapsed into a
 * single value: `isFeasible` consumes the separate `FeasibilityResult`, and
 * `objective` consumes only the metrics. Returns `null` when no candidate is
 * feasible.
 *
 * Pure + deterministic: no clock, no RNG; does not mutate the input array.
 */
export function selectPlan(
  candidates: readonly Candidate[],
  weights: ObjectiveWeights,
): Candidate | null {
  // 1. HARD GATE FIRST — feasibility is a separate output, never the objective.
  const feasible = candidates.filter((c) => isFeasible(c.feasibility));
  if (feasible.length === 0) return null;

  // 2 + 3. Minimum objective, deterministic planId tie-break (anti-P7). Reduce
  // (not sort) so a single comparator drives both the min and the tie rule.
  let best = feasible[0]!;
  let bestCost = objective(best.metrics, weights);
  for (let i = 1; i < feasible.length; i += 1) {
    const c = feasible[i]!;
    const cost = objective(c.metrics, weights);
    if (cost < bestCost || (cost === bestCost && c.planId < best.planId)) {
      best = c;
      bestCost = cost;
    }
  }
  return best;
}
