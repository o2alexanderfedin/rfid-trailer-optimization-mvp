import type { FeasibilityResult, Violation } from "@mm/load-planner";
import { describe, expect, it } from "vitest";

import { objective } from "./objective.js";
import { selectPlan } from "./select-plan.js";
import type { Candidate, PlanMetrics } from "./types.js";

/**
 * `selectPlan` tests (OPT-08, Task 1) — THE KEYSTONE (anti-P2 / threat T-04-10):
 *
 *  - A low-objective-but-INFEASIBLE candidate LOSES to a higher-objective-but-
 *    FEASIBLE one. The infeasible candidate is rejected regardless of its lower
 *    score; the feasibility gate (a SEPARATE `FeasibilityResult` on the
 *    Candidate) is checked FIRST and is never collapsed into the objective.
 *  - Among feasible candidates the minimum objective wins, ties broken by
 *    `planId` lexicographically (deterministic, anti-P7 thrash).
 *  - `null` when no candidate is feasible.
 */

const FEASIBLE: FeasibilityResult = { hardViolations: [], softViolations: [] };

function hardViolation(loadBlockId: string): Violation {
  return {
    loadBlockId,
    kind: "accessibility",
    blockerCount: 99,
    severity: "HARD",
    detail: "test-forced HARD violation",
  };
}

/** An infeasible verdict (≥ 1 HARD violation) — the hard gate must reject it. */
function infeasible(loadBlockId = "blk"): FeasibilityResult {
  return { hardViolations: [hardViolation(loadBlockId)], softViolations: [] };
}

function metrics(p: Partial<PlanMetrics> = {}): PlanMetrics {
  return {
    miles: 0,
    driverTimeMin: 0,
    fuelUnits: 0,
    dockWaitMin: 0,
    handlingOps: 0,
    rehandleScore: 0,
    slaLatenessMin: 0,
    utilization: 0.8, // inside the band ⇒ no util penalty unless overridden
    overCarryUnits: 0,
    imbalance: 0,
    churnVsPrevious: 0,
    ...p,
  };
}

/** A candidate whose objective is driven purely by `miles` (all weights 1). */
function candidate(
  planId: string,
  miles: number,
  feasibility: FeasibilityResult,
): Candidate {
  return { planId, metrics: metrics({ miles }), feasibility };
}

const W = {
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

describe("selectPlan — feasibility hard-gate keystone (anti-P2) + deterministic ranking", () => {
  it("KEYSTONE: rejects the cheap INFEASIBLE candidate, returns the dearer FEASIBLE one", () => {
    const cheapInfeasible = candidate("cheap", 1, infeasible());
    const dearFeasible = candidate("dear", 1000, FEASIBLE);

    // Sanity: the infeasible one really is cheaper by the objective.
    expect(objective(cheapInfeasible.metrics, W)).toBeLessThan(
      objective(dearFeasible.metrics, W),
    );

    const winner = selectPlan([cheapInfeasible, dearFeasible], W);
    expect(winner).not.toBeNull();
    expect(winner?.planId).toBe("dear"); // feasibility gate wins over the low score
  });

  it("picks the minimum objective among FEASIBLE candidates", () => {
    const a = candidate("a", 50, FEASIBLE);
    const b = candidate("b", 10, FEASIBLE); // cheapest feasible
    const c = candidate("c", 30, FEASIBLE);
    expect(selectPlan([a, b, c], W)?.planId).toBe("b");
  });

  it("breaks objective ties by planId lexicographically (deterministic, anti-P7)", () => {
    // Three feasible candidates, identical objective — id order must decide.
    const z = candidate("z", 7, FEASIBLE);
    const a = candidate("a", 7, FEASIBLE);
    const m = candidate("m", 7, FEASIBLE);
    // Input order shuffled; the winner must always be "a".
    expect(selectPlan([z, m, a], W)?.planId).toBe("a");
    expect(selectPlan([a, m, z], W)?.planId).toBe("a");
    expect(selectPlan([m, z, a], W)?.planId).toBe("a");
  });

  it("returns null when NO candidate is feasible", () => {
    const x = candidate("x", 1, infeasible("x"));
    const y = candidate("y", 2, infeasible("y"));
    expect(selectPlan([x, y], W)).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    expect(selectPlan([], W)).toBeNull();
  });

  it("observes feasibility and objective as TWO separate values on the Candidate (P2)", () => {
    // The winner's feasibility verdict and its objective score are independent
    // observations — the selection never folds one into the other.
    const winner = selectPlan(
      [candidate("a", 5, FEASIBLE), candidate("b", 99, infeasible("b"))],
      W,
    );
    expect(winner?.feasibility).toBe(FEASIBLE); // distinct feasibility output
    expect(objective(winner!.metrics, W)).toBe(5); // distinct objective output
  });
});
