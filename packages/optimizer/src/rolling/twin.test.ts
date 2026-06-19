import { describe, expect, it } from "vitest";

import { buildTwin } from "./twin.js";
import type { OptimizerScope } from "./types.js";
import type { TwinSnapshot } from "./types.js";

/**
 * OPT-04: the optimizer evaluates candidates on a `structuredClone` planning-twin
 * sandbox. `buildTwin(scope, snapshot)` returns a DEEP CLONE of the affected
 * slice — mutating the twin must NEVER touch the source snapshot, so evaluation
 * has zero side effects until accept.
 */

function snapshot(): TwinSnapshot {
  return {
    hubs: ["H1", "H2", "H3"],
    routes: [
      { routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin: 30, capacity: 10 },
      { routeId: "R2", fromHubId: "H2", toHubId: "H3", travelMin: 40, capacity: 10 },
    ],
    trailers: [
      {
        trailerId: "T1",
        currentHubId: "H1",
        departureMin: 120,
        capacity: 10,
        route: [
          { hubId: "H2", stopIndex: 0 },
          { hubId: "H3", stopIndex: 1 },
        ],
        blocks: [{ blockId: "B1", nextUnloadHubId: "H2", volume: 3 }],
      },
      {
        trailerId: "T2",
        currentHubId: "H3",
        departureMin: 200,
        capacity: 10,
        route: [{ hubId: "H1", stopIndex: 0 }],
        blocks: [{ blockId: "B2", nextUnloadHubId: "H1", volume: 5 }],
      },
    ],
  };
}

const FULL_SCOPE: OptimizerScope = {
  hubIds: ["H1", "H2", "H3"],
  trailerIds: ["T1", "T2"],
  horizonStartMin: 100,
  horizonEndMin: 340,
  timeStepMin: 15,
};

describe("buildTwin (OPT-04 structuredClone sandbox)", () => {
  it("returns a deep clone — mutating the twin does NOT mutate the source", () => {
    const src = snapshot();
    const twin = buildTwin(FULL_SCOPE, src);

    // Mutate the twin's nested structures.
    (twin.trailers[0]!.blocks as { blockId: string }[]).push({
      blockId: "INJECTED",
    } as never);
    (twin.trailers[0] as { departureMin: number }).departureMin = -999;

    // Source is untouched.
    expect(src.trailers[0]!.blocks).toHaveLength(1);
    expect(src.trailers[0]!.departureMin).toBe(120);
  });

  it("scopes to ONLY the affected trailers/hubs (OPT-05): out-of-scope trailers excluded", () => {
    const src = snapshot();
    const scope: OptimizerScope = { ...FULL_SCOPE, trailerIds: ["T1"], hubIds: ["H1", "H2"] };
    const twin = buildTwin(scope, src);

    expect(twin.trailers.map((t) => t.trailerId)).toEqual(["T1"]);
    expect(twin.hubs).toEqual(["H1", "H2"]);
    // Routes touching only in-scope hubs survive; R2 (H2→H3) drops (H3 out of scope).
    expect(twin.routes.map((r) => r.routeId)).toEqual(["R1"]);
  });

  it("the cloned twin is structurally equal to the scoped source (no data loss)", () => {
    const src = snapshot();
    const twin = buildTwin(FULL_SCOPE, src);
    expect(twin).toEqual(src);
    expect(twin).not.toBe(src);
    expect(twin.trailers).not.toBe(src.trailers);
  });
});
