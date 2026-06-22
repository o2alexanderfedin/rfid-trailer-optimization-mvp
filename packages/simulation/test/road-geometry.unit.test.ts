import { describe, expect, it } from "vitest";
import type { Hub } from "@mm/domain";
import {
  applyRoadGeometry,
  buildRoutes,
  greatCircle,
  hubCoordsChecksum,
  loadStaticRoadGeometry,
  routeId,
  type RoadGeometryFile,
} from "../src/network/routes.js";
import { USA_HUBS } from "../src/network/hubs.js";

/**
 * VIZ-06 — LOADABLE road-following route geometry with a great-circle FALLBACK.
 *
 * A committed static GeoJSON file (`road-geometry.generated.json`) carries a
 * road-snapped LineString per directed leg (precomputed OFFLINE from ORS — never
 * at sim/plan runtime). This file is now COMMITTED, so it is the DEFAULT source
 * of truth: `buildRoutes(USA_HUBS)` returns the real-road polylines. When the
 * file (or a given leg) is ABSENT the deterministic `greatCircle` arc is used
 * (back-compat fallback), so every downstream consumer (ws protocol, OpenLayers
 * animation) is shape-agnostic.
 *
 * The great-circle FALLBACK is proven here via the INJECTED in-memory geometry
 * source (a fixture stub) and the absent-file path of `applyRoadGeometry` — no
 * file read, no network — so both the prefer-static DEFAULT and the fallback are
 * provable in isolation.
 */

const ROUTE_POINTS = 24; // mirrors routes.ts ROUTE_POINTS (smooth map arcs)

describe("loadStaticRoadGeometry (the committed file is the DEFAULT source)", () => {
  it("loads the committed road-geometry file with USA-hub legs and a checksum", () => {
    // RE-BASELINE (VIZ-06): the real ORS `road-geometry.generated.json` is now
    // COMMITTED, so the static loader resolves to the file (not `undefined`). It
    // carries a `hubChecksum` string and the directed USA-hub legs.
    const file = loadStaticRoadGeometry();
    expect(file).toBeDefined();
    expect(typeof file!.hubChecksum).toBe("string");
    expect(file!.hubChecksum.length).toBeGreaterThan(0);
    // A known directed leg (Memphis center → a spoke) is present with geometry.
    const leg = file!.legs[routeId("MEM", "ORD")];
    expect(leg).toBeDefined();
    expect(leg!.geometry.length).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic — same file object shape across reads (static, no I/O drift)", () => {
    expect(loadStaticRoadGeometry()).toEqual(loadStaticRoadGeometry());
  });

  it("the committed file's hubChecksum matches the current USA_HUBS (no stale geometry)", () => {
    // Drift guard: the committed road geometry was precomputed against USA_HUBS.
    // If a hub coordinate moves, this fails — signalling the geometry must be
    // regenerated (else trailers would animate along roads for the OLD hub set).
    expect(loadStaticRoadGeometry()!.hubChecksum).toBe(hubCoordsChecksum(USA_HUBS));
  });
});

describe("buildRoutes DEFAULT uses the committed ORS road geometry (VIZ-06)", () => {
  it("returns the static road line (NOT the great-circle arc) for the present legs", () => {
    // RE-BASELINE (VIZ-06): the committed file is now the default source, so the
    // DEFAULT `buildRoutes(USA_HUBS)` returns real-road polylines for legs that
    // are in the file — distinct from the pure great-circle arc.
    const file = loadStaticRoadGeometry()!;
    const routes = buildRoutes(USA_HUBS);
    const center = USA_HUBS[0]!;
    for (let i = 1; i < USA_HUBS.length; i += 1) {
      const spoke = USA_HUBS[i]!;
      const out = routes.find((r) => r.routeId === routeId(center.hubId, spoke.hubId))!;
      // Endpoints are always snapped EXACTLY to the hub coordinates (seam anchor).
      expect(out.geometry[0]).toEqual([center.lon, center.lat]);
      expect(out.geometry[out.geometry.length - 1]).toEqual([spoke.lon, spoke.lat]);
      // When the leg is in the committed file, the drawn geometry is the road
      // polyline, NOT the great-circle arc the absent-file fallback would yield.
      const fileLeg = file.legs[routeId(center.hubId, spoke.hubId)];
      if (fileLeg !== undefined && fileLeg.geometry.length >= 2) {
        expect(out.geometry).not.toEqual(
          greatCircle([center.lon, center.lat], [spoke.lon, spoke.lat], ROUTE_POINTS),
        );
      }
    }
  });

  it("is deterministic — identical routes across calls (static committed file)", () => {
    expect(buildRoutes(USA_HUBS)).toEqual(buildRoutes(USA_HUBS));
  });

  it("falls back to the great-circle arc when NO file is injected and none on disk", () => {
    // The great-circle FALLBACK (back-compat) is exercised via the pure
    // `applyRoadGeometry` absent-file path: passing `undefined` yields the exact
    // great-circle arc, byte-identical to v1.0. (The DEFAULT `buildRoutes` reads
    // the committed file; the fallback is what runs when that file is absent.)
    const center = USA_HUBS[0]!;
    const spoke = USA_HUBS[1]!;
    expect(applyRoadGeometry(undefined, center, spoke, ROUTE_POINTS)).toEqual(
      greatCircle([center.lon, center.lat], [spoke.lon, spoke.lat], ROUTE_POINTS),
    );
  });
});

