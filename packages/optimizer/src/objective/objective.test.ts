import { describe, expect, it } from "vitest";

import { objective, objectiveBreakdown } from "./objective.js";
import type { ObjectiveWeights, PlanMetrics } from "./types.js";
import { UTIL_BAND } from "./weights.js";

/**
 * `objective` tests (OPT-08, Task 1): the §12 weighted sum is a PURE function of
 * (metrics, weights) — every term contributes by its weight, and there is NO
 * feasibility input (anti-P2). The §12.1 utilization penalty is a two-sided
 * quadratic band, exactly 0 inside `[UTIL_BAND.low, UTIL_BAND.high]`.
 */

/** All-ones weights so the weighted sum reduces to the raw term contributions. */
const UNIT_WEIGHTS: ObjectiveWeights = {
  miles: 1,
  driverTime: 1,
  fuel: 1,
  dockWait: 1,
  handling: 1,
  rehandle: 1,
  slaLateness: 1,
  lowUtil: 1,
  highUtil: 1,
  overCarry: 1,
  imbalance: 1,
  churn: 1,
};

function metrics(p: Partial<PlanMetrics> = {}): PlanMetrics {
  return {
    miles: 0,
    driverTimeMin: 0,
    fuelUnits: 0,
    dockWaitMin: 0,
    handlingOps: 0,
    rehandleScore: 0,
    slaLatenessMin: 0,
    // Default utilization sits INSIDE the band ⇒ zero utilization penalty.
    utilization: (UTIL_BAND.low + UTIL_BAND.high) / 2,
    overCarryUnits: 0,
    imbalance: 0,
    churnVsPrevious: 0,
    ...p,
  };
}

describe("objective — §12 weighted sum (pure, no feasibility input)", () => {
  it("computes the exact hand-computed weighted sum across every term", () => {
    // Utilization 0.50 ⇒ below the 0.75 low edge ⇒ lowUtil = (0.75-0.50)^2 = 0.0625;
    // above edge term is 0 (0.50 < 0.90).
    const m = metrics({
      miles: 10,
      driverTimeMin: 20,
      fuelUnits: 3,
      dockWaitMin: 7,
      handlingOps: 4,
      rehandleScore: 12,
      slaLatenessMin: 6,
      utilization: 0.5,
      overCarryUnits: 2,
      imbalance: 5,
      churnVsPrevious: 8,
    });
    const w: ObjectiveWeights = {
      miles: 2,
      driverTime: 1,
      fuel: 3,
      dockWait: 1,
      handling: 5,
      rehandle: 2,
      slaLateness: 4,
      lowUtil: 100,
      highUtil: 50,
      overCarry: 10,
      imbalance: 3,
      churn: 7,
    };

    const below = UTIL_BAND.low - 0.5; // 0.25
    const expected =
      10 * 2 + // miles
      20 * 1 + // driverTime
      3 * 3 + // fuel
      7 * 1 + // dockWait
      4 * 5 + // handling
      12 * 2 + // rehandle
      6 * 4 + // slaLateness
      below * below * 100 + // lowUtil = 0.0625 * 100 = 6.25
      0 * 50 + // highUtil (none)
      2 * 10 + // overCarry
      5 * 3 + // imbalance
      8 * 7; // churn

    expect(objective(m, w)).toBeCloseTo(expected, 10);
  });

  it("is exactly 0 when every term is 0 and utilization is inside the band", () => {
    expect(objective(metrics(), UNIT_WEIGHTS)).toBe(0);
  });

  it("penalizes OVER-utilization quadratically above the high band edge", () => {
    const over = 0.05; // utilization = high + 0.05
    const m = metrics({ utilization: UTIL_BAND.high + over });
    expect(objective(m, { ...UNIT_WEIGHTS, highUtil: 200 })).toBeCloseTo(
      over * over * 200,
      10,
    );
  });

  it("breakdown sums to the scalar objective (explainability stays consistent)", () => {
    const m = metrics({
      miles: 11,
      driverTimeMin: 9,
      fuelUnits: 2,
      dockWaitMin: 3,
      handlingOps: 1,
      rehandleScore: 4,
      slaLatenessMin: 5,
      utilization: 0.95, // over the high edge
      overCarryUnits: 1,
      imbalance: 2,
      churnVsPrevious: 6,
    });
    const b = objectiveBreakdown(m, UNIT_WEIGHTS);
    const handSum =
      b.miles +
      b.driverTime +
      b.fuel +
      b.dockWait +
      b.handling +
      b.rehandle +
      b.slaLateness +
      b.lowUtil +
      b.highUtil +
      b.overCarry +
      b.imbalance +
      b.churn;
    expect(b.total).toBeCloseTo(handSum, 10);
    expect(b.total).toBeCloseTo(objective(m, UNIT_WEIGHTS), 10);
  });

  it("each weight scales ONLY its own term (independent contributions)", () => {
    const base = metrics({ miles: 3, rehandleScore: 7 });
    const baseCost = objective(base, UNIT_WEIGHTS);
    // Doubling the miles weight adds exactly one extra `miles` term.
    expect(objective(base, { ...UNIT_WEIGHTS, miles: 2 })).toBeCloseTo(
      baseCost + 3,
      10,
    );
    // Doubling the rehandle weight adds exactly one extra `rehandleScore` term.
    expect(objective(base, { ...UNIT_WEIGHTS, rehandle: 2 })).toBeCloseTo(
      baseCost + 7,
      10,
    );
  });

  it("KEYSTONE (compile-enforced): objective accepts NO feasibility argument", () => {
    // The objective signature is (metrics, weights) — exactly two params. If a
    // future refactor smuggled a FeasibilityResult in, the arity check below
    // (and the type system) would catch it. This is the anti-P2 seam guard.
    expect(objective).toHaveLength(2);
  });
});
