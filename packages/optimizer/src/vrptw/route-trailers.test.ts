import { DEFAULT_PLANNER_CONFIG, type LoadBlock, type RouteStop } from "@mm/domain";
import { isFeasible, validatePlan } from "@mm/load-planner";
import { describe, expect, it } from "vitest";

import { routeTrailers } from "./route-trailers.js";
import type { Stop, TravelModel } from "./types.js";

/**
 * `routeTrailers` tests (OPT-03, Task 3): ETAs + utilization + the REUSED
 * Phase-2 HARD gate.
 *
 * `routeTrailers` runs construct → localSearch, derives arrival/departure ETAs
 * from the {@link TravelModel} + service times, computes utilization
 * (`demand / capacity`), AND gates the resulting trailer load through
 * `@mm/load-planner`'s `validatePlan`/`isFeasible` — NO LIFO/blocker logic is
 * reimplemented in the optimizer (DRY; a grep gate in the plan enforces this).
 */

/** 1-D line travel: hub "<coord>", travel = |Δcoord|. Pure + deterministic. */
function lineTravel(): TravelModel {
  return { travelMin: (from, to) => Math.abs(Number(from) - Number(to)) };
}

function stop(p: Partial<Stop> & Pick<Stop, "hubId">): Stop {
  return { serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0, ...p };
}

