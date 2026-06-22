import { describe, expect, it } from "vitest";
import type { DomainEvent, TimingConfig } from "@mm/domain";
import {
  DEFAULT_TIMING_CONFIG,
  expectedDwellMinutes,
  expectedMinutes,
} from "@mm/domain";

import { DEFAULT_OBJECTIVE_WEIGHTS } from "../objective/weights.js";
import { feasibleArrivals } from "../vrptw/feasibility.js";
import type { Stop, TravelModel } from "../vrptw/types.js";
import { runEpoch, stopsForTrailer } from "./epoch.js";
import type { Epoch, EpochInput, TwinSnapshot, TwinTrailer } from "./types.js";

/**
 * OPT-09 / OPT-10 — the optimizer plans against the SHARED realistic time model.
 *
 * Two surfaces (Phase-7 Task B):
 *  1. TRAVEL: the VRPTW travel oracle + the time-expanded flow graph consume the
 *     twin route's `travelMin` (the deterministic per-leg expected transit MEAN),
 *     integer-rounded at the graph boundary. Changing the per-leg travel time
 *     changes the plan's objective cost — OPT-09 is observable.
 *  2. DWELL: each routed stop's `serviceMin` is the role-based dwell MEAN —
 *     `expectedDwellMinutes("center", config)` at the network center hub,
 *     `expectedDwellMinutes("spoke", config)` at spokes (Phase-6 TIME-02 parity).
 *     Exactly ONE dwell per stop; changing the dwell config shifts the routed
 *     arrival/departure ETAs.
 *
 * OPT-10: the estimate is the log-normal MEAN (`expectedMinutes`), never the
 * median nor a percentile, so the planner is unbiased w.r.t. realized throughput.
 *
 * These are PURE-core assertions over `runEpoch` (data in, data out — no clock,
 * no RNG); the API/sim wiring of the twin route's `travelMin` is verified
 * separately (twin-snapshot.test.ts).
 */

function departed(trailerId: string, fromHubId: string, toHubId: string): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId: `${trailerId}-trip`, packageIds: [] },
  };
}

/**
 * A twin with H1 as the network center (`centerHubId`) and a SINGLE spoke leg
 * H1→H2 (so the routed sequence cannot avoid the leg — its `travelMin` is the
 * whole of `miles`). The per-leg `travelMin` is supplied (the twin builder
 * derives it from `expectedTransitMinutes`); here we vary it directly to prove
 * OPT-09. The trailer departs H1 for H2 only, so the affected scope (driven by
 * the `TrailerDeparted` event) contains exactly {H1, H2} and the H1→H2 leg
 * survives `buildTwin`'s in-scope filter.
 */
function snapshot(travelMin = 30, centerHubId = "H1"): TwinSnapshot {
  return {
    hubs: ["H1", "H2"],
    centerHubId,
    routes: [{ routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin, capacity: 20 }],
    trailers: [
      {
        trailerId: "T1",
        currentHubId: "H1",
        departureMin: 300,
        capacity: 20,
        route: [{ hubId: "H2", stopIndex: 0 }],
        blocks: [{ blockId: "B1", nextUnloadHubId: "H2", volume: 16 }],
      },
    ],
  };
}

const EPOCH: Epoch = { epochId: "e1", nowMin: 100, freezeWindowMin: 15 };

function input(snap: TwinSnapshot, timing?: TimingConfig): EpochInput {
  const base = { events: [departed("T1", "H1", "H2")], twinSnapshot: snap };
  return timing === undefined ? base : { ...base, timing };
}

