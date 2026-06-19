import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNER_CONFIG,
  type BlockKey,
  type LoadBlock,
  type RouteStop,
  type TrailerSlice,
} from "@mm/domain";
import type { LoadPlan } from "../src/types.js";
import { isFeasible, validatePlan } from "../src/validator.js";

/**
 * THE KEYSTONE — the single most important test in the codebase (T-02-11, P1).
 *
 * A hand-built ≥4-hub route with a DELIBERATELY REVERSED plan (earliest-unload
 * freight buried at the NOSE, latest-unload freight at the REAR door) MUST be
 * flagged HARD-infeasible by the INDEPENDENT validator. The matching correctly-
 * ordered plan for the SAME route MUST be feasible. Together these prove the
 * validator is NOT a tautology that passes everything (if the blocker predicate
 * were sign-flipped, the reversed plan would pass and the correct plan would fail
 * — both assertions catch that exact bug).
 *
 * The plans are hand-built (NOT produced by `planLoad`) so this fixture exercises
 * the validator alone, independent of the planner.
 */

const config = DEFAULT_PLANNER_CONFIG; // maxAllowedBlockers = 2

/** A 4-hub linear route: H1 unloaded first (stop 0) … H4 last (stop 3). */
const route: RouteStop[] = [
  { hubId: "H1", stopIndex: 0 },
  { hubId: "H2", stopIndex: 1 },
  { hubId: "H3", stopIndex: 2 },
  { hubId: "H4", stopIndex: 3 },
];

function keyFor(nextUnloadHubId: string): BlockKey {
  return {
    currentHubId: "H0",
    nextUnloadHubId,
    finalDestHubId: "HZ",
    slaClass: "standard",
    deadlineBucket: 0,
    handlingClass: "standard",
    sizeWeightClass: "small",
  };
}

function block(loadBlockId: string, nextUnloadHubId: string): LoadBlock {
  return {
    loadBlockId,
    key: keyFor(nextUnloadHubId),
    packageIds: [`${loadBlockId}-p0`],
    packageCount: 1,
    totalVolume: 1,
    totalWeight: 1,
    priority: 0,
  };
}

function slice(depth: number, loadBlockIds: string[]): TrailerSlice {
  return {
    depth,
    capacityVolume: 100,
    capacityWeight: 1000,
    usedVolume: loadBlockIds.length,
    usedWeight: loadBlockIds.length,
    loadBlockIds,
  };
}

/** One block per hub on the route. */
const blocks: LoadBlock[] = [
  block("LB1", "H1"), // unloads first  ⇒ belongs at the REAR (depth 0)
  block("LB2", "H2"),
  block("LB3", "H3"),
  block("LB4", "H4"), // unloads last   ⇒ belongs at the NOSE (depth 3)
];

describe("GOLDEN keystone — deliberately-reversed plan is HARD-infeasible", () => {
  it("flags the REVERSED plan HARD-infeasible (earliest unload buried at the nose)", () => {
    // REVERSED: H1 (earliest) at the NOSE (depth 3), H4 (latest) at the REAR
    // (depth 0). Every earlier-unload block has later-unload blocks in front of
    // it — the exact inverse of LIFO-correct.
    const reversed: LoadPlan = {
      trailerId: "TR-GOLD",
      slices: [
        slice(0, ["LB4"]), // rear door: latest unload (WRONG)
        slice(1, ["LB3"]),
        slice(2, ["LB2"]),
        slice(3, ["LB1"]), // nose: earliest unload buried (WRONG)
      ],
      placements: [], // validator must not need these
    };

    const result = validatePlan(reversed, blocks, route, config);

    expect(result.hardViolations.length).toBeGreaterThan(0);
    expect(isFeasible(result)).toBe(false);

    // LB1 (earliest) is buried behind 3 later-unload blocks ⇒ 3 > max(2) ⇒ HARD.
    const lb1 = result.hardViolations.find((v) => v.loadBlockId === "LB1");
    expect(lb1).toBeDefined();
    expect(lb1?.severity).toBe("HARD");
    expect(lb1?.blockerCount).toBe(3);
  });

  it("flags the CORRECT plan FEASIBLE for the SAME route (not a tautology)", () => {
    // CORRECT: earliest unload (H1) at the REAR (depth 0), latest (H4) at NOSE.
    const correct: LoadPlan = {
      trailerId: "TR-GOLD",
      slices: [
        slice(0, ["LB1"]), // rear: earliest unload (RIGHT)
        slice(1, ["LB2"]),
        slice(2, ["LB3"]),
        slice(3, ["LB4"]), // nose: latest unload (RIGHT)
      ],
      placements: [],
    };

    const result = validatePlan(correct, blocks, route, config);

    expect(result.hardViolations).toHaveLength(0);
    expect(result.softViolations).toHaveLength(0);
    expect(isFeasible(result)).toBe(true);
  });

  it("the two verdicts DIFFER — proving the validator discriminates correct from reversed", () => {
    const reversed: LoadPlan = {
      trailerId: "TR-GOLD",
      slices: [
        slice(0, ["LB4"]),
        slice(1, ["LB3"]),
        slice(2, ["LB2"]),
        slice(3, ["LB1"]),
      ],
      placements: [],
    };
    const correct: LoadPlan = {
      trailerId: "TR-GOLD",
      slices: [
        slice(0, ["LB1"]),
        slice(1, ["LB2"]),
        slice(2, ["LB3"]),
        slice(3, ["LB4"]),
      ],
      placements: [],
    };
    expect(isFeasible(validatePlan(reversed, blocks, route, config))).toBe(false);
    expect(isFeasible(validatePlan(correct, blocks, route, config))).toBe(true);
  });
});
