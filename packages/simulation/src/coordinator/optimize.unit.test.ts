import type { TwinSnapshot } from "@mm/optimizer";
import { describe, expect, it } from "vitest";

import {
  buildCenterTwinFromFold,
  type CenterFoldSlice,
} from "./optimize.js";

/**
 * Phase-26 COORD-06 (Plan 01, Task 1) — `buildCenterTwinFromFold` is the PURE
 * in-fold projection from ONE center's partitioned fold slice (its spokes, its
 * in-region trailers + their remaining route stops + load blocks, and its in-scope
 * route legs) to a small `@mm/optimizer` `TwinSnapshot` scoped to that center.
 *
 * It mirrors the existing full-scan `buildTwinSnapshot` OUTPUT shape but is built
 * from a small per-center FOLD slice (NOT a full event-log scan / Postgres). The
 * NET-05 thesis: the twin a center produces is bounded by THAT center's slice —
 * independent of total network size — because the input is already partitioned.
 *
 * DETERMINISM keystone (T-26-01): same slice ⇒ deep-equal AND byte-identical
 * `TwinSnapshot`; no `Date.now`/`Math.random`/async; the source slice is never
 * mutated (frozen-in ⇒ frozen-out).
 */

const NOW_MIN = 1_000;

/** A two-spoke, one-trailer, two-leg slice for center "DFW". */
function sliceDFW(): CenterFoldSlice {
  return {
    centerId: "DFW",
    spokeHubIds: ["AUS", "OKC"],
    trailers: [
      {
        trailerId: "T001",
        currentHubId: "DFW",
        // scheduled to depart 30 min after `nowMin` (integer offset, no clock)
        departureOffsetMin: 30,
        capacity: 50,
        // intentionally UNSORTED by stopIndex to prove the builder sorts
        routeStops: [
          { hubId: "AUS", stopIndex: 1 },
          { hubId: "OKC", stopIndex: 0 },
        ],
        blocks: [
          { blockId: "B1", nextUnloadHubId: "OKC", volume: 3 },
          { blockId: "B2", nextUnloadHubId: "AUS", volume: 2 },
        ],
      },
    ],
    routeLegs: [
      { routeId: "DFW->OKC", fromHubId: "DFW", toHubId: "OKC", travelMin: 30, capacity: 40 },
      { routeId: "DFW->AUS", fromHubId: "DFW", toHubId: "AUS", travelMin: 45, capacity: 40 },
    ],
  };
}

describe("buildCenterTwinFromFold — per-center TwinSnapshot from a fold slice", () => {
  it("maps a slice to a scoped TwinSnapshot: sorted unique hubs, centerHubId, 1:1 routes, trailers", () => {
    const twin = buildCenterTwinFromFold(sliceDFW(), NOW_MIN);

    // hubs = sorted unique union of centerId + spokes + every hub named on legs/stops/blocks
    expect(twin.hubs).toEqual(["AUS", "DFW", "OKC"]);
    // centerHubId is the slice's center
    expect(twin.centerHubId).toBe("DFW");

    // routes mirror the slice legs 1:1 (order = slice order)
    expect(twin.routes).toEqual([
      { routeId: "DFW->OKC", fromHubId: "DFW", toHubId: "OKC", travelMin: 30, capacity: 40 },
      { routeId: "DFW->AUS", fromHubId: "DFW", toHubId: "AUS", travelMin: 45, capacity: 40 },
    ]);

    // exactly one trailer, route sorted by stopIndex, blocks carried, departure derived
    expect(twin.trailers).toHaveLength(1);
    const t = twin.trailers[0]!;
    expect(t.trailerId).toBe("T001");
    expect(t.currentHubId).toBe("DFW");
    expect(t.capacity).toBe(50);
    // departureMin = nowMin + departureOffsetMin (integer derivation, NEVER Date.now)
    expect(t.departureMin).toBe(NOW_MIN + 30);
    expect(t.route).toEqual([
      { hubId: "OKC", stopIndex: 0 },
      { hubId: "AUS", stopIndex: 1 },
    ]);
    expect(t.blocks).toEqual([
      { blockId: "B1", nextUnloadHubId: "OKC", volume: 3 },
      { blockId: "B2", nextUnloadHubId: "AUS", volume: 2 },
    ]);
  });

  it("scope-size invariance (NET-05): the same center slice ⇒ a byte-identical twin regardless of network size", () => {
    // The builder receives the ALREADY-partitioned per-center slice, so its output
    // cannot depend on how many hubs exist in OTHER centers. Two callers with the
    // identical center-A slice — one in a tiny network, one in a 500-hub network —
    // both produce the SAME twin because the slice is the only input.
    const a = buildCenterTwinFromFold(sliceDFW(), NOW_MIN);
    const b = buildCenterTwinFromFold(sliceDFW(), NOW_MIN);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // twin size scales with THIS center's slice, not the network: 3 hubs, 2 legs,
    // 1 trailer — fixed by the slice, never by an external hub count.
    expect(a.hubs).toHaveLength(3);
    expect(a.routes).toHaveLength(2);
    expect(a.trailers).toHaveLength(1);
  });

  it("is pure & deterministic: deep-equal + byte-identical, and never mutates the source slice", () => {
    const slice = sliceDFW();
    // Deep-freeze the slice: any in-place write the builder might attempt (e.g.
    // sorting the source routeStops array) would THROW, proving frozen-in ⇒
    // frozen-out (the builder reads + copies, never mutates).
    Object.freeze(slice);
    Object.freeze(slice.spokeHubIds);
    Object.freeze(slice.routeLegs);
    Object.freeze(slice.trailers);
    for (const tr of slice.trailers) {
      Object.freeze(tr);
      Object.freeze(tr.routeStops);
      Object.freeze(tr.blocks);
    }

    const first = buildCenterTwinFromFold(slice, NOW_MIN);
    const second = buildCenterTwinFromFold(slice, NOW_MIN);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // frozen-in ⇒ no mutation occurred (a write would have thrown above)
    expect(slice.spokeHubIds).toEqual(["AUS", "OKC"]);
    // the first trailer's source routeStops stay in their original (unsorted) order
    expect(slice.trailers[0]!.routeStops.map((s) => s.stopIndex)).toEqual([1, 0]);
  });

  it("empty-trailer slice ⇒ a twin with empty trailers but still its hubs + routes", () => {
    const empty: CenterFoldSlice = {
      centerId: "DFW",
      spokeHubIds: ["AUS", "OKC"],
      trailers: [],
      routeLegs: [
        { routeId: "DFW->OKC", fromHubId: "DFW", toHubId: "OKC", travelMin: 30, capacity: 40 },
      ],
    };

    const twin: TwinSnapshot = buildCenterTwinFromFold(empty, NOW_MIN);
    expect(twin.trailers).toEqual([]);
    expect(twin.hubs).toEqual(["AUS", "DFW", "OKC"]);
    expect(twin.routes).toHaveLength(1);
    expect(twin.centerHubId).toBe("DFW");
  });
});
