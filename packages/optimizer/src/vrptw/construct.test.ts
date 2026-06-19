import { describe, expect, it } from "vitest";

import { constructRoutes } from "./construct.js";
import { feasibleArrivals, routeCost } from "./feasibility.js";
import type { Stop, TravelModel } from "./types.js";

/**
 * Cheapest-insertion CONSTRUCTION tests (OPT-03, Task 1).
 *
 * The construction greedily inserts each stop at the position minimizing added
 * TRAVEL cost while keeping every time window + the capacity feasible. These
 * fixtures use a tiny line-graph travel model so the expected sequences are
 * hand-checkable, and every value is a whole minute (anti-P12). The same input
 * must always produce the same route (anti-P3 determinism, lexicographic
 * tie-breaks).
 */

/**
 * A 1-D "line" travel model: hubs named by their integer coordinate, travel =
 * absolute distance in minutes. Pure + deterministic (no clock/RNG).
 */
function lineTravel(): TravelModel {
  return {
    travelMin(from, to) {
      return Math.abs(Number(from) - Number(to));
    },
  };
}

/** Build a stop with wide-open windows unless overridden. */
function stop(partial: Partial<Stop> & Pick<Stop, "hubId">): Stop {
  return {
    serviceMin: 0,
    windowStartMin: 0,
    windowEndMin: 100_000,
    demand: 0,
    ...partial,
  };
}

describe("constructRoutes — cheapest-insertion (window + capacity feasible)", () => {
  it("builds a sequence visiting all stops, each serviced within its window", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "0" }),
      stop({ hubId: "10" }),
      stop({ hubId: "20" }),
    ];

    const result = constructRoutes({ stops, capacity: 100, startHubId: "0", travel });

    expect(result.feasible).toBe(true);
    // All three stops are present.
    expect(result.sequence.map((s) => s.hubId).sort()).toEqual(["0", "10", "20"]);
    // The arrivals computed for the sequence are all within window (no rejection).
    const arrivals = feasibleArrivals(result.sequence, "0", travel);
    expect(arrivals).not.toBeNull();
  });

  it("orders stops along the line (0,10,20) — cheapest insertion minimizes travel", () => {
    const travel = lineTravel();
    // Present out of order; cheapest-insertion must produce the monotone line.
    const stops: readonly Stop[] = [
      stop({ hubId: "20" }),
      stop({ hubId: "0" }),
      stop({ hubId: "10" }),
    ];

    const result = constructRoutes({ stops, capacity: 100, startHubId: "0", travel });

    expect(result.sequence.map((s) => s.hubId)).toEqual(["0", "10", "20"]);
    // Cost is start→stops travel: |0-0| + |0-10| + |10-20| = 0 + 10 + 10 = 20.
    expect(result.cost).toBe(20);
    expect(routeCost(result.sequence, "0", travel)).toBe(20);
  });

  it("rejects an insertion that would arrive after a stop's window end (infeasible)", () => {
    const travel = lineTravel();
    // Stop "100" is reachable at minute 100 from start "0", but its window
    // closes at 50 ⇒ it can never be serviced ⇒ the route cannot fit all stops.
    const stops: readonly Stop[] = [
      stop({ hubId: "10" }),
      stop({ hubId: "100", windowStartMin: 0, windowEndMin: 50 }),
    ];

    const result = constructRoutes({ stops, capacity: 100, startHubId: "0", travel });

    expect(result.feasible).toBe(false);
    // The unfittable stop is reported; the feasible one is still placed.
    expect(result.unplaced.map((s) => s.hubId)).toContain("100");
    expect(result.sequence.map((s) => s.hubId)).toEqual(["10"]);
  });

  it("never exceeds capacity: total demand on the route ≤ capacity", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "0", demand: 6 }),
      stop({ hubId: "10", demand: 6 }),
      stop({ hubId: "20", demand: 6 }),
    ];

    const result = constructRoutes({ stops, capacity: 10, travel, startHubId: "0" });

    const placedDemand = result.sequence.reduce((acc, s) => acc + s.demand, 0);
    expect(placedDemand).toBeLessThanOrEqual(10);
    // At least one stop could not be placed (3×6 = 18 > 10), so route is infeasible.
    expect(result.feasible).toBe(false);
    expect(result.unplaced.length).toBeGreaterThan(0);
  });

  it("is deterministic: identical input ⇒ identical sequence (lexicographic tie-break)", () => {
    const travel = lineTravel();
    // Two stops equidistant from start: tie must break by hubId lexicographically.
    const stops: readonly Stop[] = [stop({ hubId: "b5" }), stop({ hubId: "a5" })];
    const reversed: readonly Stop[] = [stop({ hubId: "a5" }), stop({ hubId: "b5" })];
    // Use a constant-distance travel model so insertion costs tie.
    const flat: TravelModel = { travelMin: () => 7 };

    const a = constructRoutes({ stops, capacity: 100, startHubId: "start", travel: flat });
    const b = constructRoutes({ stops: reversed, capacity: 100, startHubId: "start", travel: flat });

    expect(a.sequence.map((s) => s.hubId)).toEqual(b.sequence.map((s) => s.hubId));
    // Travel model `flat` is unused by the line assertion but documents the tie.
    void travel;
  });
});
