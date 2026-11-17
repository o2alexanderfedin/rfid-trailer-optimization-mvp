import type { EpochRecommendation, EpochResult, TwinSnapshot, TwinTrailer } from "@mm/optimizer";
import { describe, expect, it } from "vitest";

import type { CoordinatorSuggestion } from "./coordinator.js";
import {
  buildCenterTwinFromFold,
  epochResultToRerouteSuggestions,
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

/**
 * Phase-26 COORD-06 (Plan 01, Task 2) — `epochResultToRerouteSuggestions` translates
 * a pure `EpochResult` into reroute-only `CoordinatorSuggestion[]`.
 *
 * The `EpochResult` payload carries only ids/cost/feasibility/frozen flags — NO route
 * geometry — so the optimizer's chosen NEXT hub for a trailer is read from the SAME
 * twin the epoch planned over (each trailer's route head, the first stop by unload
 * order). A reroute fires ONLY when that optimizer next hub differs from the trailer's
 * CURRENT next hub (`currentNextHubByTrailer`) AND the trailer's recommendation is
 * actionable (feasible + not frozen). Same-or-frozen ⇒ no churn (anti-P7); a trailer
 * with no current next hub ⇒ none (nothing to differ from). Output is sorted by
 * targetAgentId and is a pure function of (result, twin, map).
 */

/** Build a minimal twin whose trailers carry the route heads the translator reads. */
function twinWithRouteHeads(
  heads: readonly { readonly trailerId: string; readonly nextHubId: string }[],
): TwinSnapshot {
  const trailers: readonly TwinTrailer[] = heads.map((h) => ({
    trailerId: h.trailerId,
    currentHubId: "DFW",
    departureMin: 1_030,
    capacity: 50,
    // route head (stopIndex 0) = the optimizer-implied next hub
    route: [
      { hubId: h.nextHubId, stopIndex: 0 },
      { hubId: "ZZZ", stopIndex: 1 },
    ],
    blocks: [],
  }));
  return { hubs: ["DFW"], centerHubId: "DFW", routes: [], trailers };
}

/** A recommendation for a trailer with the given feasible/frozen flags. */
function rec(
  trailerId: string,
  opts: { readonly feasible: boolean; readonly frozen: boolean },
): EpochRecommendation {
  return {
    trailerId,
    planId: `PLAN-${trailerId}`,
    feasible: opts.feasible,
    objectiveCost: 100,
    breakdown: {} as EpochRecommendation["breakdown"],
    frozen: opts.frozen,
  };
}

/** An EpochResult carrying the given recommendations (other fields are inert here). */
function resultWith(recommendations: readonly EpochRecommendation[]): EpochResult {
  return {
    epochId: "E1",
    scopeHash: "HASH",
    generated: null,
    accepted: null,
    recommendations,
    freightAssignment: { assignments: [], flowCost: 0, feasible: true },
  };
}

describe("epochResultToRerouteSuggestions — EpochResult ⇒ reroute CoordinatorSuggestions", () => {
  it("optimizer next hub differs from current ⇒ exactly one reroute (string params only)", () => {
    const twin = twinWithRouteHeads([{ trailerId: "T001", nextHubId: "OKC" }]);
    const result = resultWith([rec("T001", { feasible: true, frozen: false })]);
    const current = new Map<string, string>([["T001", "AUS"]]); // currently heading AUS

    const out = epochResultToRerouteSuggestions(result, twin, current);

    expect(out).toEqual([{ kind: "reroute", targetAgentId: "T001", toHubId: "OKC" }]);
    // params are string-only (no float, no RNG)
    expect(typeof out[0]!.targetAgentId).toBe("string");
  });

  it("frozen / optimizer-next == current ⇒ NO suggestion (anti-P7 no churn)", () => {
    const twin = twinWithRouteHeads([
      { trailerId: "T001", nextHubId: "AUS" }, // SAME as current ⇒ no churn
      { trailerId: "T002", nextHubId: "OKC" }, // differs, but FROZEN ⇒ no churn
    ]);
    const result = resultWith([
      rec("T001", { feasible: true, frozen: false }),
      rec("T002", { feasible: true, frozen: true }),
    ]);
    const current = new Map<string, string>([
      ["T001", "AUS"],
      ["T002", "AUS"],
    ]);

    expect(epochResultToRerouteSuggestions(result, twin, current)).toEqual([]);
  });

  it("trailer not in currentNextHubByTrailer (between legs) ⇒ NO reroute", () => {
    const twin = twinWithRouteHeads([{ trailerId: "T001", nextHubId: "OKC" }]);
    const result = resultWith([rec("T001", { feasible: true, frozen: false })]);
    const current = new Map<string, string>(); // no current next hub for T001

    expect(epochResultToRerouteSuggestions(result, twin, current)).toEqual([]);
  });

  it("output is sorted by targetAgentId and is pure (deep-equal + byte-identical)", () => {
    // recommendations intentionally out of id order to prove the output is sorted
    const twin = twinWithRouteHeads([
      { trailerId: "T003", nextHubId: "OKC" },
      { trailerId: "T001", nextHubId: "LAX" },
      { trailerId: "T002", nextHubId: "SEA" },
    ]);
    const result = resultWith([
      rec("T003", { feasible: true, frozen: false }),
      rec("T001", { feasible: true, frozen: false }),
      rec("T002", { feasible: true, frozen: false }),
    ]);
    const current = new Map<string, string>([
      ["T003", "DFW"],
      ["T001", "DFW"],
      ["T002", "DFW"],
    ]);

    const a = epochResultToRerouteSuggestions(result, twin, current);
    const b = epochResultToRerouteSuggestions(result, twin, current);

    expect(a.map((s) => s.targetAgentId)).toEqual(["T001", "T002", "T003"]);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // only the reroute kind is ever produced (hold/consolidate/dispatch stay rule-based)
    for (const s of a) expect(s.kind).toBe("reroute");
  });

  it("empty-scope EpochResult (no recommendations) ⇒ [] (the fallback substrate)", () => {
    const twin = twinWithRouteHeads([{ trailerId: "T001", nextHubId: "OKC" }]);
    const result = resultWith([]);
    const current = new Map<string, string>([["T001", "AUS"]]);

    const out: readonly CoordinatorSuggestion[] = epochResultToRerouteSuggestions(
      result,
      twin,
      current,
    );
    expect(out).toEqual([]);
  });

  it("an infeasible trailer ⇒ NO reroute (the optimizer did not endorse proceeding)", () => {
    const twin = twinWithRouteHeads([{ trailerId: "T001", nextHubId: "OKC" }]);
    const result = resultWith([rec("T001", { feasible: false, frozen: false })]);
    const current = new Map<string, string>([["T001", "AUS"]]);

    expect(epochResultToRerouteSuggestions(result, twin, current)).toEqual([]);
  });
});
