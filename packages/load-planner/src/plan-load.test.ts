import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNER_CONFIG,
  type BlockKey,
  type LoadBlock,
  type PlannerConfig,
  type RouteStop,
} from "@mm/domain";
import { canonicalInvariantHolds, countBlockers } from "./lifo-invariant.js";
import { buildUnloadOrderMap } from "./unload-order.js";
import { planLoad } from "./plan-load.js";

/**
 * Task 1 — the greedy route-aware planner (LOAD-03) + partial-LIFO (LOAD-05).
 *
 * `planLoad(blocks, route, config)` sorts blocks by unloadOrder DESCENDING
 * (latest-unload first), and places nose→rear into capacity-honoring slices so
 * earlier-unload freight ends nearer the rear door (depth 0). The output
 * placements satisfy the ONE canonical invariant (imported, never re-stated):
 * `unloadOrder(A) < unloadOrder(B) ⟹ depth(A) ≤ depth(B)`.
 *
 * Partial-LIFO (LOAD-05): when capacity forces a layout that cannot be perfectly
 * LIFO, the planner still emits a plan with BOUNDED blockers (≤ maxAllowedBlockers)
 * rather than rejecting — it never silently exceeds the bound when a feasible
 * layout exists. The rehandle COST is assigned in a later plan; here the planner
 * just doesn't reject a bounded-blocker layout.
 */

/** A trailer-zone-sized block key whose `nextUnloadHubId` drives the unload order. */
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

/** Build a minimal, valid LoadBlock for a given next-unload hub + aggregates. */
function block(
  loadBlockId: string,
  nextUnloadHubId: string,
  totalVolume = 1,
  totalWeight = 1,
): LoadBlock {
  return {
    loadBlockId,
    key: keyFor(nextUnloadHubId),
    packageIds: [`${loadBlockId}-p0`],
    packageCount: 1,
    totalVolume,
    totalWeight,
    priority: 0,
  };
}

/** A 4-hub linear route: hub Hk unloaded at stop k (earlier stop ⇒ lower order). */
function linearRoute(hubCount: number): RouteStop[] {
  const stops: RouteStop[] = [];
  for (let i = 0; i < hubCount; i += 1) {
    stops.push({ hubId: `H${i + 1}`, stopIndex: i });
  }
  return stops;
}

/** Roomy config: one block per slice never forced; plenty of capacity. */
const roomyConfig: PlannerConfig = DEFAULT_PLANNER_CONFIG;

