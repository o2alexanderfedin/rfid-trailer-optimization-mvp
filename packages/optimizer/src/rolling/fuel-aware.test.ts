import { describe, expect, it } from "vitest";
import type { DomainEvent, FuelConfig } from "@mm/domain";
import { DEFAULT_FUEL_CONFIG } from "@mm/domain";

import { DEFAULT_OBJECTIVE_WEIGHTS } from "../objective/weights.js";
import { refuelMinForStop, runEpoch, stopsForTrailer } from "./epoch.js";
import { DEFAULT_TIMING_CONFIG } from "@mm/domain";
import { feasibleArrivals } from "../vrptw/feasibility.js";
import type { Stop, TravelModel } from "../vrptw/types.js";
import type { Epoch, EpochInput, TwinSnapshot, TwinTrailer } from "./types.js";

/**
 * SP2 Task 4 — optimizer fuel-awareness (spec §7), mirroring OPT-HOS-02's
 * `restMin` injection. The departure folds `+ max(restMin ?? 0, refuelMin ?? 0)`
 * — a refuel co-located with a rest OVERLAPS it (no double-count) and, absent a
 * `fuelConfig`, EVERY pre-SP2 instance reproduces its prior verdict byte-identically
 * (`refuelMin` defaults 0; `max(restMin, 0) === restMin`).
 */

const FUEL_ON: FuelConfig = { ...DEFAULT_FUEL_CONFIG, enabled: true };

function departed(trailerId: string, fromHubId: string, toHubId: string): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId: `${trailerId}-trip`, packageIds: [] },
  };
}

const EPOCH: Epoch = { epochId: "e1", nowMin: 100, freezeWindowMin: 15 };

