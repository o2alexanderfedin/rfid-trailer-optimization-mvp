import {
  DEFAULT_PLANNER_CONFIG,
  type BlockKey,
  type LoadBlock,
  type PlannerConfig,
  type RouteStop,
} from "@mm/domain";
import { describe, expect, it } from "vitest";
import { baselinePlan } from "./baseline.js";
import { canonicalInvariantHolds } from "./lifo-invariant.js";

/**
 * Task 3a — the naive FIFO baseline planner (LOAD-09).
 *
 * `baselinePlan(blocks, route, config)` is a deliberate strawman: it places
 * blocks in ARRIVAL/FIFO order (stable `loadBlockId` key — NOT `unloadOrder`)
 * nose→rear into capacity-respecting slices, producing the SAME `LoadPlan` shape
 * as `planLoad` so it flows through the SAME `validatePlan` + `scorePlan`
 * plumbing. It has NO LIFO awareness — that is the point.
 */

const config: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, maxBlockVolume: 30 };

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

function block(loadBlockId: string, nextUnloadHubId: string, totalVolume = 25): LoadBlock {
  return {
    loadBlockId,
    key: keyFor(nextUnloadHubId),
    packageIds: [`${loadBlockId}-p0`],
    packageCount: 1,
    totalVolume,
    totalWeight: 1,
    priority: 0,
  };
}

function linearRoute(hubCount: number): RouteStop[] {
  const stops: RouteStop[] = [];
  for (let i = 0; i < hubCount; i += 1) {
    stops.push({ hubId: `H${i + 1}`, stopIndex: i });
  }
  return stops;
}

describe("baselinePlan — naive FIFO strawman (LOAD-09)", () => {
  it("produces the SAME LoadPlan shape (trailerId, slices, placements)", () => {
    const route = linearRoute(3);
    const blocks = [block("LB-A", "H1"), block("LB-B", "H2"), block("LB-C", "H3")];
    const plan = baselinePlan(blocks, route, config);
    expect(typeof plan.trailerId).toBe("string");
    expect(Array.isArray(plan.slices)).toBe(true);
    expect(Array.isArray(plan.placements)).toBe(true);
    // every block appears exactly once across the placements
    expect(plan.placements.map((p) => p.loadBlockId).sort()).toEqual([
      "LB-A",
      "LB-B",
      "LB-C",
    ]);
  });

  it("places in FIFO (id) order nose→rear, IGNORING unloadOrder", () => {
    const route = linearRoute(3);
    // Unload order is REVERSED relative to id order: LB-A unloads FIRST (H1),
    // LB-C unloads LAST (H3). A LIFO planner would put LB-A at the rear; the
    // FIFO baseline puts the FIRST-arriving block (LB-A) at the NOSE (deepest).
    const blocks = [block("LB-A", "H1"), block("LB-B", "H2"), block("LB-C", "H3")];
    const plan = baselinePlan(blocks, route, config);

    const depthOf = (id: string): number =>
      plan.placements.find((p) => p.loadBlockId === id)?.depth ?? -1;
    const noseDepth = Math.max(...plan.slices.map((s) => s.depth));
    // FIFO: first-arriving LB-A is loaded first → deepest (nose).
    expect(depthOf("LB-A")).toBe(noseDepth);
    // last-arriving LB-C is loaded last → at the rear (depth 0).
    expect(depthOf("LB-C")).toBe(0);
  });

  it("carries the TRUE route-derived unloadOrder on each placement", () => {
    const route = linearRoute(3);
    const blocks = [block("LB-A", "H1"), block("LB-B", "H2"), block("LB-C", "H3")];
    const plan = baselinePlan(blocks, route, config);
    const orderOf = (id: string): number =>
      plan.placements.find((p) => p.loadBlockId === id)?.unloadOrder ?? -1;
    // H1 → 0, H2 → 1, H3 → 2 (the real unload order, not the FIFO order).
    expect(orderOf("LB-A")).toBe(0);
    expect(orderOf("LB-B")).toBe(1);
    expect(orderOf("LB-C")).toBe(2);
  });

  it("VIOLATES the canonical invariant on a reversed scenario (it is a strawman)", () => {
    const route = linearRoute(3);
    const blocks = [block("LB-A", "H1"), block("LB-B", "H2"), block("LB-C", "H3")];
    const plan = baselinePlan(blocks, route, config);
    // FIFO buries early-unload LB-A at the nose ⇒ the invariant must NOT hold.
    expect(canonicalInvariantHolds(plan.placements)).toBe(false);
  });

  it("is deterministic (same inputs ⇒ identical plan)", () => {
    const route = linearRoute(3);
    const blocks = [block("LB-C", "H3"), block("LB-A", "H1"), block("LB-B", "H2")];
    expect(baselinePlan(blocks, route, config)).toEqual(
      baselinePlan(blocks, route, config),
    );
  });

  it("respects per-slice capacity (rolls to a new slice on overflow)", () => {
    const route = linearRoute(2);
    // Two 25-vol blocks, slice capacity 30 ⇒ each needs its own slice.
    const blocks = [block("LB-A", "H1", 25), block("LB-B", "H2", 25)];
    const plan = baselinePlan(blocks, route, config);
    expect(plan.slices.length).toBe(2);
    for (const s of plan.slices) {
      expect(s.usedVolume).toBeLessThanOrEqual(s.capacityVolume);
    }
  });
});
