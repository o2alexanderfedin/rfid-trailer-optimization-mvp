import {
  DEFAULT_PLANNER_CONFIG,
  type BlockKey,
  type HandlingClass,
  type LoadBlock,
  type PlannerConfig,
  type RouteStop,
  type SlaClass,
  type TrailerSlice,
} from "@mm/domain";
import { describe, expect, it } from "vitest";
import { rehandleScore, scorePlan, utilizationScore } from "./scoring.js";
import type { LoadPlan, ScoreResult } from "./types.js";

/**
 * Task 1 — rehandle + utilization scoring (LOAD-06, LOAD-07).
 *
 * Scoring is the SOFT layer that runs only after the hard feasibility gate. It is
 * returned as a {@link ScoreResult} (`{ rehandleScore, utilizationScore }`) that
 * is structurally SEPARATE from `FeasibilityResult` — a low score can never buy
 * out the hard gate (P2). The rehandle blocker counts come from the ONE canonical
 * blocker predicate (anti-P1: no second predicate).
 */

const config: PlannerConfig = DEFAULT_PLANNER_CONFIG;
// Locked defaults used by the hand-computed fixtures below:
//   maxBlockVolume 30, unloadReloadMin 5, volCost 1, fragilePenalty 10,
//   dockDelayPenalty 5, slaImpactPenalty 20, utilLow 0.75, utilHigh 0.90,
//   wLow 100, wHigh 100.

function keyFor(
  nextUnloadHubId: string,
  handlingClass: HandlingClass = "standard",
  slaClass: SlaClass = "standard",
): BlockKey {
  return {
    currentHubId: "H0",
    nextUnloadHubId,
    finalDestHubId: "HZ",
    slaClass,
    deadlineBucket: 0,
    handlingClass,
    sizeWeightClass: "small",
  };
}

function block(
  loadBlockId: string,
  nextUnloadHubId: string,
  totalVolume = 1,
  handlingClass: HandlingClass = "standard",
  slaClass: SlaClass = "standard",
): LoadBlock {
  return {
    loadBlockId,
    key: keyFor(nextUnloadHubId, handlingClass, slaClass),
    packageIds: [`${loadBlockId}-p0`],
    packageCount: 1,
    totalVolume,
    totalWeight: 1,
    priority: 0,
  };
}

function slice(
  depth: number,
  loadBlockIds: string[],
  usedVolume: number,
  capacityVolume = 100,
): TrailerSlice {
  return {
    depth,
    capacityVolume,
    capacityWeight: 1000,
    usedVolume,
    usedWeight: loadBlockIds.length,
    loadBlockIds,
  };
}

/** A linear k-hub route: hub Hk unloaded at stop k-1. */
function linearRoute(hubCount: number): RouteStop[] {
  const stops: RouteStop[] = [];
  for (let i = 0; i < hubCount; i += 1) {
    stops.push({ hubId: `H${i + 1}`, stopIndex: i });
  }
  return stops;
}

describe("utilizationScore — soft 75-90% band, quadratic BOTH sides (LOAD-07)", () => {
  // u = usedVolume / capacityVolume; we drive u precisely with a single slice.
  function planAtUtilization(u: number): LoadPlan {
    const capacityVolume = 100;
    const usedVolume = u * capacityVolume;
    return {
      trailerId: "TR",
      slices: [slice(0, ["LB1"], usedVolume, capacityVolume)],
      placements: [],
    };
  }

  // wLow = wHigh = 100. Hand-computed expected penalties:
  //  u=0.60 -> below: (0.75-0.60)^2*100 = 0.0225*100 = 2.25
  //  u=0.75 -> band edge -> 0
  //  u=0.80 -> in band -> 0
  //  u=0.90 -> band edge -> 0
  //  u=0.98 -> above: (0.98-0.90)^2*100 = 0.0064*100 = 0.64
  it.each([
    { u: 0.6, expected: 2.25 },
    { u: 0.75, expected: 0 },
    { u: 0.8, expected: 0 },
    { u: 0.9, expected: 0 },
    { u: 0.98, expected: 0.64 },
  ])("u=$u → penalty $expected", ({ u, expected }) => {
    expect(utilizationScore(planAtUtilization(u), config)).toBeCloseTo(expected, 10);
  });

  it("is zero across the whole [0.75, 0.90] band and positive strictly outside", () => {
    for (const u of [0.75, 0.78, 0.85, 0.9]) {
      expect(utilizationScore(planAtUtilization(u), config)).toBe(0);
    }
    expect(utilizationScore(planAtUtilization(0.74), config)).toBeGreaterThan(0);
    expect(utilizationScore(planAtUtilization(0.91), config)).toBeGreaterThan(0);
  });

  it("penalty is symmetric for equal distance outside the band (same weights)", () => {
    // 0.10 below low edge vs 0.10 above high edge, wLow=wHigh ⇒ equal penalty.
    const below = utilizationScore(planAtUtilization(0.65), config); // (0.10)^2*100 = 1
    const above = utilizationScore(planAtUtilization(1.0), config); // (0.10)^2*100 = 1
    expect(below).toBeCloseTo(1, 10);
    expect(above).toBeCloseTo(1, 10);
    expect(below).toBeCloseTo(above, 10);
  });
});