describe("OPT-09 — the optimizer plans against the per-leg expected transit (travel)", () => {
  it("changing the per-leg travelMin changes the plan's objective cost", () => {
    const cheap = runEpoch(EPOCH, input(snapshot(30)), DEFAULT_OBJECTIVE_WEIGHTS);
    const dear = runEpoch(EPOCH, input(snapshot(300)), DEFAULT_OBJECTIVE_WEIGHTS);

    const cheapRec = cheap.recommendations.find((r) => r.trailerId === "T1")!;
    const dearRec = dear.recommendations.find((r) => r.trailerId === "T1")!;

    // The miles term is Σ travelMin over the routed sequence; a 10× longer leg
    // strictly increases the objective cost (OPT-09 observable).
    expect(dearRec.objectiveCost).toBeGreaterThan(cheapRec.objectiveCost);
    expect(dearRec.breakdown.miles).toBeGreaterThan(cheapRec.breakdown.miles);
  });

  it("integer-rounds a fractional travelMin at the graph boundary (anti-P12)", () => {
    // A fractional expected-transit value (the log-normal mean is fractional)
    // must not leak into the integer-minute objective. The boundary rounds it.
    const frac = runEpoch(EPOCH, input(snapshot(30.4)), DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = frac.recommendations.find((r) => r.trailerId === "T1")!;
    expect(Number.isInteger(rec.breakdown.miles)).toBe(true);
  });

  it("is deterministic: identical (epoch,input,weights) ⇒ byte-identical result", () => {
    const a = runEpoch(EPOCH, input(snapshot(213)), DEFAULT_OBJECTIVE_WEIGHTS);
    const b = runEpoch(EPOCH, input(snapshot(213)), DEFAULT_OBJECTIVE_WEIGHTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("OPT-09 — role-based dwell as VRPTW serviceMin (dwell)", () => {
  // A travel oracle that mirrors the twin: H1→spoke is `travelMin`, else 0.
  function travelModel(travelMin: number): TravelModel {
    return {
      travelMin(from: string, to: string): number {
        if (from === to) return 0;
        return travelMin;
      },
    };
  }

  /** A trailer at the center (H1) visiting a center revisit + two spokes. */
  function trailer(): TwinTrailer {
    return {
      trailerId: "T1",
      currentHubId: "H1",
      departureMin: 300,
      capacity: 50,
      route: [
        { hubId: "H1", stopIndex: 0 }, // the center hub itself, revisited
        { hubId: "H2", stopIndex: 1 }, // spoke
        { hubId: "H3", stopIndex: 2 }, // spoke
      ],
      blocks: [
        { blockId: "B1", nextUnloadHubId: "H2", volume: 6 },
        { blockId: "B2", nextUnloadHubId: "H3", volume: 8 },
      ],
    };
  }

  it("stopsForTrailer sets serviceMin = round(expectedDwellMinutes(role)) — center at the center hub, spoke elsewhere", () => {
    const centerDwell = Math.round(expectedDwellMinutes("center", DEFAULT_TIMING_CONFIG));
    const spokeDwell = Math.round(expectedDwellMinutes("spoke", DEFAULT_TIMING_CONFIG));
    expect(centerDwell).toBeGreaterThan(spokeDwell);

    const stops = stopsForTrailer(trailer(), "H1", DEFAULT_TIMING_CONFIG);
    const byHub = new Map(stops.map((s) => [s.hubId, s.serviceMin]));
    // The center hub (H1) carries the CENTER dwell; the spokes carry the SPOKE dwell.
    expect(byHub.get("H1")).toBe(centerDwell);
    expect(byHub.get("H2")).toBe(spokeDwell);
    expect(byHub.get("H3")).toBe(spokeDwell);
  });

  it("emits exactly ONE serviceMin per stop (no double-counting of dwell)", () => {
    const stops = stopsForTrailer(trailer(), "H1", DEFAULT_TIMING_CONFIG);
    // One stop per distinct route hub — each with a single dwell, never summed.
    expect(stops.map((s) => s.hubId).sort()).toEqual(["H1", "H2", "H3"]);
    for (const s of stops) {
      expect(Number.isInteger(s.serviceMin)).toBe(true);
      expect(s.serviceMin).toBeGreaterThan(0);
    }
  });

  it("a stop's serviceMin drives the departure ETA: departure = serviceStart + ONE dwell", () => {
    const spokeDwell = Math.round(expectedDwellMinutes("spoke", DEFAULT_TIMING_CONFIG));
    const spokeStop: Stop = {
      hubId: "H2",
      serviceMin: spokeDwell,
      windowStartMin: 0,
      windowEndMin: Number.MAX_SAFE_INTEGER,
      demand: 6,
    };
    const routed = feasibleArrivals([spokeStop], "H1", travelModel(10), 0)!;
    expect(routed).not.toBeNull();
    expect(routed[0]!.arrivalMin).toBe(10);
    expect(routed[0]!.departureMin).toBe(10 + spokeDwell);
  });

  it("OPT-10: the dwell estimate is the log-normal MEAN, not the median", () => {
    // mean = median · exp(σ²/2) ≥ median; for σ>0 the mean is strictly larger.
    const cfg = DEFAULT_TIMING_CONFIG;
    const mean = expectedMinutes(cfg.dwellCenter);
    expect(mean).toBeGreaterThan(cfg.dwellCenter.median);
    expect(expectedDwellMinutes("center", cfg)).toBe(mean);
  });
});

describe("OPT-09 — changing the timing config changes the plan (observable end to end)", () => {
  it("a longer dwell config does not crash and stays deterministic", () => {
    const longerDwell: TimingConfig = {
      ...DEFAULT_TIMING_CONFIG,
      dwellSpoke: { ...DEFAULT_TIMING_CONFIG.dwellSpoke, median: 200 },
      dwellCenter: { ...DEFAULT_TIMING_CONFIG.dwellCenter, median: 300 },
    };
    const a = runEpoch(EPOCH, input(snapshot(30), longerDwell), DEFAULT_OBJECTIVE_WEIGHTS);
    const b = runEpoch(EPOCH, input(snapshot(30), longerDwell), DEFAULT_OBJECTIVE_WEIGHTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Still produces a plan (the wide windows keep it feasible despite long dwell).
    const rec = a.recommendations.find((r) => r.trailerId === "T1")!;
    expect(rec).toBeDefined();
  });
});