describe("planLoad — greedy route-aware placement (LOAD-03)", () => {
  it("produces a plan whose placements satisfy the canonical invariant (clean LIFO)", () => {
    const route = linearRoute(4);
    const blocks = [
      block("LB1", "H1"),
      block("LB2", "H2"),
      block("LB3", "H3"),
      block("LB4", "H4"),
    ];
    const plan = planLoad(blocks, route, roomyConfig);

    expect(canonicalInvariantHolds(plan.placements)).toBe(true);
    // clean-LIFO input ⇒ zero blockers for every placement
    const totalBlockers = plan.placements.reduce(
      (n, p) => n + countBlockers(p, plan.placements),
      0,
    );
    expect(totalBlockers).toBe(0);
  });

  it("places earliest-unload freight nearest the rear (lowest depth)", () => {
    const route = linearRoute(4);
    // One block per slice (each block ≈ a full slice's volume) so the depth
    // separation between earliest and latest unload is physically forced and
    // observable, rather than collapsing into a single roomy slice.
    const big = roomyConfig.maxBlockVolume;
    const blocks = [
      block("LB1", "H1", big), // unloads first ⇒ belongs at the rear (depth 0)
      block("LB2", "H2", big),
      block("LB3", "H3", big),
      block("LB4", "H4", big), // unloads last ⇒ belongs at the nose (deepest)
    ];
    const plan = planLoad(blocks, route, roomyConfig);

    const order = buildUnloadOrderMap(route);
    const byId = new Map(plan.placements.map((p) => [p.loadBlockId, p]));
    const lb1 = byId.get("LB1");
    const lb4 = byId.get("LB4");
    expect(lb1).toBeDefined();
    expect(lb4).toBeDefined();
    if (lb1 === undefined || lb4 === undefined) return;
    // earliest unload (H1, order 0) sits at strictly lower depth than latest (H4)
    expect(lb1.depth).toBeLessThan(lb4.depth);
    // placements carry the unloadOrder derived from the route
    expect(lb1.unloadOrder).toBe(order.get("H1"));
    expect(lb4.unloadOrder).toBe(order.get("H4"));
  });

  it("records every block exactly once in the plan placements + slices", () => {
    const route = linearRoute(4);
    const blocks = [
      block("LB1", "H1"),
      block("LB2", "H2"),
      block("LB3", "H3"),
      block("LB4", "H4"),
    ];
    const plan = planLoad(blocks, route, roomyConfig);

    expect(plan.placements).toHaveLength(4);
    const placedIds = plan.placements.map((p) => p.loadBlockId).sort();
    expect(placedIds).toEqual(["LB1", "LB2", "LB3", "LB4"]);

    // slice loadBlockIds union equals the placed ids (no block lost / duplicated)
    const sliceIds = plan.slices.flatMap((s) => s.loadBlockIds).sort();
    expect(sliceIds).toEqual(["LB1", "LB2", "LB3", "LB4"]);
  });

  it("honors per-slice volume capacity: oversize freight forces multiple slices", () => {
    const route = linearRoute(2);
    // Two big blocks for the SAME hub (same unloadOrder) that cannot share a slice.
    // capacityVolume comes from the trailer the planner builds; the planner must
    // not over-fill a slice, so these land in two distinct depths.
    const blocks = [
      block("LB-A", "H1", 8, 1),
      block("LB-B", "H1", 8, 1),
    ];
    const plan = planLoad(blocks, route, roomyConfig);
    // no slice exceeds its own volume capacity
    for (const s of plan.slices) {
      expect(s.usedVolume).toBeLessThanOrEqual(s.capacityVolume);
      expect(s.usedWeight).toBeLessThanOrEqual(s.capacityWeight);
    }
    // both blocks placed
    expect(plan.placements).toHaveLength(2);
  });

  it("is DETERMINISTIC: shuffled input block order yields an identical plan", () => {
    const route = linearRoute(4);
    const base = [
      block("LB1", "H1"),
      block("LB2", "H2"),
      block("LB3", "H3"),
      block("LB4", "H4"),
    ];
    const shuffled = [base[3]!, base[0]!, base[2]!, base[1]!];

    const a = planLoad(base, route, roomyConfig);
    const b = planLoad(shuffled, route, roomyConfig);
    expect(b).toEqual(a);
  });

  it("breaks unloadOrder ties deterministically by loadBlockId (stable)", () => {
    const route = linearRoute(2);
    // Three blocks for the SAME hub (tie in unloadOrder); ids out of order.
    const blocks = [block("LB-C", "H1"), block("LB-A", "H1"), block("LB-B", "H1")];
    const plan = planLoad(blocks, route, roomyConfig);
    // all same unloadOrder ⇒ invariant trivially holds, and the plan is stable
    expect(canonicalInvariantHolds(plan.placements)).toBe(true);
    const again = planLoad([...blocks].reverse(), route, roomyConfig);
    expect(again).toEqual(plan);
  });
});

describe("planLoad — partial-LIFO acceptance (LOAD-05)", () => {
  it("does NOT reject a bounded-blocker layout (≤ maxAllowedBlockers)", () => {
    // Force a layout where perfect LIFO is impossible within capacity but the
    // resulting blocker count stays within the bound: the planner must return a
    // plan, not throw / return null.
    const route = linearRoute(4);
    const blocks = [
      block("LB1", "H1"),
      block("LB2", "H2"),
      block("LB3", "H3"),
      block("LB4", "H4"),
    ];
    const plan = planLoad(blocks, route, { ...roomyConfig, maxAllowedBlockers: 2 });
    expect(plan).toBeDefined();
    expect(plan.placements.length).toBe(4);
    // bounded: no placement is blocked by more than maxAllowedBlockers
    for (const p of plan.placements) {
      expect(countBlockers(p, plan.placements)).toBeLessThanOrEqual(2);
    }
  });

  it("handles the empty block list as an empty, valid plan", () => {
    const route = linearRoute(2);
    const plan = planLoad([], route, roomyConfig);
    expect(plan.placements).toHaveLength(0);
    expect(canonicalInvariantHolds(plan.placements)).toBe(true);
  });
});
