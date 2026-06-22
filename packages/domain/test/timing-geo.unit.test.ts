import { describe, expect, it } from "vitest";
import type { Hub } from "../src/index.js";
import {
  DEFAULT_TIMING_CONFIG,
  expectedDwellMinutes,
  expectedMinutes,
  expectedTransitMinutes,
  haversineKm,
  transitParamsForLeg,
} from "../src/index.js";

/**
 * Phase-7 OPT-09/OPT-10 foundation (Task A): the pure geography→transit
 * derivation now lives in `@mm/domain` so the optimizer (which CANNOT import
 * `@mm/simulation`) can compute its deterministic per-leg estimate from the same
 * `TimingConfig` the simulator draws from. These helpers are PURE (no clock, no
 * RNG): identical inputs ⇒ identical output, byte-reproducible.
 *
 *  - `expectedTransitMinutes(from,to,config)` = `expectedMinutes` of the leg's
 *    geography-derived transit params (the log-normal MEAN — OPT-10 semantics).
 *  - `expectedDwellMinutes(role,config)` = `expectedMinutes` of the role's dwell
 *    distribution (center vs spoke — Phase-6 TIME-02 parity).
 */

// Minimal Hub fixtures — only lon/lat/hubId matter to the geography helpers.
const MEM: Hub = { hubId: "MEM", name: "Memphis", lon: -89.9711, lat: 35.1175 };
const ORD: Hub = { hubId: "ORD", name: "Chicago", lon: -87.9073, lat: 41.9742 };
const LAX: Hub = { hubId: "LAX", name: "Los Angeles", lon: -118.4085, lat: 33.9416 };
const IND: Hub = { hubId: "IND", name: "Indianapolis", lon: -86.2944, lat: 39.7173 };

describe("haversineKm (moved to @mm/domain, pure great-circle distance)", () => {
  it("is symmetric and positive for distinct hubs", () => {
    expect(haversineKm(MEM, ORD)).toBeGreaterThan(0);
    expect(haversineKm(MEM, ORD)).toBeCloseTo(haversineKm(ORD, MEM), 6);
  });

  it("is zero for coincident points and pure (same inputs ⇒ same output)", () => {
    expect(haversineKm(MEM, MEM)).toBeCloseTo(0, 6);
    expect(haversineKm(MEM, ORD)).toBe(haversineKm(MEM, ORD));
  });

  it("matches a known-good Memphis→Chicago great-circle distance (~783 km)", () => {
    // MEM(-89.9711,35.1175)↔ORD(-87.9073,41.9742) haversine ≈ 783.2 km; a tight
    // ±1 km band pins the formula against accidental drift.
    expect(haversineKm(MEM, ORD)).toBeGreaterThan(782);
    expect(haversineKm(MEM, ORD)).toBeLessThan(784);
  });
});

describe("expectedTransitMinutes (deterministic per-leg planning estimate)", () => {
  const config = DEFAULT_TIMING_CONFIG;

  it("equals expectedMinutes of the leg's transit params (the MEAN, OPT-10)", () => {
    const expected = expectedMinutes(
      transitParamsForLeg(MEM, ORD, config.transit.sigma),
    );
    expect(expectedTransitMinutes(MEM, ORD, config)).toBe(expected);
  });

  it("a LONGER leg yields a strictly LARGER estimate than a short leg", () => {
    const longLeg = expectedTransitMinutes(MEM, LAX, config); // coast-to-interior
    const shortLeg = expectedTransitMinutes(MEM, IND, config); // regional
    expect(longLeg).toBeGreaterThan(shortLeg);
  });

  it("is symmetric in the two hubs (geography is undirected)", () => {
    expect(expectedTransitMinutes(MEM, LAX, config)).toBeCloseTo(
      expectedTransitMinutes(LAX, MEM, config),
      6,
    );
  });

  it("is pure/deterministic — identical inputs yield identical output", () => {
    expect(expectedTransitMinutes(MEM, ORD, config)).toBe(
      expectedTransitMinutes(MEM, ORD, config),
    );
  });
});

describe("expectedDwellMinutes (role-based dwell estimate)", () => {
  const config = DEFAULT_TIMING_CONFIG;

  it("center dwell equals expectedMinutes(dwellCenter) (≈65 min)", () => {
    expect(expectedDwellMinutes("center", config)).toBe(
      expectedMinutes(config.dwellCenter),
    );
    expect(expectedDwellMinutes("center", config)).toBeCloseTo(64.997, 2);
  });

  it("spoke dwell equals expectedMinutes(dwellSpoke) (≈27 min)", () => {
    expect(expectedDwellMinutes("spoke", config)).toBe(
      expectedMinutes(config.dwellSpoke),
    );
    expect(expectedDwellMinutes("spoke", config)).toBeCloseTo(27.082, 2);
  });

  it("a center hub dwells STRICTLY LONGER than a spoke (cross-dock contention)", () => {
    expect(expectedDwellMinutes("center", config)).toBeGreaterThan(
      expectedDwellMinutes("spoke", config),
    );
  });

  it("is pure/deterministic — identical inputs yield identical output", () => {
    expect(expectedDwellMinutes("center", config)).toBe(
      expectedDwellMinutes("center", config),
    );
  });
});
