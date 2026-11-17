/**
 * layers.ts tests (NODE unit lane).
 *
 * Mirrors the `vi.mock("ol/...")` approach used by animate.test.ts and
 * coloring.test.ts: every OL class that `layers.ts` (and its transitive
 * `coloring.ts` import) touches is replaced with a small in-memory mock so the
 * tests run in the Node vitest environment (no browser / canvas).
 *
 * Coverage targets (layers.ts):
 *  - createHubLayer / createRouteLayer / createTrailerLayer (feature + geometry
 *    construction, fromLonLat projection, feature ids, default buckets).
 *  - updateTrailerFeatures (legacy in-place geom update + create path).
 *  - upsertTrailerKeyframe (getFeatureById upsert path + create path + util).
 *  - removeTrailerFeature (found + not-found).
 *  - applyHubBuckets / applyRouteBuckets (feature.set bucket calls + missing id).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HubDto, RouteDto } from "../api/client.js";
import type { HubState, RouteState, TrailerKeyframe } from "@mm/api";
import type { TrailerSnapshot } from "./useTrailerSnapshots.js";

// ---------------------------------------------------------------------------
// Mock OL modules BEFORE importing the module under test.
//
// Class definitions live INSIDE each factory (like coloring.test.ts) to dodge
// the vi.mock hoisting TDZ trap. The shared `fromLonLat` spy is created with
// vi.hoisted so it is initialized before the (hoisted) vi.mock factories run.
// ---------------------------------------------------------------------------

interface MockPoint {
  coords: number[];
  setCoordinates(c: number[]): void;
  getCoordinates(): number[];
}
interface MockLineString {
  coords: number[][];
  getCoordinates(): number[][];
}
interface MockFeature {
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  setId(id: string | number): void;
  getId(): string | number | undefined;
  getGeometry(): unknown;
}
interface MockVectorSource {
  opts: unknown;
  features: MockFeature[];
  addFeature(f: MockFeature): void;
  removeFeature(f: MockFeature): void;
  getFeatureById(id: string | number): MockFeature | null;
}
interface MockVectorLayer {
  opts: { source?: unknown; style?: unknown };
}

/**
 * fromLonLat spy: tag-transform [lon, lat] → [lon * 10, lat * 10] so tests can
 * assert (a) that it was called and (b) the lon/lat order survives unchanged.
 * Hoisted so the (also-hoisted) `ol/proj.js` factory can close over it.
 */
const { fromLonLat } = vi.hoisted(() => ({
  fromLonLat: vi.fn((coord: number[]): number[] => [
    (coord[0] ?? 0) * 10,
    (coord[1] ?? 0) * 10,
  ]),
}));

vi.mock("ol/geom/Point.js", () => {
  class P {
    coords: number[];
    constructor(coords: number[]) {
      this.coords = [...coords];
    }
    setCoordinates(c: number[]): void {
      this.coords = [...c];
    }
    getCoordinates(): number[] {
      return [...this.coords];
    }
  }
  return { default: P };
});

vi.mock("ol/geom/LineString.js", () => {
  class L {
    coords: number[][];
    constructor(coords: number[][]) {
      this.coords = coords.map((c) => [...c]);
    }
    getCoordinates(): number[][] {
      return this.coords.map((c) => [...c]);
    }
  }
  return { default: L };
});

vi.mock("ol/Feature.js", () => {
  class F {
    private props: Record<string, unknown>;
    private id: string | number | undefined;
    constructor(props?: Record<string, unknown>) {
      this.props = { ...(props ?? {}) };
    }
    set(key: string, value: unknown): void {
      this.props[key] = value;
    }
    get(key: string): unknown {
      return this.props[key];
    }
    setId(id: string | number): void {
      this.id = id;
    }
    getId(): string | number | undefined {
      return this.id;
    }
    getGeometry(): unknown {
      return this.props["geometry"];
    }
  }
  return { default: F };
});

vi.mock("ol/source/Vector.js", () => {
  class S {
    readonly opts: unknown;
    readonly features: MockFeature[] = [];
    private readonly byId = new Map<string | number, MockFeature>();
    constructor(opts?: unknown) {
      this.opts = opts;
    }
    addFeature(f: MockFeature): void {
      this.features.push(f);
      const id = f.getId();
      if (id !== undefined) this.byId.set(id, f);
    }
    removeFeature(f: MockFeature): void {
      const idx = this.features.indexOf(f);
      if (idx >= 0) this.features.splice(idx, 1);
      const id = f.getId();
      if (id !== undefined) this.byId.delete(id);
    }
    getFeatureById(id: string | number): MockFeature | null {
      return this.byId.get(id) ?? null;
    }
  }
  return { default: S };
});

