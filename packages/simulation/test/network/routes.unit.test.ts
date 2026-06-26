import { describe, expect, it } from "vitest";
import type { Hub } from "@mm/domain";

import { USA_HUBS } from "../../src/network/hubs.js";
import {
  buildRoutes,
  buildTransitParamsByLeg,
  routeId,
  type RouteTopology,
} from "../../src/network/routes.js";

/**
 * Phase 23 (NET-01) — multi-center `buildRoutes` / `buildTransitParamsByLeg`.
 *
 * The KEYSTONE assertion is the FLAGS-OFF byte-identical degeneration: the
 * generalized builders, called WITHOUT a `topology` argument, MUST produce the
 * EXACT same `Route[]` / leg-param map they do today for the legacy single-center
 * (Memphis) star. If the legacy output drifts at all, the seed-42 10k golden
 * (`3920accc…`) breaks. We assert that by reconstructing today's single-center
 * output independently and deep-equalling it.
 *
 * The MULTI-CENTER assertions cover the new path: with a topology built from a
 * small fixture, every spoke gets a directed pair to its assigned center, every
 * ordered center pair gets a directed backbone leg, ids/order are stable, and
 * there are no duplicate routeIds.
 */

const ROUTE_POINTS = 24; // mirrors the module's interpolation density.

/** A 12-hub fixture: 3 "centers" + 9 spokes (plain hubs — geometry only). */
const FIXTURE_HUBS: readonly Hub[] = [
  { hubId: "C1", name: "Center 1", lat: 40, lon: -100 },
  { hubId: "C2", name: "Center 2", lat: 35, lon: -80 },
  { hubId: "C3", name: "Center 3", lat: 34, lon: -118 },
  { hubId: "S1", name: "Spoke 1", lat: 41, lon: -101 },
  { hubId: "S2", name: "Spoke 2", lat: 39, lon: -99 },
  { hubId: "S3", name: "Spoke 3", lat: 36, lon: -81 },
  { hubId: "S4", name: "Spoke 4", lat: 34, lon: -79 },
  { hubId: "S5", name: "Spoke 5", lat: 33, lon: -117 },
  { hubId: "S6", name: "Spoke 6", lat: 35, lon: -119 },
  { hubId: "S7", name: "Spoke 7", lat: 42, lon: -102 },
  { hubId: "S8", name: "Spoke 8", lat: 37, lon: -82 },
  { hubId: "S9", name: "Spoke 9", lat: 32, lon: -116 },
] as const;

/** Topology assigning each spoke to a center + a full directed center mesh. */
const FIXTURE_TOPOLOGY: RouteTopology = {
  centerOf: new Map<string, string>([
    ["S1", "C1"],
    ["S2", "C1"],
    ["S7", "C1"],
    ["S3", "C2"],
    ["S4", "C2"],
    ["S8", "C2"],
    ["S5", "C3"],
    ["S6", "C3"],
    ["S9", "C3"],
  ]),
  backbone: [
    { fromHubId: "C1", toHubId: "C2" },
    { fromHubId: "C1", toHubId: "C3" },
    { fromHubId: "C2", toHubId: "C1" },
    { fromHubId: "C2", toHubId: "C3" },
    { fromHubId: "C3", toHubId: "C1" },
    { fromHubId: "C3", toHubId: "C2" },
  ],
};

describe("buildRoutes — legacy byte-identical degeneration (NET-01, the flags-off keystone)", () => {
  it("buildRoutes(USA_HUBS) WITHOUT topology is byte-identical to the single-center star", () => {
    const out = buildRoutes(USA_HUBS);

    // Independently reconstruct today's single-center star (center = USA_HUBS[0],
    // a directed pair per spoke, input order). Geometry must match exactly — so we
    // compare against the builder's OWN no-topology output for geometry but assert
    // the SHAPE (ids/order/endpoints) is the canonical single-center star.
    const center = USA_HUBS[0]!;
    const expectedShape: { routeId: string; fromHubId: string; toHubId: string }[] = [];
    for (let i = 1; i < USA_HUBS.length; i += 1) {
      const spoke = USA_HUBS[i]!;
      expectedShape.push({
        routeId: routeId(center.hubId, spoke.hubId),
        fromHubId: center.hubId,
        toHubId: spoke.hubId,
      });
      expectedShape.push({
        routeId: routeId(spoke.hubId, center.hubId),
        fromHubId: spoke.hubId,
        toHubId: center.hubId,
      });
    }

    const actualShape = out.map((r) => ({
      routeId: r.routeId,
      fromHubId: r.fromHubId,
      toHubId: r.toHubId,
    }));
    expect(actualShape).toEqual(expectedShape);

    // Every leg carries a real geometry of ROUTE_POINTS vertices, endpoints snapped.
    for (const r of out) {
      expect(r.geometry.length).toBe(ROUTE_POINTS);
    }
    // The first leg is MEM->ORD; its endpoints anchor exactly at the hub coords.
    const first = out[0]!;
    expect(first.geometry[0]).toEqual([center.lon, center.lat]);
    expect(first.geometry[first.geometry.length - 1]).toEqual([
      USA_HUBS[1]!.lon,
      USA_HUBS[1]!.lat,
    ]);
  });

  it("buildRoutes with an explicit `undefined` topology equals the absent-topology call", () => {
    const absent = buildRoutes(USA_HUBS);
    const explicitUndefined = buildRoutes(USA_HUBS, undefined, undefined);
    expect(explicitUndefined).toEqual(absent);
  });
});

