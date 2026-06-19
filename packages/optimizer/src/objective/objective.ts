import type { ObjectiveBreakdown, ObjectiveWeights, PlanMetrics } from "./types.js";
import { UTIL_BAND } from "./weights.js";

/**
 * `@mm/optimizer` — the ONE weighted objective (OPT-08, spec §12).
 *
 * `objective(metrics, weights)` is a PURE weighted sum of every §12 cost term —
 * miles + driverTime + fuel + dockWait + handling + rehandle + SLA-lateness +
 * low/high-utilization + over-carry + imbalance + churn. It ranks candidate
 * plans (lower = better).
 *
 * KEYSTONE anti-P2 (threat T-04-10): the objective takes **NO feasibility
 * argument**. Its only inputs are the pure {@link PlanMetrics} numbers and the
 * {@link ObjectiveWeights}. There is structurally no seam through which a
 * `FeasibilityResult` could enter and be discounted — feasibility is a SEPARATE
 * gate that `selectPlan` checks FIRST. A low objective can never buy out a HARD
 * violation.
 *
 * The rehandle + utilization terms are sourced from the REUSED Phase-2
 * `scorePlan` (the caller passes `scorePlan.rehandleScore` as `rehandleScore`
 * and the utilization fraction as `utilization`); they are NOT recomputed here
 * (DRY / anti-P1).
 *
 * Pure + deterministic: no clock (`Date.now()`), no RNG (`Math.random()`). Same
 * inputs ⇒ same number.
 */

/**
 * The §12.1 two-sided quadratic utilization penalty. `lowUtil` weight on
 * `max(0, low − u)²` and `highUtil` weight on `max(0, u − high)²`, exactly 0
 * inside the band `[UTIL_BAND.low, UTIL_BAND.high]`. Mirrors `scorePlan`'s
 * `utilizationScore` shape so the two layers agree on the penalty curve.
 */
function utilizationPenalties(
  utilization: number,
  weights: ObjectiveWeights,
): { readonly lowUtil: number; readonly highUtil: number } {
  const below = Math.max(0, UTIL_BAND.low - utilization);
  const above = Math.max(0, utilization - UTIL_BAND.high);
  return {
    lowUtil: below * below * weights.lowUtil,
    highUtil: above * above * weights.highUtil,
  };
}

/**
 * The per-term contribution breakdown — the explainability view. Each field is
 * `metricTerm × weight`, plus the summed `total`. `objective` returns exactly
 * this `total`, so the scalar and the breakdown can never diverge.
 */
export function objectiveBreakdown(
  metrics: PlanMetrics,
  weights: ObjectiveWeights,
): ObjectiveBreakdown {
  const { lowUtil, highUtil } = utilizationPenalties(metrics.utilization, weights);

  const miles = metrics.miles * weights.miles;
  const driverTime = metrics.driverTimeMin * weights.driverTime;
  const fuel = metrics.fuelUnits * weights.fuel;
  const dockWait = metrics.dockWaitMin * weights.dockWait;
  const handling = metrics.handlingOps * weights.handling;
  const rehandle = metrics.rehandleScore * weights.rehandle;
  const slaLateness = metrics.slaLatenessMin * weights.slaLateness;
  const overCarry = metrics.overCarryUnits * weights.overCarry;
  const imbalance = metrics.imbalance * weights.imbalance;
  const churn = metrics.churnVsPrevious * weights.churn;

  const total =
    miles +
    driverTime +
    fuel +
    dockWait +
    handling +
    rehandle +
    slaLateness +
    lowUtil +
    highUtil +
    overCarry +
    imbalance +
    churn;

  return {
    miles,
    driverTime,
    fuel,
    dockWait,
    handling,
    rehandle,
    slaLateness,
    lowUtil,
    highUtil,
    overCarry,
    imbalance,
    churn,
    total,
  };
}

/**
 * The ONE weighted objective (§12): a pure weighted sum of all the
 * {@link PlanMetrics} terms (lower = better). Takes NO feasibility input
 * (anti-P2). Delegates to {@link objectiveBreakdown} so the scalar and the
 * explainable breakdown stay in lock-step.
 */
export function objective(metrics: PlanMetrics, weights: ObjectiveWeights): number {
  return objectiveBreakdown(metrics, weights).total;
}