describe("rehandleScore — Σ blocks, canonical blocker recompute (LOAD-06)", () => {
  it("is zero for a correctly-ordered plan (no blockers)", () => {
    const route = linearRoute(3);
    const blocks = [block("LB1", "H1"), block("LB2", "H2"), block("LB3", "H3")];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [
        slice(0, ["LB1"], 1),
        slice(1, ["LB2"], 1),
        slice(2, ["LB3"], 1),
      ],
      placements: [],
    };
    expect(rehandleScore(plan, blocks, route, config)).toBe(0);
  });

  it("matches a hand-computed cost for ONE blocked, fragile target", () => {
    const route = linearRoute(2);
    // Reversed: H2 (later) at the rear (depth 0) buries H1 (earlier) at depth 1.
    // LB-T (H1) is blocked by LB-X (H2). blockerCount=1, blockersVolume=4 (LB-X vol).
    // LB-T is fragile.
    const blocks = [
      block("LB-T", "H1", 2, "fragile"),
      block("LB-X", "H2", 4, "standard"),
    ];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-X"], 4), slice(1, ["LB-T"], 2)],
      placements: [],
    };
    // Expected (only the blocked target LB-T contributes):
    //   blockerCount(1)*unloadReloadMin(5) = 5
    //   blockersVolume(4)*volCost(1)       = 4
    //   fragilePenalty (LB-T fragile)      = 10
    //   dockDelayPenalty                   = 5
    //   slaImpactPenalty                   = 20
    //   total                              = 44
    expect(rehandleScore(plan, blocks, route, config)).toBe(44);
  });

  it("a NON-fragile blocked target omits the fragile penalty", () => {
    const route = linearRoute(2);
    const blocks = [
      block("LB-T", "H1", 2, "standard"),
      block("LB-X", "H2", 4, "standard"),
    ];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-X"], 4), slice(1, ["LB-T"], 2)],
      placements: [],
    };
    // 1*5 + 4*1 + 0(fragile) + 5 + 20 = 34
    expect(rehandleScore(plan, blocks, route, config)).toBe(34);
  });

  it("sums blockersVolume across MULTIPLE blockers in front of the target", () => {
    const route = linearRoute(4);
    // LB-T (H1) buried at depth 1 behind LB-X (H3, vol 3) and LB-Y (H4, vol 7)
    // both at depth 0 ⇒ 2 blockers, blockersVolume = 10.
    const blocks = [
      block("LB-T", "H1", 1, "standard"),
      block("LB-X", "H3", 3, "standard"),
      block("LB-Y", "H4", 7, "standard"),
    ];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-X", "LB-Y"], 10), slice(1, ["LB-T"], 1)],
      placements: [],
    };
    // 2*5 + 10*1 + 0 + 5 + 20 = 45
    expect(rehandleScore(plan, blocks, route, config)).toBe(45);
  });
});

describe("scorePlan — returns ScoreResult ONLY (P2 separation)", () => {
  const route = linearRoute(2);
  const blocks = [block("LB1", "H1", 80)];
  const plan: LoadPlan = {
    trailerId: "TR",
    slices: [slice(0, ["LB1"], 80, 100)],
    placements: [],
  };

  it("returns exactly { rehandleScore, utilizationScore }", () => {
    const result: ScoreResult = scorePlan(plan, blocks, route, config);
    expect(Object.keys(result).sort()).toEqual([
      "rehandleScore",
      "utilizationScore",
    ]);
  });

  it("carries NO feasibility fields (hardViolations/softViolations)", () => {
    const result = scorePlan(plan, blocks, route, config);
    expect("hardViolations" in result).toBe(false);
    expect("softViolations" in result).toBe(false);
  });

  it("composes the two scorers (u=0.80 ⇒ 0 util penalty, no blockers ⇒ 0 rehandle)", () => {
    const result = scorePlan(plan, blocks, route, config);
    expect(result.rehandleScore).toBe(0);
    expect(result.utilizationScore).toBe(0); // u = 80/100 = 0.80, in band
  });
});
