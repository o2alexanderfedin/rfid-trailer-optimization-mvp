import { describe, expect, it } from "vitest";
import {
  STATE_REGION_TZ,
  ADMIN1_TO_POSTAL,
  US_REGIONS,
  type UsRegion,
} from "../../../scripts/state-region-tz.js";
import {
  selectHubsPerState,
  dedupeCrossStateMetro,
  withinContinentalEnvelope,
  POP_THRESHOLD_RANK2,
  POP_THRESHOLD_RANK3,
  METRO_DEDUPE_RADIUS_KM,
  type CityRow,
} from "../../../scripts/generate-hubs.js";

/**
 * Phase 23 / Plan 23-01 (HUB-01..03): the PURE, dev-only selection logic behind
 * the committed big-city hub dataset. These tests exercise the deterministic
 * helpers ONLY — no `all-the-cities` import, no filesystem, no network (the
 * generator's I/O lives behind a `main()` guard, so importing it here is inert).
 */

/** A tiny `CityRow` factory for the pure-helper tests. */
function city(
  partial: Partial<CityRow> & Pick<CityRow, "name" | "state" | "population" | "lat" | "lon">,
): CityRow {
  return { ...partial };
}

describe("STATE_REGION_TZ (HUB-02/HUB-03 partition inputs)", () => {
  it("has exactly 51 entries (50 states + DC)", () => {
    expect(Object.keys(STATE_REGION_TZ)).toHaveLength(51);
  });

  it("every timezone is an IANA America/* string", () => {
    for (const [postal, meta] of Object.entries(STATE_REGION_TZ)) {
      expect(meta.timezone, `${postal} timezone`).toMatch(/^America\//);
    }
  });

  it("every region is in the closed set", () => {
    const closed = new Set<UsRegion>(US_REGIONS);
    for (const [postal, meta] of Object.entries(STATE_REGION_TZ)) {
      expect(closed.has(meta.region), `${postal} region ${meta.region}`).toBe(true);
    }
  });

  it("every postal key is a 2-letter uppercase code", () => {
    for (const postal of Object.keys(STATE_REGION_TZ)) {
      expect(postal).toMatch(/^[A-Z]{2}$/);
    }
  });
});

describe("ADMIN1_TO_POSTAL", () => {
  it("round-trips every postal in STATE_REGION_TZ", () => {
    for (const postal of Object.keys(STATE_REGION_TZ)) {
      expect(ADMIN1_TO_POSTAL[postal], `admin1 ${postal}`).toBe(postal);
    }
  });

  it("covers all 50 states + DC", () => {
    expect(Object.keys(ADMIN1_TO_POSTAL)).toHaveLength(51);
  });
});

describe("withinContinentalEnvelope", () => {
  it("accepts an interior point", () => {
    expect(withinContinentalEnvelope(39.0, -90.0)).toBe(true);
  });

  it("rejects a point north of lat 49 (e.g. Alaska)", () => {
    expect(withinContinentalEnvelope(61.2, -149.9)).toBe(false);
  });

  it("rejects a point west of lon -125 (e.g. Hawaii)", () => {
    expect(withinContinentalEnvelope(21.3, -157.8)).toBe(false);
  });

  it("accepts the inclusive envelope corners", () => {
    expect(withinContinentalEnvelope(24, -125)).toBe(true);
    expect(withinContinentalEnvelope(49, -66)).toBe(true);
  });
});

describe("selectHubsPerState (floor 1 / cap 3 with documented thresholds)", () => {
  it("a state with one city yields exactly 1 hub", () => {
    const one = [city({ name: "Lone", state: "MT", population: 50_000, lat: 46, lon: -112 })];
    expect(selectHubsPerState(one)).toHaveLength(1);
  });

  it("a dense state with 3 cities all >= T3 yields 3 hubs", () => {
    const dense = [
      city({ name: "A", state: "CA", population: POP_THRESHOLD_RANK3 + 3, lat: 34, lon: -118 }),
      city({ name: "B", state: "CA", population: POP_THRESHOLD_RANK3 + 2, lat: 37, lon: -122 }),
      city({ name: "C", state: "CA", population: POP_THRESHOLD_RANK3 + 1, lat: 38, lon: -121 }),
    ];
    expect(selectHubsPerState(dense)).toHaveLength(3);
  });

  it("a state whose 2nd city is below T2 yields exactly 1 hub", () => {
    const sparse = [
      city({ name: "Big", state: "NV", population: 600_000, lat: 36, lon: -115 }),
      city({ name: "Small", state: "NV", population: POP_THRESHOLD_RANK2 - 1, lat: 39, lon: -119 }),
    ];
    expect(selectHubsPerState(sparse)).toHaveLength(1);
  });

  it("a state whose 2nd >= T2 but 3rd < T3 yields exactly 2 hubs", () => {
    const two = [
      city({ name: "Big", state: "TX", population: 1_000_000, lat: 29, lon: -95 }),
      city({ name: "Mid", state: "TX", population: POP_THRESHOLD_RANK2 + 5, lat: 32, lon: -96 }),
      city({ name: "Below3", state: "TX", population: POP_THRESHOLD_RANK3 - 1, lat: 30, lon: -97 }),
    ];
    expect(selectHubsPerState(two)).toHaveLength(2);
  });

  it("ranks selected hubs 1-based by descending population", () => {
    const dense = [
      city({ name: "Mid", state: "AZ", population: POP_THRESHOLD_RANK3 + 1, lat: 32, lon: -110 }),
      city({ name: "Top", state: "AZ", population: POP_THRESHOLD_RANK3 + 9, lat: 33, lon: -112 }),
      city({ name: "Third", state: "AZ", population: POP_THRESHOLD_RANK3 + 0, lat: 35, lon: -111 }),
    ];
    const selected = selectHubsPerState(dense);
    expect(selected.map((c) => c.name)).toEqual(["Top", "Mid", "Third"]);
    expect(selected.map((c) => c.rank)).toEqual([1, 2, 3]);
  });
});

describe("dedupeCrossStateMetro (collapse to highest-population state)", () => {
  it("collapses two near-coincident cross-state rows to the higher-pop state's row", () => {
    const rows = [
      city({ name: "BigMetro", state: "NY", population: 8_000_000, lat: 40.71, lon: -74.0 }),
      city({ name: "Suburb", state: "NJ", population: 280_000, lat: 40.73, lon: -74.17 }),
    ];
    const deduped = dedupeCrossStateMetro(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.state).toBe("NY");
    expect(deduped[0]?.name).toBe("BigMetro");
  });

  it("keeps two cities far apart in different states", () => {
    const rows = [
      city({ name: "West", state: "CA", population: 4_000_000, lat: 34, lon: -118 }),
      city({ name: "East", state: "NY", population: 8_000_000, lat: 40.7, lon: -74 }),
    ];
    expect(dedupeCrossStateMetro(rows)).toHaveLength(2);
  });

  it("does NOT collapse two near-coincident cities in the SAME state", () => {
    const rows = [
      city({ name: "A", state: "CA", population: 1_000_000, lat: 34.0, lon: -118.0 }),
      city({ name: "B", state: "CA", population: 900_000, lat: 34.05, lon: -118.05 }),
    ];
    expect(dedupeCrossStateMetro(rows)).toHaveLength(2);
  });

  it("exposes a documented positive dedupe radius", () => {
    expect(METRO_DEDUPE_RADIUS_KM).toBeGreaterThan(0);
  });
});