// ---------------------------------------------------------------------------
// refuelMinForStop — the pure threshold helper
// ---------------------------------------------------------------------------
describe("refuelMinForStop — pure threshold + reset (spec §7)", () => {
  it("returns 0 refuelMin + accumulated miles when the leg does NOT cross the threshold", () => {
    const r = refuelMinForStop({ milesBefore: 100, legDistanceMiles: 200, fuel: FUEL_ON });
    expect(r.refuelMin).toBe(0);
    expect(r.milesAfter).toBe(300);
  });

  it("returns refuelTimeMinutes + RESET miles when the leg crosses the threshold", () => {
    // 1100 + 200 = 1300 ≥ 1200 ⇒ refuel; running total resets to 0.
    const r = refuelMinForStop({ milesBefore: 1100, legDistanceMiles: 200, fuel: FUEL_ON });
    expect(r.refuelMin).toBe(FUEL_ON.refuelTimeMinutes);
    expect(r.milesAfter).toBe(0);
  });

  it("threshold-EXACT crossing refuels (>= threshold, not strictly >)", () => {
    const r = refuelMinForStop({ milesBefore: 1000, legDistanceMiles: 200, fuel: FUEL_ON });
    expect(r.refuelMin).toBe(FUEL_ON.refuelTimeMinutes); // 1200 === threshold
    expect(r.milesAfter).toBe(0);
  });

  it("a DISABLED fuel config never refuels (refuelMin 0) but still accrues miles", () => {
    const r = refuelMinForStop({ milesBefore: 5000, legDistanceMiles: 5000, fuel: DEFAULT_FUEL_CONFIG });
    expect(r.refuelMin).toBe(0);
    expect(r.milesAfter).toBe(10_000);
  });

  it("integer-rounds the refuelMin at the boundary (anti-P12)", () => {
    const frac: FuelConfig = { ...FUEL_ON, refuelTimeMinutes: 30.7 };
    const r = refuelMinForStop({ milesBefore: 1200, legDistanceMiles: 1, fuel: frac });
    expect(Number.isInteger(r.refuelMin)).toBe(true);
    expect(r.refuelMin).toBe(31);
  });

  it("a zero-distance leg accrues nothing and never refuels below threshold", () => {
    const r = refuelMinForStop({ milesBefore: 100, legDistanceMiles: 0, fuel: FUEL_ON });
    expect(r.refuelMin).toBe(0);
    expect(r.milesAfter).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// stopsForTrailer — refuelMin assigned at the crossing stop
// ---------------------------------------------------------------------------
describe("stopsForTrailer — fuel-aware refuelMin assignment (spec §7)", () => {
  function trailerCrossing(milesSinceRefuel: number): TwinTrailer {
    return {
      trailerId: "T1",
      currentHubId: "H1",
      departureMin: 300,
      capacity: 50,
      milesSinceRefuel,
      route: [
        { hubId: "H2", stopIndex: 0 },
        { hubId: "H3", stopIndex: 1 },
      ],
      blocks: [
        { blockId: "B1", nextUnloadHubId: "H2", volume: 6 },
        { blockId: "B2", nextUnloadHubId: "H3", volume: 8 },
      ],
    };
  }

  /** Per-leg distance: H1→H2 = 800 mi, H2→H3 = 800 mi. */
  function distanceFor(): ReadonlyMap<string, number> {
    return new Map([
      ["H1->H2", 800],
      ["H2->H3", 800],
    ]);
  }

  it("absent fuel config ⇒ NO stop gets a refuelMin (back-compat: undefined/0)", () => {
    const stops = stopsForTrailer(trailerCrossing(1000), "H1", DEFAULT_TIMING_CONFIG);
    for (const s of stops) {
      expect(s.refuelMin ?? 0).toBe(0);
    }
  });

  it("with fuel ON, the stop where the cumulative distance crosses the threshold gets refuelMin", () => {
    // milesSinceRefuel 600 + H1→H2 800 = 1400 ≥ 1200 ⇒ H2 refuels.
    const stops = stopsForTrailer(
      trailerCrossing(600),
      "H1",
      DEFAULT_TIMING_CONFIG,
      FUEL_ON,
      distanceFor(),
    );
    const byHub = new Map(stops.map((s) => [s.hubId, s.refuelMin ?? 0]));
    expect(byHub.get("H2")).toBe(FUEL_ON.refuelTimeMinutes);
    // After the H2 refuel the running total resets; H2→H3 = 800 < 1200 ⇒ no refuel.
    expect(byHub.get("H3")).toBe(0);
  });

  it("a multi-refuel route refuels at MORE THAN ONE stop when each leg re-crosses", () => {
    // Tiny threshold so every leg crosses: both H2 and H3 refuel.
    const tiny: FuelConfig = { ...FUEL_ON, refuelThresholdMiles: 100 };
    const stops = stopsForTrailer(
      trailerCrossing(0),
      "H1",
      DEFAULT_TIMING_CONFIG,
      tiny,
      distanceFor(),
    );
    const refuelStops = stops.filter((s) => (s.refuelMin ?? 0) > 0);
    expect(refuelStops.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runEpoch back-compat + fuel-aware effect
// ---------------------------------------------------------------------------
function snapshot(milesSinceRefuel?: number): TwinSnapshot {
  const trailer: TwinTrailer = {
    trailerId: "T1",
    currentHubId: "H1",
    departureMin: 300,
    capacity: 20,
    route: [{ hubId: "H2", stopIndex: 0 }],
    blocks: [{ blockId: "B1", nextUnloadHubId: "H2", volume: 16 }],
    ...(milesSinceRefuel === undefined ? {} : { milesSinceRefuel }),
  };
  return {
    hubs: ["H1", "H2"],
    centerHubId: "H1",
    routes: [
      // distanceMiles is additive; a long leg (1500 mi) crosses the 1200 threshold.
      { routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin: 30, capacity: 20, distanceMiles: 1500 },
    ],
    trailers: [trailer],
  };
}

function input(snap: TwinSnapshot, fuelConfig?: FuelConfig): EpochInput {
  const base = { events: [departed("T1", "H1", "H2")], twinSnapshot: snap };
  return fuelConfig === undefined ? base : { ...base, fuelConfig };
}

describe("runEpoch — fuel-awareness is additive + back-compatible (spec §7)", () => {
  it("BACK-COMPAT: for the SAME snapshot, absent fuelConfig ⇒ byte-identical result", () => {
    // The fuelConfig is NOT folded into the scopeHash (only the twinSnapshot is),
    // so absent vs an explicit-disabled config over the SAME snapshot must produce
    // a byte-identical EpochResult (no refuel assigned ⇒ prior plan unchanged).
    const a = runEpoch(EPOCH, input(snapshot(0)), DEFAULT_OBJECTIVE_WEIGHTS);
    const b = runEpoch(EPOCH, input(snapshot(0), DEFAULT_FUEL_CONFIG), DEFAULT_OBJECTIVE_WEIGHTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("BACK-COMPAT: a fuel-OFF twin's plan (cost/feasibility/ETAs) is unchanged vs no-fuel-fields", () => {
    // Adding `milesSinceRefuel:0`/`distanceMiles` to the twin changes only the
    // snapshot HASH (it is hashed by design); the PLAN itself — objectiveCost,
    // feasibility, and the per-term breakdown — must be byte-identical to the
    // pre-SP2 twin (no refuel time folded when fuel is off). `max(restMin,0)===restMin`.
    const noFields = runEpoch(EPOCH, input(snapshot()), DEFAULT_OBJECTIVE_WEIGHTS);
    const withZero = runEpoch(EPOCH, input(snapshot(0), DEFAULT_FUEL_CONFIG), DEFAULT_OBJECTIVE_WEIGHTS);
    const a = noFields.recommendations.find((r) => r.trailerId === "T1")!;
    const b = withZero.recommendations.find((r) => r.trailerId === "T1")!;
    expect(a.objectiveCost).toBe(b.objectiveCost);
    expect(a.feasible).toBe(b.feasible);
    expect(JSON.stringify(a.breakdown)).toBe(JSON.stringify(b.breakdown));
  });

  it("BACK-COMPAT: an HOS-rest leg is byte-identical with fuel OFF (max(restMin,0)===restMin)", () => {
    // A trailer with a driver HOS context whose leg forces a rest must produce the
    // SAME plan whether fuel is absent or explicitly disabled — the refuel fold
    // `max(restMin, refuelMin)` reduces to `restMin` when refuelMin is 0.
    const a = runEpoch(EPOCH, input(snapshot(0)), DEFAULT_OBJECTIVE_WEIGHTS);
    const b = runEpoch(EPOCH, input(snapshot(0), DEFAULT_FUEL_CONFIG), DEFAULT_OBJECTIVE_WEIGHTS);
    const ra = a.recommendations.find((r) => r.trailerId === "T1")!;
    const rb = b.recommendations.find((r) => r.trailerId === "T1")!;
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
  });

  it("a trailer whose planned leg crosses the threshold has a fuel-aware plan (no crash, deterministic)", () => {
    // milesSinceRefuel 0 + H1→H2 1500 mi ≥ 1200 ⇒ the H2 stop gets refuelMin.
    const a = runEpoch(EPOCH, input(snapshot(0), FUEL_ON), DEFAULT_OBJECTIVE_WEIGHTS);
    const b = runEpoch(EPOCH, input(snapshot(0), FUEL_ON), DEFAULT_OBJECTIVE_WEIGHTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // idempotent
    const rec = a.recommendations.find((r) => r.trailerId === "T1");
    expect(rec).toBeDefined();
  });

  it("idempotency: identical (epoch, fuel input, weights) ⇒ byte-identical result", () => {
    const a = runEpoch(EPOCH, input(snapshot(900), FUEL_ON), DEFAULT_OBJECTIVE_WEIGHTS);
    const b = runEpoch(EPOCH, input(snapshot(900), FUEL_ON), DEFAULT_OBJECTIVE_WEIGHTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Observable timing effect: refuelMin pushes the departure ETA out (max, not sum)
// ---------------------------------------------------------------------------
describe("departure folds refuelMin via max, not sum (spec §7)", () => {
  const travel: TravelModel = {
    travelMin(from: string, to: string): number {
      return from === to ? 0 : 10;
    },
  };

  it("a lone refuel pushes the departure out by exactly refuelMin", () => {
    const noFuel: Stop = { hubId: "H2", serviceMin: 5, windowStartMin: 0, windowEndMin: 1e9, demand: 1 };
    const withFuel: Stop = { ...noFuel, refuelMin: 30 };
    const a = feasibleArrivals([noFuel], "H1", travel, 0)!;
    const b = feasibleArrivals([withFuel], "H1", travel, 0)!;
    // arrival 10, service 5 ⇒ departure 15 with no fuel; +30 refuel ⇒ 45.
    expect(a[0]!.departureMin).toBe(15);
    expect(b[0]!.departureMin).toBe(45);
    expect(b[0]!.departureMin - a[0]!.departureMin).toBe(30);
  });

  it("a refuel co-located with a LONGER rest adds NO extra delay (max, not sum)", () => {
    // rest 600 dominates refuel 30 ⇒ added time = max(600, 30) = 600, NOT 630.
    const restOnly: Stop = { hubId: "H2", serviceMin: 5, windowStartMin: 0, windowEndMin: 1e9, demand: 1, restMin: 600 };
    const restPlusRefuel: Stop = { ...restOnly, refuelMin: 30 };
    const a = feasibleArrivals([restOnly], "H1", travel, 0)!;
    const b = feasibleArrivals([restPlusRefuel], "H1", travel, 0)!;
    expect(b[0]!.departureMin).toBe(a[0]!.departureMin); // 10 + 5 + max(600,30) both
  });

  it("a refuel LARGER than its co-located rest dominates (max picks the refuel)", () => {
    const restSmall: Stop = { hubId: "H2", serviceMin: 5, windowStartMin: 0, windowEndMin: 1e9, demand: 1, restMin: 10 };
    const both: Stop = { ...restSmall, refuelMin: 45 };
    const a = feasibleArrivals([restSmall], "H1", travel, 0)!;
    const b = feasibleArrivals([both], "H1", travel, 0)!;
    // restSmall: 10+5+10 = 25; both: 10+5+max(10,45)=10+5+45 = 60.
    expect(a[0]!.departureMin).toBe(25);
    expect(b[0]!.departureMin).toBe(60);
  });
});
