import {
  DEFAULT_PLANNER_CONFIG,
  type BlockKey,
  type HandlingClass,
  type LoadBlock,
  type PlannerConfig,
  type RouteStop,
  type TrailerSlice,
} from "@mm/domain";
import { describe, expect, it } from "vitest";
import { planExplanation, placementRationale } from "./rationale.js";
import type { LoadPlan, Placement } from "./types.js";

/**
 * Task 2b — per-placement + plan-level explainability (LOAD-10).
 *
 * `placementRationale` turns the scoring internals into a plain-English string
 * for ONE placement (its unload position + the avoided/incurred rehandle).
 * `planExplanation` aggregates the per-placement rationales with the plan-level
 * feasibility verdict and the rehandle/utilization figures.
 */

const config: PlannerConfig = DEFAULT_PLANNER_CONFIG; // unloadReloadMin = 5

function keyFor(
  nextUnloadHubId: string,
  handlingClass: HandlingClass = "standard",
): BlockKey {
  return {
    currentHubId: "H0",
    nextUnloadHubId,
    finalDestHubId: "HZ",
    slaClass: "standard",
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
): LoadBlock {
  return {
    loadBlockId,
    key: keyFor(nextUnloadHubId, handlingClass),
    packageIds: [`${loadBlockId}-p0`],
    packageCount: 1,
    totalVolume,
    totalWeight: 1,
    priority: 0,
  };
}

function slice(depth: number, loadBlockIds: string[], usedVolume: number): TrailerSlice {
  return {
    depth,
    capacityVolume: 100,
    capacityWeight: 1000,
    usedVolume,
    usedWeight: loadBlockIds.length,
    loadBlockIds,
  };
}

function linearRoute(hubCount: number): RouteStop[] {
  const stops: RouteStop[] = [];
  for (let i = 0; i < hubCount; i += 1) {
    stops.push({ hubId: `H${i + 1}`, stopIndex: i });
  }
  return stops;
}

describe("placementRationale — plain-English per placement (LOAD-10)", () => {
  it("describes a rear, first-unload block as accessible (avoids rehandle)", () => {
    const route = linearRoute(3);
    const blocks = [block("LB-H1", "H1"), block("LB-H2", "H2"), block("LB-H3", "H3")];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-H1"], 1), slice(1, ["LB-H2"], 1), slice(2, ["LB-H3"], 1)],
      placements: [],
    };
    const rear: Placement = { loadBlockId: "LB-H1", depth: 0, unloadOrder: 0 };
    const text = placementRationale(rear, plan, blocks, route, config);
    expect(text).toContain("LB-H1");
    expect(text.toLowerCase()).toContain("rear");
    // accessible / unloads first / no rehandle phrasing
    expect(text.toLowerCase()).toMatch(/unloads first|accessible|no rehandle|avoids/);
    expect(text.length).toBeGreaterThan(0);
  });

  it("describes a blocked (partial-LIFO) block with its blocker count + minutes", () => {
    const route = linearRoute(2);
    // Reversed: H2 (later) at rear depth 0 buries H1 (earlier) at depth 1.
    // LB-T (H1) has 1 blocker; unloadReloadMin=5 ⇒ +5 min rehandle.
    const blocks = [block("LB-T", "H1", 2), block("LB-X", "H2", 3)];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-X"], 3), slice(1, ["LB-T"], 2)],
      placements: [],
    };
    const target: Placement = { loadBlockId: "LB-T", depth: 1, unloadOrder: 0 };
    const text = placementRationale(target, plan, blocks, route, config);
    expect(text).toContain("LB-T");
    expect(text).toMatch(/1 blocker/);
    expect(text).toContain("5"); // minutes (1 blocker * 5 min)
    expect(text.toLowerCase()).toMatch(/min|rehandle/);
  });

  it("returns a NON-EMPTY rationale for every placement of a plan", () => {
    const route = linearRoute(2);
    const blocks = [block("LB-X", "H2", 3), block("LB-T", "H1", 2)];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-X"], 3), slice(1, ["LB-T"], 2)],
      placements: [
        { loadBlockId: "LB-X", depth: 0, unloadOrder: 1 },
        { loadBlockId: "LB-T", depth: 1, unloadOrder: 0 },
      ],
    };
    for (const p of plan.placements) {
      const text = placementRationale(p, plan, blocks, route, config);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(p.loadBlockId);
    }
  });
});

describe("planExplanation — aggregates rationale + scores + verdict (LOAD-10)", () => {
  it("references the feasibility verdict and the rehandle/utilization figures", () => {
    const route = linearRoute(3);
    const blocks = [block("LB-H1", "H1", 80), block("LB-H2", "H2", 1), block("LB-H3", "H3", 1)];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-H1"], 80), slice(1, ["LB-H2"], 1), slice(2, ["LB-H3"], 1)],
      placements: [
        { loadBlockId: "LB-H1", depth: 0, unloadOrder: 0 },
        { loadBlockId: "LB-H2", depth: 1, unloadOrder: 1 },
        { loadBlockId: "LB-H3", depth: 2, unloadOrder: 2 },
      ],
    };
    const text = planExplanation(plan, blocks, route, config);
    expect(text.toLowerCase()).toMatch(/feasible|infeasible/);
    expect(text.toLowerCase()).toContain("rehandle");
    expect(text.toLowerCase()).toMatch(/utilization|utilisation/);
  });

  it("aggregates the per-placement rationales (mentions placed blocks)", () => {
    const route = linearRoute(2);
    const blocks = [block("LB-X", "H2", 3), block("LB-T", "H1", 2)];
    const plan: LoadPlan = {
      trailerId: "TR",
      slices: [slice(0, ["LB-X"], 3), slice(1, ["LB-T"], 2)],
      placements: [
        { loadBlockId: "LB-X", depth: 0, unloadOrder: 1 },
        { loadBlockId: "LB-T", depth: 1, unloadOrder: 0 },
      ],
    };
    const text = planExplanation(plan, blocks, route, config);
    expect(text).toContain("LB-X");
    expect(text).toContain("LB-T");
  });
});
