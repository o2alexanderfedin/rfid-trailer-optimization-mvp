import { describe, expect, it } from "vitest";
import { hubSchema, routeSchema } from "@mm/domain";
import { buildRoutes, greatCircle } from "../src/network/routes.js";
import { USA_HUBS } from "../src/network/hubs.js";
import { makeRng } from "../src/rng.js";
import { VirtualClock } from "../src/clock.js";

/**
 * SIM-01 + the deterministic primitives (seeded RNG + virtual clock) the engine
 * is built on. These are PURE: no wall clock, no unseeded randomness, so the
 * resulting event stream is byte-reproducible (SIM-02 / threat T-01-15).
 */

// Continental-USA bounding box (WGS84): the SIM-01 validation envelope.
const LAT_MIN = 24;
const LAT_MAX = 49;
const LON_MIN = -125;
const LON_MAX = -66;

describe("USA hub network (SIM-01)", () => {
  it("models ~10 US metro hubs", () => {
    expect(USA_HUBS.length).toBeGreaterThanOrEqual(8);
    expect(USA_HUBS.length).toBeLessThanOrEqual(12);
  });

  it("has valid continental-USA coordinates and unique ids/names", () => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const hub of USA_HUBS) {
      // Conforms to the @mm/domain hub contract.
      expect(() => hubSchema.parse(hub)).not.toThrow();
      // Inside the continental-USA envelope (SIM-01 validation).
      expect(hub.lat).toBeGreaterThanOrEqual(LAT_MIN);
      expect(hub.lat).toBeLessThanOrEqual(LAT_MAX);
      expect(hub.lon).toBeGreaterThanOrEqual(LON_MIN);
      expect(hub.lon).toBeLessThanOrEqual(LON_MAX);
      ids.add(hub.hubId);
      names.add(hub.name);
    }
    expect(ids.size).toBe(USA_HUBS.length);
    expect(names.size).toBe(USA_HUBS.length);
  });
});

describe("great-circle interpolation (SIM-01)", () => {
  it("returns exactly n points, monotonically progressing a -> b", () => {
    const a = USA_HUBS[0]!;
    const b = USA_HUBS[4]!;
    const n = 16;
    const line = greatCircle([a.lon, a.lat], [b.lon, b.lat], n);

    expect(line).toHaveLength(n);
    // Endpoints are anchored at the hub coordinates (within float tolerance).
    expect(line[0]![0]).toBeCloseTo(a.lon, 6);
    expect(line[0]![1]).toBeCloseTo(a.lat, 6);
    expect(line[n - 1]![0]).toBeCloseTo(b.lon, 6);
    expect(line[n - 1]![1]).toBeCloseTo(b.lat, 6);

    // Fraction of total distance covered must be non-decreasing (monotonic).
    const dist = (p: readonly [number, number]): number =>
      Math.hypot(p[0] - a.lon, p[1] - a.lat);
    for (let i = 1; i < line.length; i += 1) {
      expect(dist(line[i]!)).toBeGreaterThanOrEqual(dist(line[i - 1]!) - 1e-9);
    }
  });

  it("is pure/deterministic — same inputs give identical output", () => {
    const x = greatCircle([-90, 35], [-118, 34], 10);
    const y = greatCircle([-90, 35], [-118, 34], 10);
    expect(x).toEqual(y);
  });
});

describe("hub-and-spoke routes (SIM-01)", () => {
  const routes = buildRoutes(USA_HUBS);

  it("produces valid Route entities anchored at hub coordinates", () => {
    const byId = new Map(USA_HUBS.map((h) => [h.hubId, h]));
    for (const route of routes) {
      expect(() => routeSchema.parse(route)).not.toThrow();
      const from = byId.get(route.fromHubId)!;
      const to = byId.get(route.toHubId)!;
      const first = route.geometry[0]!;
      const last = route.geometry[route.geometry.length - 1]!;
      expect(first[0]).toBeCloseTo(from.lon, 6);
      expect(first[1]).toBeCloseTo(from.lat, 6);
      expect(last[0]).toBeCloseTo(to.lon, 6);
      expect(last[1]).toBeCloseTo(to.lat, 6);
    }
  });

  it("forms a connected topology — every hub is reachable", () => {
    // Build an undirected adjacency from the routes and BFS from hub 0.
    const adj = new Map<string, Set<string>>();
    for (const hub of USA_HUBS) adj.set(hub.hubId, new Set());
    for (const route of routes) {
      adj.get(route.fromHubId)!.add(route.toHubId);
      adj.get(route.toHubId)!.add(route.fromHubId);
    }
    const seen = new Set<string>();
    const queue = [USA_HUBS[0]!.hubId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of adj.get(id)!) queue.push(next);
    }
    expect(seen.size).toBe(USA_HUBS.length);
  });

  it("is deterministic — buildRoutes yields identical routes each call", () => {
    expect(buildRoutes(USA_HUBS)).toEqual(buildRoutes(USA_HUBS));
  });
});

describe("seeded RNG (makeRng)", () => {
  it("is reproducible — same seed gives the same sequence", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds", () => {
    const a = Array.from({ length: 100 }, makeRng(1).next);
    const b = Array.from({ length: 100 }, makeRng(2).next);
    expect(a).not.toEqual(b);
  });

  it("produces floats in [0, 1)", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 1000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int(maxExclusive) stays in range and is reproducible", () => {
    const a = makeRng(99);
    const b = makeRng(99);
    for (let i = 0; i < 500; i += 1) {
      const va = a.int(6);
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(6);
      expect(Number.isInteger(va)).toBe(true);
      expect(va).toBe(b.int(6));
    }
  });

  it("pick selects an element reproducibly", () => {
    const items = ["a", "b", "c", "d"] as const;
    const a = makeRng(5);
    const b = makeRng(5);
    for (let i = 0; i < 50; i += 1) {
      expect(a.pick(items)).toBe(b.pick(items));
    }
  });
});

describe("virtual clock (no wall-clock reads)", () => {
  it("starts at the seeded epoch and advances by injected ticks", () => {
    const epoch = "2026-04-01T00:00:00.000Z";
    const clock = new VirtualClock(epoch, 60_000); // 1 tick = 60s
    expect(clock.nowIso()).toBe(epoch);

    clock.advance(1);
    expect(clock.nowIso()).toBe("2026-04-01T00:01:00.000Z");

    clock.advance(59);
    expect(clock.nowIso()).toBe("2026-04-01T01:00:00.000Z");
  });

  it("exposes domain time as a Date without reading the wall clock", () => {
    const clock = new VirtualClock("2026-04-01T00:00:00.000Z", 1_000);
    clock.advance(90);
    expect(clock.now().toISOString()).toBe("2026-04-01T00:01:30.000Z");
  });

  it("two clocks with the same epoch/tick advance identically", () => {
    const a = new VirtualClock("2026-04-01T00:00:00.000Z", 1_000);
    const b = new VirtualClock("2026-04-01T00:00:00.000Z", 1_000);
    a.advance(10);
    b.advance(10);
    expect(a.nowIso()).toBe(b.nowIso());
  });
});