vi.mock("ol/layer/Vector.js", () => {
  class V {
    readonly opts: { source?: unknown; style?: unknown };
    constructor(opts: { source?: unknown; style?: unknown }) {
      this.opts = opts;
    }
  }
  return { default: V };
});

vi.mock("ol/layer/VectorImage.js", () => {
  class VI {
    readonly opts: { source?: unknown; style?: unknown; declutter?: boolean };
    constructor(opts: { source?: unknown; style?: unknown; declutter?: boolean }) {
      this.opts = opts;
    }
  }
  return { default: VI };
});

vi.mock("ol/source/Cluster.js", () => {
  class C {
    readonly opts: { distance?: number; minDistance?: number; source?: unknown };
    constructor(opts: { distance?: number; minDistance?: number; source?: unknown }) {
      this.opts = opts;
    }
  }
  return { default: C };
});

vi.mock("ol/proj.js", () => ({ fromLonLat }));

/**
 * coloring.ts imports `ol/style.js`; stub the style ctors so importing the real
 * coloring module (used as the layer `style` fn) doesn't need a canvas.
 */
vi.mock("ol/style.js", () => {
  class C {
    constructor(readonly opts?: unknown) {}
  }
  return { Style: C, Fill: C, Stroke: C, Circle: C, Text: C };
});

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered).
// ---------------------------------------------------------------------------
import {
  createHubLayer,
  createRouteLayer,
  createTrailerLayer,
  updateTrailerFeatures,
  upsertTrailerKeyframe,
  removeTrailerFeature,
  applyHubBuckets,
  applyRouteBuckets,
  type HubLayers,
} from "./layers.js";
import { hubStyleTiered, routeStyleTiered, trailerStyle } from "./coloring.js";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function hub(hubId: string, lon: number, lat: number, name = hubId, kind: HubDto["kind"] = "spoke"): HubDto {
  return { hubId, name, lon, lat, kind, tier: kind === "center" ? 1 : 2 };
}

function route(
  routeId: string,
  geometry: ReadonlyArray<readonly [number, number]>,
  isBackbone = false,
): RouteDto {
  return {
    routeId,
    fromHubId: "A",
    toHubId: "B",
    geometry: geometry as RouteDto["geometry"],
    isBackbone,
  };
}

function keyframe(over: Partial<TrailerKeyframe> = {}): TrailerKeyframe {
  return {
    id: "T-1",
    routeId: "MEM-ORD",
    departMs: 1000,
    etaMs: 2000,
    state: "onTime",
    ...over,
  };
}

beforeEach(() => {
  fromLonLat.mockClear();
});

// Narrow the opaque Layer.source back to the mock so tests can introspect it.
function asSource(source: unknown): MockVectorSource {
  return source as MockVectorSource;
}

interface MockVectorImageLayer {
  opts: { source?: unknown; style?: unknown; declutter?: boolean };
}
interface MockClusterSource {
  opts: { distance?: number; minDistance?: number; source?: unknown };
}

// ---------------------------------------------------------------------------
// createHubLayer (VIZ-15/16 — split center/spoke layers)
// ---------------------------------------------------------------------------

