import { describe, expect, it } from "vitest";
import { hubSchema, haversineKm, type Hub } from "@mm/domain";
import { generateBigCityHubs, type BigCityHub } from "../../src/network/hubs.js";
import {
  pickRegionalCenters,
  assignSpokesToNearestCenter,
  buildBackbone,
  isConnectedWithoutAnyCenter,
  DEFAULT_CENTER_COUNT,
  DEFAULT_LEG_CAP_KM,
} from "../../src/network/centers.js";

/**
 * Phase 23 plan 03 — pure multi-center topology functions. Everything under test
 * is a PURE function of the committed dataset (no clock, no RNG, no network), so
 * identical inputs ⇒ byte-identical outputs (the continental-topology bootstrap
 * must be reproducible).
 */

// Continental-USA bounding box (WGS84): the SIM-01 / HUB validation envelope.
const LAT_MIN = 24;
const LAT_MAX = 49;
const LON_MIN = -125;
const LON_MAX = -66;

/** Stable, deterministic deep clone via JSON (the rows are plain data). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A reversed copy of an array (to prove order-independence / stability). */
function reversed<T>(arr: readonly T[]): T[] {
  return [...arr].reverse();
}

describe("generateBigCityHubs (HUB-04 generator)", () => {
  const hubs = generateBigCityHubs();

  it("returns the committed dataset as an in-envelope, sorted, unique-id set", () => {
    expect(hubs.length).toBeGreaterThanOrEqual(80);
    expect(hubs.length).toBeLessThanOrEqual(130);

    const ids = new Set<string>();
    for (const h of hubs) {
      // Conforms to the @mm/domain Hub contract (hubId/name/lat/lon).
      expect(() => hubSchema.parse({ hubId: h.hubId, name: h.name, lat: h.lat, lon: h.lon })).not.toThrow();
      expect(h.lat).toBeGreaterThanOrEqual(LAT_MIN);
      expect(h.lat).toBeLessThanOrEqual(LAT_MAX);
      expect(h.lon).toBeGreaterThanOrEqual(LON_MIN);
      expect(h.lon).toBeLessThanOrEqual(LON_MAX);
      ids.add(h.hubId);
    }
    expect(ids.size).toBe(hubs.length);
  });

  it("is sorted ascending by hubId", () => {
    const sorted = [...hubs].map((h) => h.hubId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(hubs.map((h) => h.hubId)).toEqual(sorted);
  });

  it("carries the extended BigCityHub shape (state/region/timezone/population/rank)", () => {
    for (const h of hubs) {
      expect(typeof h.state).toBe("string");
      expect(typeof h.region).toBe("string");
      expect(typeof h.timezone).toBe("string");
      expect(typeof h.population).toBe("number");
      expect(typeof h.rank).toBe("number");
    }
  });

  it("is pure — two calls return deeply-equal arrays (no I/O leak / mutation)", () => {
    const a = generateBigCityHubs();
    const b = generateBigCityHubs();
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // a fresh array each call (no shared mutable state)
  });
});

describe("pickRegionalCenters (NET-02 — parameterized, partition-based)", () => {
  const hubs = generateBigCityHubs();

  it("honors the requested count (4, 6, 8) returning that many distinct centers", () => {
    for (const count of [4, 6, 8]) {
      const centers = pickRegionalCenters(hubs, count);
      expect(centers.length).toBe(count);
      const ids = new Set(centers.map((c) => c.hubId));
      expect(ids.size).toBe(count);
      // Each chosen center is a real dataset hub.
      for (const c of centers) {
        expect(hubs.some((h) => h.hubId === c.hubId)).toBe(true);
      }
    }
  });

  it("never collapses to a single center (>= 2 even for tiny counts)", () => {
    expect(pickRegionalCenters(hubs, 1).length).toBeGreaterThanOrEqual(2);
    expect(pickRegionalCenters(hubs, 0).length).toBeGreaterThanOrEqual(2);
  });

  it("returns centers sorted ascending by hubId", () => {
    const centers = pickRegionalCenters(hubs, 6);
    const sorted = [...centers].map((c) => c.hubId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(centers.map((c) => c.hubId)).toEqual(sorted);
  });

  it("is stable under input reordering — the chosen set is identical", () => {
    const a = pickRegionalCenters(hubs, 6).map((c) => c.hubId);
    const b = pickRegionalCenters(reversed(hubs), 6).map((c) => c.hubId);
    const c = pickRegionalCenters(clone(hubs), 6).map((x) => x.hubId);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("exposes a default center count in the 4-8 empirical envelope (concrete value chosen in 23-05)", () => {
    expect(DEFAULT_CENTER_COUNT).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_CENTER_COUNT).toBeLessThanOrEqual(8);
  });
});

describe("assignSpokesToNearestCenter (NET-03 — leg cap, tie-break by id)", () => {
  const hubs = generateBigCityHubs();
  const centers = pickRegionalCenters(hubs, 6);
  const centerIds = new Set(centers.map((c) => c.hubId));
  const spokes = hubs.filter((h) => !centerIds.has(h.hubId));

  it("assigns every spoke to one of the chosen centers", () => {
    const map = assignSpokesToNearestCenter(spokes, centers, DEFAULT_LEG_CAP_KM);
    expect(map.size).toBe(spokes.length);
    for (const [, centerId] of map) {
      expect(centerIds.has(centerId)).toBe(true);
    }
  });

  it("is deterministic — the same map twice", () => {
    const a = assignSpokesToNearestCenter(spokes, centers, DEFAULT_LEG_CAP_KM);
    const b = assignSpokesToNearestCenter(spokes, centers, DEFAULT_LEG_CAP_KM);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it("breaks ties by lowest center hubId (equidistant spoke)", () => {
    // A spoke exactly between two centers (same region/tz) must pick the lower id.
    const spoke: BigCityHub = {
      hubId: "zz-tiebreak", name: "Tie", state: "XX", lat: 0, lon: 0,
      population: 1, rank: 1, region: "South", timezone: "America/Chicago",
    };
    const cHi: BigCityHub = {
      hubId: "zz-high", name: "Hi", state: "XX", lat: 0, lon: 1,
      population: 1, rank: 1, region: "South", timezone: "America/Chicago",
    };
    const cLo: BigCityHub = {
      hubId: "aa-low", name: "Lo", state: "XX", lat: 0, lon: -1,
      population: 1, rank: 1, region: "South", timezone: "America/Chicago",
    };
    const map = assignSpokesToNearestCenter([spoke], [cHi, cLo], 100_000);
    expect(map.get("zz-tiebreak")).toBe("aa-low"); // equal distance -> lowest id
  });

  it("is stable under a sub-6dp coordinate nudge (no re-partition / no flip)", () => {
    const base = assignSpokesToNearestCenter(spokes, centers, DEFAULT_LEG_CAP_KM);
    const nudged = spokes.map((s) => ({ ...s, lat: s.lat + 1e-9, lon: s.lon - 1e-9 }));
    const after = assignSpokesToNearestCenter(nudged, centers, DEFAULT_LEG_CAP_KM);
    expect([...after.entries()].sort()).toEqual([...base.entries()].sort());
  });

  it("respects the leg cap OR documents the overflow fallback (every assigned leg has a center)", () => {
    const map = assignSpokesToNearestCenter(spokes, centers, DEFAULT_LEG_CAP_KM);
    const byId = new Map(hubs.map((h) => [h.hubId, h]));
    for (const [spokeId, centerId] of map) {
      const s = byId.get(spokeId)!;
      const c = byId.get(centerId)!;
      // The assigned leg is within the cap (the continental dataset fits the cap).
      expect(haversineKm(s, c)).toBeLessThanOrEqual(DEFAULT_LEG_CAP_KM);
    }
  });
});

describe("buildBackbone (NET-04 — near-full-mesh)", () => {
  const hubs = generateBigCityHubs();

  it("returns n*(n-1) directed pairs, sorted, with no self-pairs", () => {
    for (const count of [3, 4, 6]) {
      const centers = pickRegionalCenters(hubs, count);
      const n = centers.length;
      const legs = buildBackbone(centers);
      expect(legs.length).toBe(n * (n - 1));
      // No self-pairs.
      for (const leg of legs) expect(leg.fromHubId).not.toBe(leg.toHubId);
      // Both directions present for every unordered pair.
      const keys = new Set(legs.map((l) => `${l.fromHubId}->${l.toHubId}`));
      for (const a of centers) {
        for (const b of centers) {
          if (a.hubId !== b.hubId) expect(keys.has(`${a.hubId}->${b.hubId}`)).toBe(true);
        }
      }
      // Stable sorted order (by from, then to).
      const sorted = [...legs].sort((x, y) =>
        x.fromHubId === y.fromHubId
          ? x.toHubId < y.toHubId ? -1 : x.toHubId > y.toHubId ? 1 : 0
          : x.fromHubId < y.fromHubId ? -1 : 1,
      );
      expect(legs).toEqual(sorted);
    }
  });
});

describe("isConnectedWithoutAnyCenter (NET-04 — anti-SPOF)", () => {
  const hubs = generateBigCityHubs();

  it("passes for a full mesh of >= 3 centers (coast-to-coast <= 2 hops)", () => {
    const centers = pickRegionalCenters(hubs, 6);
    const backbone = buildBackbone(centers);
    expect(isConnectedWithoutAnyCenter(centers, backbone)).toBe(true);
  });

  it("FAILS for a hub-of-hubs star (re-centralization / SPOF witness)", () => {
    const centers = pickRegionalCenters(hubs, 5);
    const hub = centers[0]!;
    // Star: every leg goes through the single `hub` center (both directions).
    const star: { fromHubId: string; toHubId: string }[] = [];
    for (const c of centers) {
      if (c.hubId === hub.hubId) continue;
      star.push({ fromHubId: hub.hubId, toHubId: c.hubId });
      star.push({ fromHubId: c.hubId, toHubId: hub.hubId });
    }
    // Removing the central hub disconnects the rest -> anti-SPOF catches it.
    expect(isConnectedWithoutAnyCenter(centers, star)).toBe(false);
  });

  it("is true for a trivial 2-center mesh (removing one leaves a single connected node)", () => {
    const centers = pickRegionalCenters(hubs, 2);
    const backbone = buildBackbone(centers);
    expect(isConnectedWithoutAnyCenter(centers, backbone)).toBe(true);
  });
});