describe("routeTrailers — ETAs + utilization + reused HARD gate", () => {
  it("returns RoutedStop ETAs consistent with travel + service times", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "0", serviceMin: 5, demand: 2 }),
      stop({ hubId: "10", serviceMin: 3, demand: 2 }),
      stop({ hubId: "20", serviceMin: 0, demand: 2 }),
    ];

    const route = routeTrailers({ trailerId: "T1", capacity: 10, stops, startHubId: "0", travel });

    expect(route.sequence.map((s) => s.hubId)).toEqual(["0", "10", "20"]);
    // Walk: start at 0, leave at 0.
    //  stop 0: arrive 0, service 5 → depart 5
    //  stop 10: arrive 5+10=15, service 3 → depart 18
    //  stop 20: arrive 18+10=28, service 0 → depart 28
    expect(route.sequence).toEqual([
      { hubId: "0", arrivalMin: 0, departureMin: 5 },
      { hubId: "10", arrivalMin: 15, departureMin: 18 },
      { hubId: "20", arrivalMin: 28, departureMin: 28 },
    ]);
  });

  it("computes utilization = totalDemand / capacity", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "0", demand: 3 }),
      stop({ hubId: "10", demand: 5 }),
    ];
    const route = routeTrailers({ trailerId: "T1", capacity: 10, stops, startHubId: "0", travel });
    expect(route.utilization).toBeCloseTo(0.8, 10);
  });

  it("respects a waiting window: arrival before window ⇒ trailer waits (depart = windowStart + service)", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "10", windowStartMin: 50, windowEndMin: 100, serviceMin: 4, demand: 1 }),
    ];
    const route = routeTrailers({ trailerId: "T1", capacity: 10, stops, startHubId: "0", travel });
    // Arrive at 10 (minute 10), window opens 50 ⇒ wait ⇒ service starts 50, depart 54.
    expect(route.sequence[0]).toEqual({ hubId: "10", arrivalMin: 10, departureMin: 54 });
  });

  it("a LIFO-correct load passes the REUSED validatePlan HARD gate (feasible: true)", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "0", demand: 2 }),
      stop({ hubId: "10", demand: 2 }),
      stop({ hubId: "20", demand: 2 }),
    ];
    const route = routeTrailers({ trailerId: "T1", capacity: 10, stops, startHubId: "0", travel });
    expect(route.feasible).toBe(true);
  });

  it("reports feasible:false when stops cannot all be serviced within windows", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "10" }),
      // unreachable in time: arrives at 100 but window closes at 20.
      stop({ hubId: "100", windowStartMin: 0, windowEndMin: 20 }),
    ];
    const route = routeTrailers({ trailerId: "T1", capacity: 10, stops, startHubId: "0", travel });
    expect(route.feasible).toBe(false);
  });

  it("a deliberately un-unloadable load fails the REUSED HARD gate", () => {
    // Independently build the WORST-CASE load: every later-unload block placed in
    // FRONT of every earlier one (depth reversed vs. unload order) ⇒ blockers
    // exceed maxAllowedBlockers ⇒ HARD infeasible. This proves the optimizer's
    // feasibility comes from the SAME reused validator, with the same verdict.
    const route: readonly RouteStop[] = [
      { hubId: "A", stopIndex: 0 },
      { hubId: "B", stopIndex: 1 },
      { hubId: "C", stopIndex: 2 },
      { hubId: "D", stopIndex: 3 },
    ];
    const blocks: readonly LoadBlock[] = route.map((s, i) => ({
      loadBlockId: "blk-" + s.hubId,
      key: {
        currentHubId: "start",
        nextUnloadHubId: s.hubId,
        finalDestHubId: s.hubId,
        slaClass: "standard",
        deadlineBucket: 0,
        handlingClass: "standard",
        sizeWeightClass: "small",
      },
      packageIds: ["p" + String(i)],
      packageCount: 1,
      totalVolume: 1,
      totalWeight: 1,
      priority: 0,
    }));
    // Reversed depth: A (unloads first) at the NOSE (deepest), D at the rear.
    const badPlan = {
      slices: [
        { depth: 0, loadBlockIds: ["blk-D"] },
        { depth: 1, loadBlockIds: ["blk-C"] },
        { depth: 2, loadBlockIds: ["blk-B"] },
        { depth: 3, loadBlockIds: ["blk-A"] },
      ],
    };
    const result = validatePlan(badPlan, blocks, route, DEFAULT_PLANNER_CONFIG);
    expect(isFeasible(result)).toBe(false);
  });

  it("FIX 4: a hub-revisiting route is not over-counted with phantom LIFO blockers", () => {
    // Route revisits hub "0" at the END after visiting 10,20,30: 0→10→20→30→0.
    // Each visit unloads a DIFFERENT block; the load is LIFO-correct by
    // construction (stop k at depth k, unloaded k-th), so it must be feasible.
    //
    // The phantom-blocker bug: buildUnloadOrderMap collapses both "0" visits to a
    // single unload order (0), so the FINAL "0" block (loaded at the nose, depth 4)
    // is wrongly seen as unloading FIRST. The three intervening blocks (10,20,30) —
    // all in front of it and all "unloading later" under the collapsed order — are
    // counted as 3 PHANTOM blockers, exceeding maxAllowedBlockers (2) ⇒ a HARD
    // false-negative. Physically the nose block is unloaded LAST, with NOTHING
    // still in front of it (10,20,30 already came off), so the true count is 0.
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "0", windowStartMin: 0, windowEndMin: 5, demand: 1 }),
      stop({ hubId: "10", windowStartMin: 10, windowEndMin: 12, demand: 1 }),
      stop({ hubId: "20", windowStartMin: 30, windowEndMin: 35, demand: 1 }),
      stop({ hubId: "30", windowStartMin: 50, windowEndMin: 55, demand: 1 }),
      // Window forces the SECOND "0" visit to be serviced LAST ⇒ a true revisit.
      stop({ hubId: "0", windowStartMin: 80, windowEndMin: 90, demand: 1 }),
    ];
    const route = routeTrailers({ trailerId: "T1", capacity: 10, stops, startHubId: "0", travel });

    // The route genuinely revisits "0" (a true hub-revisit, not a dedupe).
    expect(route.sequence.map((s) => s.hubId)).toEqual(["0", "10", "20", "30", "0"]);
    // A LIFO-correct revisiting load must NOT be flagged infeasible (no phantoms).
    expect(route.feasible).toBe(true);
  });

  it("is deterministic: identical input ⇒ identical route + ETAs + utilization", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "20", demand: 1 }),
      stop({ hubId: "0", demand: 1 }),
      stop({ hubId: "10", demand: 1 }),
    ];
    const a = routeTrailers({ trailerId: "T1", capacity: 10, stops, startHubId: "0", travel });
    const b = routeTrailers({ trailerId: "T1", capacity: 10, stops, startHubId: "0", travel });
    expect(a).toEqual(b);
  });
});
