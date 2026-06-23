import { describe, expect, it } from "vitest";

import { feasibleArrivals } from "./feasibility.js";
import type { Stop, TravelModel } from "./types.js";

/**
 * `feasibleArrivals` rest-as-time tests (OPT-HOS-02).
 *
 * An optional `restMin` on a {@link Stop} models a driver rest/break that the
 * Phase-10 HOS engine says must be inserted before/within servicing the stop.
 * It folds into the existing `serviceMin` computation — rest-as-time, NO new
 * graph edge kind — so `departure = serviceStart + serviceMin + restMin` and the
 * next leg's arrival is pushed out by exactly the rest minutes. Window
 * feasibility is unchanged (rest does not affect when service may BEGIN). Pure +
 * deterministic integer-minute arithmetic.
 */

/** 1-D line travel: hub "<coord>", travel = |Δcoord|. Pure + deterministic. */
function lineTravel(): TravelModel {
  return { travelMin: (from, to) => Math.abs(Number(from) - Number(to)) };
}

function stop(p: Partial<Stop> & Pick<Stop, "hubId">): Stop {
  return { serviceMin: 0, windowStartMin: 0, windowEndMin: 1_000_000, demand: 0, ...p };
}

describe("feasibleArrivals — restMin folds into serviceMin (rest-as-time)", () => {
  it("adds restMin to the departure (a rest before the next leg pushes the next arrival out)", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "0", serviceMin: 5, restMin: 600 }), // 10h rest folded as service
      stop({ hubId: "10", serviceMin: 3 }),
    ];

    const routed = feasibleArrivals(stops, "0", travel, 0);
    expect(routed).not.toBeNull();
    // stop 0: arrive 0, service 5 + rest 600 → depart 605
    // stop 10: arrive 605 + travel 10 = 615, service 3 → depart 618
    expect(routed).toEqual([
      { hubId: "0", arrivalMin: 0, departureMin: 605 },
      { hubId: "10", arrivalMin: 615, departureMin: 618 },
    ]);
  });

  it("omitting restMin is byte-identical to restMin: 0 (back-compat default)", () => {
    const travel = lineTravel();
    const noRest: readonly Stop[] = [
      stop({ hubId: "0", serviceMin: 5 }),
      stop({ hubId: "10", serviceMin: 3 }),
    ];
    const zeroRest: readonly Stop[] = [
      stop({ hubId: "0", serviceMin: 5, restMin: 0 }),
      stop({ hubId: "10", serviceMin: 3, restMin: 0 }),
    ];
    expect(feasibleArrivals(noRest, "0", travel, 0)).toEqual(
      feasibleArrivals(zeroRest, "0", travel, 0),
    );
  });

  it("restMin does NOT change when service may BEGIN (window check is on arrival only)", () => {
    const travel = lineTravel();
    // Arrival 0 is within the window even though departure (after a long rest)
    // would be far past windowEnd — rest is added AFTER service begins.
    const stops: readonly Stop[] = [
      stop({ hubId: "0", serviceMin: 2, restMin: 600, windowStartMin: 0, windowEndMin: 5 }),
    ];
    const routed = feasibleArrivals(stops, "0", travel, 0);
    expect(routed).not.toBeNull();
    expect(routed![0]).toEqual({ hubId: "0", arrivalMin: 0, departureMin: 602 });
  });

  it("is deterministic with restMin: identical input ⇒ identical ETAs", () => {
    const travel = lineTravel();
    const stops: readonly Stop[] = [
      stop({ hubId: "0", serviceMin: 1, restMin: 30 }),
      stop({ hubId: "10", serviceMin: 1, restMin: 600 }),
    ];
    expect(feasibleArrivals(stops, "0", travel, 0)).toEqual(
      feasibleArrivals(stops, "0", travel, 0),
    );
  });
});
