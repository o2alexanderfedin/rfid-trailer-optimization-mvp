import { describe, expect, it } from "vitest";

import { constructRoutes } from "./construct.js";
import { feasibleArrivals, routeCost, totalDemand } from "./feasibility.js";
import { localSearch } from "./local-search.js";
import type { Stop, TravelModel } from "./types.js";

/**
 * 2-opt / or-opt LOCAL SEARCH tests (OPT-03, Task 2).
 *
 * The locked contract the local search must satisfy on ANY feasible input:
 *  1. It NEVER increases the travel-cost objective (monotone non-worsening).
 *  2. It NEVER introduces a time-window or capacity violation.
 *  3. A window/capacity-violating candidate move is rejected (never applied).
 *
 * (2) + (3) are enforced by re-checking every fixture's output with the SHARED
 * {@link feasibleArrivals} predicate (the same one construction uses — DRY). The
 * property test sweeps a DETERMINISTIC pseudo-random fixture family (a seeded
 * LCG — NO `Math.random`, so the suite is replay-safe) to exercise the moves.
 */

/** Euclidean-ish travel model over 1-D integer-coordinate hubs (deterministic). */
function lineTravel(): TravelModel {
  return { travelMin: (from, to) => Math.abs(Number(from) - Number(to)) };
}

/**
 * A tiny deterministic LCG (Numerical Recipes constants) — a SEEDED generator so
 * the fuzz fixtures are reproducible without `Math.random`. Returns ints in
 * `[0, bound)`.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}

/** Build a random feasible-window fixture: N stops on a line with wide windows. */
function randomFixture(seed: number, n: number): { stops: Stop[]; startHubId: string } {
  const rnd = lcg(seed);
  const stops: Stop[] = [];
  for (let i = 0; i < n; i += 1) {
    const coord = rnd() % 200; // hub coordinate 0..199
    stops.push({
      hubId: String(coord) + "_" + String(i), // unique id; coord parsed by travel? no — see below
      serviceMin: rnd() % 5,
      windowStartMin: 0,
      windowEndMin: 100_000, // wide windows ⇒ always window-feasible
      demand: 0,
    });
  }
  return { stops, startHubId: "start" };
}

/**
 * Coordinate-bearing travel: hubId is `"<coord>_<i>"`; travel is the |Δcoord|.
 * Pure + deterministic. `start` is coordinate 0.
 */
function coordTravel(): TravelModel {
  const coord = (hubId: string): number => (hubId === "start" ? 0 : Number(hubId.split("_")[0]));
  return { travelMin: (from, to) => Math.abs(coord(from) - coord(to)) };
}

describe("localSearch — 2-opt / or-opt (never worsens, never violates)", () => {
  it("strictly improves a deliberately crossed (2-opt-able) route", () => {
    const travel = lineTravel();
    // Sequence 0 → 30 → 10 → 20 has a crossing; 2-opt should uncross to 0,10,20,30.
    const stops: readonly Stop[] = [
      { hubId: "0", serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0 },
      { hubId: "30", serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0 },
      { hubId: "10", serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0 },
      { hubId: "20", serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0 },
    ];
    const before = routeCost(stops, "0", travel);

    const improved = localSearch({ sequence: stops, startHubId: "0", capacity: 100, travel });

    expect(improved.cost).toBeLessThan(before);
    expect(improved.sequence.map((s) => s.hubId)).toEqual(["0", "10", "20", "30"]);
    // Still window-feasible.
    expect(feasibleArrivals(improved.sequence, "0", travel)).not.toBeNull();
  });

  it("leaves an already-optimal route unchanged (no worsening, idempotent)", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      { hubId: "0", serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0 },
      { hubId: "10", serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0 },
      { hubId: "20", serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0 },
    ];
    const before = routeCost(stops, "0", travel);

    const result = localSearch({ sequence: stops, startHubId: "0", capacity: 100, travel });

    expect(result.cost).toBe(before);
    expect(result.sequence.map((s) => s.hubId)).toEqual(["0", "10", "20"]);
  });

  it("NEVER worsens cost and NEVER violates windows/capacity (seeded property sweep)", () => {
    const travel = coordTravel();
    for (let seed = 1; seed <= 60; seed += 1) {
      const n = 3 + (seed % 6); // 3..8 stops
      const { stops, startHubId } = randomFixture(seed, n);
      // Build a feasible starting route via construction (capacity huge ⇒ all fit).
      const built = constructRoutes({ stops, capacity: 1_000_000, startHubId, travel });
      expect(built.feasible).toBe(true);
      const beforeCost = built.cost;

      const improved = localSearch({
        sequence: built.sequence,
        startHubId,
        capacity: 1_000_000,
        travel,
      });

      // (1) monotone non-worsening
      expect(improved.cost).toBeLessThanOrEqual(beforeCost);
      // recomputed cost matches reported cost (no bookkeeping drift)
      expect(routeCost(improved.sequence, startHubId, travel)).toBe(improved.cost);
      // (2) still feasible (windows + capacity) — same shared predicate as construct
      expect(feasibleArrivals(improved.sequence, startHubId, travel)).not.toBeNull();
      expect(totalDemand(improved.sequence)).toBeLessThanOrEqual(1_000_000);
      // permutation invariant: same multiset of stops, none lost/duplicated
      expect(improved.sequence.map((s) => s.hubId).sort()).toEqual(
        built.sequence.map((s) => s.hubId).sort(),
      );
    }
  });

  it("rejects a move that would break a tight time window (feasibility preserved)", () => {
    const travel = lineTravel();
    // Stop "5" has a TIGHT window forcing it early; an or-opt/2-opt move that
    // pushes it later must be rejected. Start at 0: visiting 5 first (arr 5) is
    // the only feasible order for its [0,6] window; 100 has a wide window.
    const stops: readonly Stop[] = [
      { hubId: "5", serviceMin: 0, windowStartMin: 0, windowEndMin: 6, demand: 0 },
      { hubId: "100", serviceMin: 0, windowStartMin: 0, windowEndMin: 100_000, demand: 0 },
    ];
    // Already optimal order is [5, 100] (cost 5 + 95 = 100). Any swap to [100, 5]
    // would arrive at 5 at minute 100+95=195 > 6 ⇒ infeasible ⇒ must be rejected.
    const result = localSearch({ sequence: stops, startHubId: "0", capacity: 100, travel });

    expect(feasibleArrivals(result.sequence, "0", travel)).not.toBeNull();
    expect(result.sequence.map((s) => s.hubId)).toEqual(["5", "100"]);
  });

  it("is deterministic: identical input ⇒ identical output", () => {
    const travel = coordTravel();
    const { stops, startHubId } = randomFixture(42, 7);
    const built = constructRoutes({ stops, capacity: 1_000_000, startHubId, travel });
    const a = localSearch({ sequence: built.sequence, startHubId, capacity: 1_000_000, travel });
    const b = localSearch({ sequence: built.sequence, startHubId, capacity: 1_000_000, travel });
    expect(a.sequence.map((s) => s.hubId)).toEqual(b.sequence.map((s) => s.hubId));
    expect(a.cost).toBe(b.cost);
  });
});