describe("createHubLayer", () => {
  it("returns unified source with all hub features (center + spoke) keyed hub:<id>", () => {
    const layers: HubLayers = createHubLayer([
      hub("MEM", -90, 35, "Memphis", "center"),
      hub("ORD", -87, 41, "Chicago"),
    ]);
    const src = asSource(layers.source);
    expect(src.features.length).toBe(2);
    expect(src.getFeatureById("hub:MEM")).not.toBeNull();
    expect(src.getFeatureById("hub:ORD")).not.toBeNull();
  });

  it("center hubs go into centerSource, spoke hubs into spokeSource", () => {
    const layers: HubLayers = createHubLayer([
      hub("DFW", -97, 32, "Dallas", "center"),
      hub("LAX", -118, 33, "LA", "spoke"),
    ]);
    expect(asSource(layers.centerSource).getFeatureById("hub:DFW")).not.toBeNull();
    expect(asSource(layers.centerSource).getFeatureById("hub:LAX")).toBeNull();
    expect(asSource(layers.spokeSource).getFeatureById("hub:LAX")).not.toBeNull();
    expect(asSource(layers.spokeSource).getFeatureById("hub:DFW")).toBeNull();
  });

  it("projects [lon, lat] through fromLonLat into the Point geometry", () => {
    const layers: HubLayers = createHubLayer([hub("MEM", -90, 35)]);
    expect(fromLonLat).toHaveBeenCalledWith([-90, 35]);
    const f = asSource(layers.source).getFeatureById("hub:MEM");
    const geom = f?.getGeometry() as MockPoint;
    expect(geom.getCoordinates()).toEqual([-900, 350]);
  });

  it("stores hub metadata + default metric buckets (0) on the unified source feature", () => {
    const layers: HubLayers = createHubLayer([hub("MEM", -90, 35, "Memphis")]);
    const f = asSource(layers.source).getFeatureById("hub:MEM");
    expect(f?.get("hubId")).toBe("MEM");
    expect(f?.get("name")).toBe("Memphis");
    expect(f?.get("volumeBucket")).toBe(0);
    expect(f?.get("slaRiskBucket")).toBe(0);
    expect(f?.get("congestionBucket")).toBe(0);
  });

  it("centerLayer uses hubStyleTiered", () => {
    const layers: HubLayers = createHubLayer([]);
    const olLayer = layers.centerLayer as unknown as MockVectorLayer;
    expect(olLayer.opts.style).toBe(hubStyleTiered);
  });

  it("spokeLayer is a VectorImageLayer with declutter=true", () => {
    const layers: HubLayers = createHubLayer([]);
    const olLayer = layers.spokeLayer as unknown as MockVectorImageLayer;
    expect(olLayer.opts.declutter).toBe(true);
  });

  it("spoke cluster source has distance=40 and minDistance=20 (UI-SPEC)", () => {
    const layers: HubLayers = createHubLayer([hub("LAX", -118, 33)]);
    const spokeLayer = layers.spokeLayer as unknown as MockVectorImageLayer;
    const clusterSrc = spokeLayer.opts.source as MockClusterSource;
    expect(clusterSrc.opts.distance).toBe(40);
    expect(clusterSrc.opts.minDistance).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// createRouteLayer
// ---------------------------------------------------------------------------

describe("createRouteLayer", () => {
  it("creates one LineString feature per route with id `route:<id>`", () => {
    const { source } = createRouteLayer([
      route("R1", [
        [-90, 35],
        [-87, 41],
      ]),
    ]);
    const f = asSource(source).getFeatureById("route:R1");
    expect(f).not.toBeNull();
    expect(f?.get("routeId")).toBe("R1");
    expect(f?.get("loadBucket")).toBe(0);
    expect(f?.get("slaRiskBucket")).toBe(0);
  });

  it("projects every vertex through fromLonLat into the LineString geom", () => {
    const { source } = createRouteLayer([
      route("R1", [
        [-90, 35],
        [-87, 41],
      ]),
    ]);
    expect(fromLonLat).toHaveBeenCalledTimes(2);
    expect(fromLonLat).toHaveBeenNthCalledWith(1, [-90, 35]);
    expect(fromLonLat).toHaveBeenNthCalledWith(2, [-87, 41]);
    const geom = asSource(source).getFeatureById("route:R1")?.getGeometry() as MockLineString;
    // each [lon, lat] * 10, order preserved per vertex.
    expect(geom.getCoordinates()).toEqual([
      [-900, 350],
      [-870, 410],
    ]);
  });

  it("creates a VectorSource with useSpatialIndex and a layer styled by routeStyleTiered", () => {
    const { layer, source } = createRouteLayer([]);
    expect(asSource(source).opts).toEqual({ useSpatialIndex: true });
    const olLayer = layer as unknown as MockVectorLayer;
    expect(olLayer.opts.source).toBe(source);
    expect(olLayer.opts.style).toBe(routeStyleTiered);
  });

  it("stores isBackbone on the route feature (VIZ-16)", () => {
    const { source } = createRouteLayer([route("R1", [[-90, 35], [-87, 41]], true)]);
    const f = asSource(source).getFeatureById("route:R1");
    expect(f?.get("isBackbone")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createTrailerLayer
// ---------------------------------------------------------------------------

describe("createTrailerLayer", () => {
  it("creates an empty source styled by trailerStyle", () => {
    const { layer, source } = createTrailerLayer();
    const src = asSource(source);
    expect(src.opts).toEqual({ useSpatialIndex: true });
    expect(src.features.length).toBe(0);
    const olLayer = layer as unknown as MockVectorLayer;
    expect(olLayer.opts.source).toBe(source);
    expect(olLayer.opts.style).toBe(trailerStyle);
  });
});

// ---------------------------------------------------------------------------
// updateTrailerFeatures (legacy absolute-position path)
// ---------------------------------------------------------------------------

function snapshot(over: Partial<TrailerSnapshot> = {}): TrailerSnapshot {
  return {
    trailerId: "T-1",
    tripId: "trip-1",
    kind: "linehaul",
    lon: -90,
    lat: 35,
    t: "2026-06-20T00:00:00Z",
    ...over,
  };
}

describe("updateTrailerFeatures", () => {
  it("creates a new trailer Point feature with id `trailer:<id>`", () => {
    const { source } = createTrailerLayer();
    updateTrailerFeatures(source, [snapshot()]);
    const src = asSource(source);
    const f = src.getFeatureById("trailer:T-1");
    expect(f).not.toBeNull();
    expect(f?.get("trailerId")).toBe("T-1");
    expect(f?.get("tripId")).toBe("trip-1");
    const geom = f?.getGeometry() as MockPoint;
    expect(geom.getCoordinates()).toEqual([-900, 350]);
  });

  it("updates an existing trailer's Point coordinates IN PLACE (no new feature)", () => {
    const { source } = createTrailerLayer();
    updateTrailerFeatures(source, [snapshot()]);
    const src = asSource(source);
    const before = src.getFeatureById("trailer:T-1");
    updateTrailerFeatures(source, [snapshot({ lon: 0, lat: 0 })]);
    const after = src.getFeatureById("trailer:T-1");
    expect(after).toBe(before); // same feature reference reused
    expect(src.features.length).toBe(1);
    const geom = after?.getGeometry() as MockPoint;
    expect(geom.getCoordinates()).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// upsertTrailerKeyframe
// ---------------------------------------------------------------------------

describe("upsertTrailerKeyframe", () => {
  it("creates a placeholder Point feature at origin for a new trailer", () => {
    const { source } = createTrailerLayer();
    upsertTrailerKeyframe(source, keyframe());
    const f = asSource(source).getFeatureById("trailer:T-1");
    expect(f).not.toBeNull();
    expect(f?.get("trailerId")).toBe("T-1");
    expect(f?.get("routeId")).toBe("MEM-ORD");
    expect(f?.get("departMs")).toBe(1000);
    expect(f?.get("etaMs")).toBe(2000);
    expect(f?.get("state")).toBe("onTime");
    const geom = f?.getGeometry() as MockPoint;
    expect(geom.getCoordinates()).toEqual([0, 0]);
  });

  it("sets util on a new feature only when provided", () => {
    const { source } = createTrailerLayer();
    upsertTrailerKeyframe(source, keyframe({ id: "T-A", util: 0.7 }));
    upsertTrailerKeyframe(source, keyframe({ id: "T-B" }));
    const src = asSource(source);
    expect(src.getFeatureById("trailer:T-A")?.get("util")).toBe(0.7);
    expect(src.getFeatureById("trailer:T-B")?.get("util")).toBeUndefined();
  });

  it("updates an existing feature IN PLACE via the getFeatureById path", () => {
    const { source } = createTrailerLayer();
    upsertTrailerKeyframe(source, keyframe());
    const src = asSource(source);
    const before = src.getFeatureById("trailer:T-1");
    upsertTrailerKeyframe(
      source,
      keyframe({ routeId: "ORD-MEM", departMs: 5000, etaMs: 9000, state: "late", util: 0.9 }),
    );
    const after = src.getFeatureById("trailer:T-1");
    expect(after).toBe(before); // reused — no new feature
    expect(src.features.length).toBe(1);
    expect(after?.get("routeId")).toBe("ORD-MEM");
    expect(after?.get("departMs")).toBe(5000);
    expect(after?.get("etaMs")).toBe(9000);
    expect(after?.get("state")).toBe("late");
    expect(after?.get("util")).toBe(0.9);
  });

  it("does not overwrite util on update when the keyframe omits it", () => {
    const { source } = createTrailerLayer();
    upsertTrailerKeyframe(source, keyframe({ util: 0.5 }));
    upsertTrailerKeyframe(source, keyframe({ state: "slaRisk" }));
    const f = asSource(source).getFeatureById("trailer:T-1");
    expect(f?.get("state")).toBe("slaRisk");
    expect(f?.get("util")).toBe(0.5); // unchanged — omitted util left intact
  });
});

// ---------------------------------------------------------------------------
// removeTrailerFeature
// ---------------------------------------------------------------------------

describe("removeTrailerFeature", () => {
  it("removes the matching trailer feature from the source", () => {
    const { source } = createTrailerLayer();
    upsertTrailerKeyframe(source, keyframe());
    const src = asSource(source);
    expect(src.features.length).toBe(1);
    removeTrailerFeature(source, "T-1");
    expect(src.features.length).toBe(0);
    expect(src.getFeatureById("trailer:T-1")).toBeNull();
  });

  it("is a no-op when the trailer id is not present", () => {
    const { source } = createTrailerLayer();
    upsertTrailerKeyframe(source, keyframe());
    const src = asSource(source);
    removeTrailerFeature(source, "DOES-NOT-EXIST");
    expect(src.features.length).toBe(1); // untouched
  });
});

// ---------------------------------------------------------------------------
// applyHubBuckets
// ---------------------------------------------------------------------------

function hubState(over: Partial<HubState> = {}): HubState {
  return { id: "MEM", volumeBucket: 0, slaRiskBucket: 0, congestionBucket: 0, ...over };
}

describe("applyHubBuckets", () => {
  it("sets the three metric buckets on the matching hub feature", () => {
    const { source } = createHubLayer([hub("MEM", -90, 35)]);
    applyHubBuckets(source, [
      hubState({ volumeBucket: 3, slaRiskBucket: 2, congestionBucket: 1 }),
    ]);
    const f = asSource(source).getFeatureById("hub:MEM");
    expect(f?.get("volumeBucket")).toBe(3);
    expect(f?.get("slaRiskBucket")).toBe(2);
    expect(f?.get("congestionBucket")).toBe(1);
  });

  it("skips hub ids that have no feature (continue branch)", () => {
    const { source } = createHubLayer([hub("MEM", -90, 35)]);
    expect(() =>
      applyHubBuckets(source, [hubState({ id: "GHOST", volumeBucket: 9 })]),
    ).not.toThrow();
    // The real hub remains at its default bucket.
    const f = asSource(source).getFeatureById("hub:MEM");
    expect(f?.get("volumeBucket")).toBe(0);
  });

  // VIZ-11: derive + set the driver-duty bucket from the ws driver buckets.
  it("derives a dutyBucket from the driver buckets (all resting → all-out bucket 3)", () => {
    const { source } = createHubLayer([hub("MEM", -90, 35)]);
    applyHubBuckets(source, [
      hubState({ driverCount: 2, onBreakCount: 0, restingCount: 2 }),
    ]);
    const f = asSource(source).getFeatureById("hub:MEM");
    expect(f?.get("dutyBucket")).toBe(3);
  });

  it("sets dutyBucket 0 when drivers are present and all available", () => {
    const { source } = createHubLayer([hub("MEM", -90, 35)]);
    applyHubBuckets(source, [
      hubState({ driverCount: 3, onBreakCount: 0, restingCount: 0 }),
    ]);
    const f = asSource(source).getFeatureById("hub:MEM");
    expect(f?.get("dutyBucket")).toBe(0);
  });

  it("clears dutyBucket (undefined) when a hub has no driver data (falls back to volume)", () => {
    const { source } = createHubLayer([hub("MEM", -90, 35)]);
    // First set a duty bucket, then send a payload with no driver data.
    applyHubBuckets(source, [hubState({ driverCount: 1, restingCount: 1 })]);
    applyHubBuckets(source, [hubState({ volumeBucket: 2 })]);
    const f = asSource(source).getFeatureById("hub:MEM");
    expect(f?.get("dutyBucket")).toBeUndefined();
    expect(f?.get("volumeBucket")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applyRouteBuckets
// ---------------------------------------------------------------------------

function routeState(over: Partial<RouteState> = {}): RouteState {
  return { id: "R1", loadBucket: 0, slaRiskBucket: 0, ...over };
}

describe("applyRouteBuckets", () => {
  it("sets the load + slaRisk buckets on the matching route feature", () => {
    const { source } = createRouteLayer([
      route("R1", [
        [-90, 35],
        [-87, 41],
      ]),
    ]);
    applyRouteBuckets(source, [routeState({ loadBucket: 4, slaRiskBucket: 2 })]);
    const f = asSource(source).getFeatureById("route:R1");
    expect(f?.get("loadBucket")).toBe(4);
    expect(f?.get("slaRiskBucket")).toBe(2);
  });

  it("skips route ids that have no feature (continue branch)", () => {
    const { source } = createRouteLayer([
      route("R1", [
        [-90, 35],
        [-87, 41],
      ]),
    ]);
    expect(() =>
      applyRouteBuckets(source, [routeState({ id: "GHOST", loadBucket: 9 })]),
    ).not.toThrow();
    const f = asSource(source).getFeatureById("route:R1");
    expect(f?.get("loadBucket")).toBe(0);
  });
});
