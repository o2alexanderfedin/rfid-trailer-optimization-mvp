import {
  DEFAULT_PLANNER_CONFIG,
  type LoadBlock,
  type RouteStop,
} from "@mm/domain";
import { isFeasible, validatePlan } from "@mm/load-planner";
import { describe, expect, it } from "vitest";

import { objective } from "../objective/objective.js";
import { DEFAULT_OBJECTIVE_WEIGHTS } from "../objective/weights.js";
import { localRepair } from "./local-repair.js";
import type { RepairKind, RepairScope } from "./local-repair.js";

/**
 * `localRepair` tests (OPT-07, Task 2): an infeasible/high-cost plan yields ≥ 1
 * FEASIBLE recovery recommendation among split / reassign / hold / over-carry,
 * each with a non-empty human-readable rationale (§17.4). The first returned
 * recommendation is the best feasible by the §12 objective (ranked). Same input
 * ⇒ same ranked output (deterministic; no clock / RNG).
 *
 * Feasibility is the REUSED Phase-2 `validatePlan` HARD gate — repair never
 * re-implements LIFO/blocker logic.
 */

/** A block destined for `nextUnloadHubId`, sized `volume`. */
function block(loadBlockId: string, nextUnloadHubId: string, volume = 10): LoadBlock {
  return {
    loadBlockId,
    key: {
      currentHubId: "origin",
      nextUnloadHubId,
      finalDestHubId: nextUnloadHubId,
      slaClass: "standard",
      deadlineBucket: 0,
      handlingClass: "standard",
      sizeWeightClass: "medium",
    },
    packageIds: [loadBlockId + "-pkg"],
    packageCount: 1,
    totalVolume: volume,
    totalWeight: volume,
    priority: 0,
  };
}

/**
 * An INFEASIBLE load: hub "A" unloads first (stop 0) but block A sits in front of
 * block B (which unloads later, stop 1) at the SAME rear depth while B is deeper —
 * we force a LIFO violation by stacking a late-unload block at the rear (depth 0)
 * in front of an early-unload block placed deeper. With maxAllowedBlockers = 0
 * (override), ANY blocker is HARD ⇒ the base plan is infeasible.
 */
const route: readonly RouteStop[] = [
  { hubId: "A", stopIndex: 0 }, // unloaded first ⇒ belongs at the rear (low depth)
  { hubId: "B", stopIndex: 1 }, // unloaded later ⇒ belongs deeper
];

// Block bA unloads at A (early), bB unloads at B (late).
const bA = block("bA", "A", 10);
const bB = block("bB", "B", 10);
const blocks: readonly LoadBlock[] = [bA, bB];

// Base (broken) layout: the LATE block bB is at the rear (depth 0) IN FRONT OF the
// early block bA placed deeper (depth 1). bA is blocked by bB ⇒ accessibility
// violation. With strictConfig.maxAllowedBlockers = 0 this is HARD ⇒ infeasible.
const brokenSlices = [
  { depth: 0, loadBlockIds: ["bB"] },
  { depth: 1, loadBlockIds: ["bA"] },
];

const strictConfig = { ...DEFAULT_PLANNER_CONFIG, maxAllowedBlockers: 0 };

function scope(): RepairScope {
  return {
    planId: "base",
    slices: brokenSlices,
    blocks,
    route,
    config: strictConfig,
    weights: DEFAULT_OBJECTIVE_WEIGHTS,
    // Pure metrics for the base plan's non-LIFO terms (held constant across
    // variants except the term each repair changes).
    baseMetrics: {
      miles: 100,
      driverTimeMin: 60,
      fuelUnits: 10,
      dockWaitMin: 5,
      handlingOps: 2,
      rehandleScore: 0, // sourced from scorePlan upstream; repair re-derives per variant
      slaLatenessMin: 0,
      utilization: 0.8,
      overCarryUnits: 0,
      imbalance: 0,
      churnVsPrevious: 0,
    },
  };
}

describe("localRepair — ranked feasible split/reassign/hold/over-carry with rationale (OPT-07)", () => {
  it("the base plan really is INFEASIBLE (precondition via REUSED validatePlan)", () => {
    const verdict = validatePlan(
      { slices: brokenSlices },
      blocks,
      route,
      strictConfig,
    );
    expect(isFeasible(verdict)).toBe(false);
  });

  it("yields >= 1 FEASIBLE recommendation for the infeasible plan", () => {
    const recs = localRepair(scope());
    expect(recs.length).toBeGreaterThanOrEqual(1);
    // Every returned recommendation is feasible (the gate ran on each variant).
    for (const r of recs) {
      expect(isFeasible(r.feasibility)).toBe(true);
    }
  });

  it("every recommendation carries a non-empty human-readable rationale (§17.4)", () => {
    for (const r of localRepair(scope())) {
      expect(typeof r.rationale).toBe("string");
      expect(r.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  it("offers the §17.4 repair kinds (split / reassign / hold / over-carry)", () => {
    const kinds = new Set<RepairKind>(localRepair(scope()).map((r) => r.kind));
    // At least one of the four recovery actions must be produced.
    const allowed: readonly RepairKind[] = ["split", "reassign", "hold", "overCarry"];
    for (const k of kinds) expect(allowed).toContain(k);
    expect(kinds.size).toBeGreaterThanOrEqual(1);
  });

  it("returns recommendations ranked best-feasible-first by the §12 objective", () => {
    const recs = localRepair(scope());
    const costs = recs.map((r) => objective(r.resultingMetrics, DEFAULT_OBJECTIVE_WEIGHTS));
    const sorted = [...costs].sort((a, b) => a - b);
    expect(costs).toEqual(sorted); // non-decreasing ⇒ first is the cheapest feasible
  });

  it("the FIRST recommendation is the best feasible by objective", () => {
    const recs = localRepair(scope());
    const first = objective(recs[0]!.resultingMetrics, DEFAULT_OBJECTIVE_WEIGHTS);
    for (const r of recs) {
      expect(first).toBeLessThanOrEqual(
        objective(r.resultingMetrics, DEFAULT_OBJECTIVE_WEIGHTS),
      );
    }
  });

  it("is deterministic: same input ⇒ identical ranked recommendations", () => {
    const a = localRepair(scope());
    const b = localRepair(scope());
    expect(a).toEqual(b);
  });
});