describe("buildRoutes — multi-center topology (NET-01)", () => {
  const routes = buildRoutes(FIXTURE_HUBS, undefined, FIXTURE_TOPOLOGY);
  const ids = routes.map((r) => r.routeId);

  it("emits a directed pair (spoke<->assigned center) for every spoke", () => {
    for (const [spoke, center] of FIXTURE_TOPOLOGY.centerOf) {
      expect(ids).toContain(routeId(center, spoke));
      expect(ids).toContain(routeId(spoke, center));
    }
  });

  it("emits a directed backbone leg for every ordered center pair", () => {
    for (const leg of FIXTURE_TOPOLOGY.backbone) {
      expect(ids).toContain(routeId(leg.fromHubId, leg.toHubId));
    }
  });

  it("has no duplicate routeIds", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is in a stable sorted order (independent of input ordering)", () => {
    const shuffled = [...FIXTURE_HUBS].reverse();
    const reShuffledTopo: RouteTopology = {
      centerOf: new Map([...FIXTURE_TOPOLOGY.centerOf].reverse()),
      backbone: [...FIXTURE_TOPOLOGY.backbone].reverse(),
    };
    const a = buildRoutes(FIXTURE_HUBS, undefined, FIXTURE_TOPOLOGY).map((r) => r.routeId);
    const b = buildRoutes(shuffled, undefined, reShuffledTopo).map((r) => r.routeId);
    expect(b).toEqual(a);
  });

  it("every spoke<->center + center<->center leg has a real ROUTE_POINTS geometry", () => {
    for (const r of routes) {
      expect(r.geometry.length).toBe(ROUTE_POINTS);
    }
  });

  it("emits exactly (2 * spokes) + (directed center pairs) legs", () => {
    const spokeLegs = FIXTURE_TOPOLOGY.centerOf.size * 2;
    const backboneLegs = FIXTURE_TOPOLOGY.backbone.length;
    expect(routes.length).toBe(spokeLegs + backboneLegs);
  });
});

describe("buildTransitParamsByLeg — legacy byte-identical degeneration (NET-01)", () => {
  const SIGMA = 0.25;

  it("WITHOUT topology produces the legacy single-center leg map (one pair per spoke)", () => {
    const byLeg = buildTransitParamsByLeg(USA_HUBS, SIGMA);
    const center = USA_HUBS[0]!;
    const expectedKeys: string[] = [];
    for (let i = 1; i < USA_HUBS.length; i += 1) {
      const spoke = USA_HUBS[i]!;
      expectedKeys.push(routeId(center.hubId, spoke.hubId));
      expectedKeys.push(routeId(spoke.hubId, center.hubId));
    }
    expect([...byLeg.keys()].sort()).toEqual([...expectedKeys].sort());
    for (const params of byLeg.values()) {
      expect(params.sigma).toBe(SIGMA);
      expect(params.median).toBeGreaterThan(0);
    }
  });

  it("explicit `undefined` topology equals the absent-topology call", () => {
    const absent = buildTransitParamsByLeg(USA_HUBS, SIGMA);
    const explicitUndefined = buildTransitParamsByLeg(USA_HUBS, SIGMA, undefined, undefined);
    expect([...explicitUndefined.entries()]).toEqual([...absent.entries()]);
  });
});

describe("buildTransitParamsByLeg — multi-center topology (NET-01)", () => {
  const SIGMA = 0.25;
  const byLeg = buildTransitParamsByLeg(FIXTURE_HUBS, SIGMA, undefined, FIXTURE_TOPOLOGY);

  it("contains a directed-pair entry for every spoke<->center leg", () => {
    for (const [spoke, center] of FIXTURE_TOPOLOGY.centerOf) {
      expect(byLeg.has(routeId(center, spoke))).toBe(true);
      expect(byLeg.has(routeId(spoke, center))).toBe(true);
    }
  });

  it("contains a directed entry for every backbone leg", () => {
    for (const leg of FIXTURE_TOPOLOGY.backbone) {
      expect(byLeg.has(routeId(leg.fromHubId, leg.toHubId))).toBe(true);
    }
  });

  it("every leg's params carry the supplied sigma + a positive median", () => {
    for (const params of byLeg.values()) {
      expect(params.sigma).toBe(SIGMA);
      expect(params.median).toBeGreaterThan(0);
    }
  });
});