describe("buildRoutes PREFERS injected static geometry when present", () => {
  // A minimal two-hub network so the fixture is tiny and explicit.
  const A: Hub = { hubId: "A", name: "Alpha", lat: 35, lon: -90 };
  const B: Hub = { hubId: "B", name: "Bravo", lat: 40, lon: -100 };
  const hubs: readonly Hub[] = [A, B];

  // A deliberately NON-great-circle "road" line for the A→B leg (an inland
  // dogleg). Endpoints are NOT pre-snapped — the loader must snap them to the
  // hub coordinates exactly.
  const fixture: RoadGeometryFile = {
    hubChecksum: hubCoordsChecksum(hubs),
    legs: {
      [routeId("A", "B")]: {
        geometry: [
          [-89.9, 35.1], // off the hub on purpose -> must be snapped to A
          [-95, 38],
          [-97, 39.5],
          [-99.8, 39.9], // off the hub on purpose -> must be snapped to B
        ],
        distance_m: 1_234_000,
        duration_s: 54_000,
      },
      // The B→A leg is intentionally OMITTED -> it must fall back to greatCircle.
    },
  };

  it("uses the static road line for the present leg, snapping endpoints to hubs", () => {
    const routes = buildRoutes(hubs, fixture);
    const ab = routes.find((r) => r.routeId === routeId("A", "B"))!;

    // The interior road vertices are preserved (NOT a great-circle arc)…
    expect(ab.geometry.length).toBe(4);
    expect(ab.geometry[1]).toEqual([-95, 38]);
    expect(ab.geometry[2]).toEqual([-97, 39.5]);
    // …and the endpoints snap EXACTLY to the hub coords (seam stays anchored).
    expect(ab.geometry[0]).toEqual([A.lon, A.lat]);
    expect(ab.geometry[ab.geometry.length - 1]).toEqual([B.lon, B.lat]);

    // It is NOT the great-circle line (the static road wins).
    expect(ab.geometry).not.toEqual(
      greatCircle([A.lon, A.lat], [B.lon, B.lat], ROUTE_POINTS),
    );
  });

  it("falls back to great-circle for a leg ABSENT from the file", () => {
    const routes = buildRoutes(hubs, fixture);
    const ba = routes.find((r) => r.routeId === routeId("B", "A"))!;
    expect(ba.geometry).toEqual(
      greatCircle([B.lon, B.lat], [A.lon, A.lat], ROUTE_POINTS),
    );
  });
});

describe("applyRoadGeometry (pure leg selection)", () => {
  const A: Hub = { hubId: "A", name: "Alpha", lat: 35, lon: -90 };
  const B: Hub = { hubId: "B", name: "Bravo", lat: 40, lon: -100 };

  it("returns a hub-anchored copy of a present leg's road line", () => {
    const file: RoadGeometryFile = {
      hubChecksum: "x",
      legs: { [routeId("A", "B")]: { geometry: [[-1, -1], [-95, 38], [-2, -2]] } },
    };
    const geom = applyRoadGeometry(file, A, B, ROUTE_POINTS);
    expect(geom[0]).toEqual([A.lon, A.lat]);
    expect(geom[geom.length - 1]).toEqual([B.lon, B.lat]);
    expect(geom[1]).toEqual([-95, 38]);
  });

  it("returns the great-circle arc when the file or the leg is absent", () => {
    const expected = greatCircle([A.lon, A.lat], [B.lon, B.lat], ROUTE_POINTS);
    expect(applyRoadGeometry(undefined, A, B, ROUTE_POINTS)).toEqual(expected);
    expect(applyRoadGeometry({ hubChecksum: "x", legs: {} }, A, B, ROUTE_POINTS)).toEqual(
      expected,
    );
  });

  it("falls back to great-circle for a degenerate leg (fewer than 2 vertices)", () => {
    const file: RoadGeometryFile = {
      hubChecksum: "x",
      legs: { [routeId("A", "B")]: { geometry: [[-90, 35]] } },
    };
    expect(applyRoadGeometry(file, A, B, ROUTE_POINTS)).toEqual(
      greatCircle([A.lon, A.lat], [B.lon, B.lat], ROUTE_POINTS),
    );
  });
});

describe("hubCoordsChecksum (drift detection)", () => {
  it("is stable for the same hub coords and pure (same input ⇒ same output)", () => {
    expect(hubCoordsChecksum(USA_HUBS)).toBe(hubCoordsChecksum(USA_HUBS));
  });

  it("changes when a hub coordinate moves (geometry would be stale)", () => {
    const moved = USA_HUBS.map((h, i) =>
      i === 1 ? { ...h, lat: h.lat + 0.5 } : h,
    );
    expect(hubCoordsChecksum(moved)).not.toBe(hubCoordsChecksum(USA_HUBS));
  });
});
