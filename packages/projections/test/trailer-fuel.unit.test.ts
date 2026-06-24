import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  emptyTrailerFuelState,
  getTrailerMiles,
  trailerFuelReducer,
  type OccurredEvent,
  type TrailerFuelState,
} from "../src/index.js";

/** Read a trailer's milesSinceRefuel through the public accessor. */
const milesOf = (state: TrailerFuelState, id: string): number => getTrailerMiles(state, id);

/**
 * SP2 Task 3 — `milesSinceRefuel` per trailer for the planning twin (spec §6/§7).
 *
 * A small PURE reducer (the same `(state, OccurredEvent) => state` contract as the
 * other operational projections): a trailer's miles-since-last-refuel accrues by
 * each completed leg's distance and RESETS to 0 on a `TruckRefueled`. The twin
 * snapshot builder reads it into `TwinTrailer.milesSinceRefuel` so the optimizer
 * is fuel-aware. Determinism (P3): per-leg miles come from the SAME logged route
 * geometry the sim/optimizer derive distance from — folded from `RouteRegistered`
 * — never a wall clock or RNG.
 */

let seq = 0;
function occ(event: DomainEvent, occurredAt = "2026-04-01T00:00:00.000Z"): OccurredEvent {
  seq += 1;
  return { event, occurredAt };
}

function routeRegistered(from: string, to: string, geometry: [number, number][]): DomainEvent {
  return {
    type: "RouteRegistered",
    schemaVersion: 1,
    payload: { routeId: `route-${from}-${to}`, fromHubId: from, toHubId: to, geometry },
  };
}
function departed(trailerId: string, from: string, to: string, tripId: string): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId: from, toHubId: to, tripId, packageIds: [] },
  };
}
function arrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return { type: "TrailerArrivedAtHub", schemaVersion: 1, payload: { trailerId, hubId, tripId } };
}
function refueled(trailerId: string, tripId: string, odometerMiles: number): DomainEvent {
  return {
    type: "TruckRefueled",
    schemaVersion: 1,
    payload: { trailerId, tripId, gallons: 100, odometerMiles, durationMin: 30, occurredAt: "x" },
  };
}

function fold(events: OccurredEvent[]): ReturnType<typeof trailerFuelReducer> {
  let state = emptyTrailerFuelState;
  for (const e of events) state = trailerFuelReducer(state, e);
  return state;
}

// Two hubs ~1 degree of longitude apart at the equator ≈ 69.1 mi (haversine·0.621).
const A: [number, number] = [0, 0];
const B: [number, number] = [1, 0];

describe("trailerFuelReducer — milesSinceRefuel accrual + reset (spec §6)", () => {
  it("starts empty (a trailer with no events has no row)", () => {
    expect(emptyTrailerFuelState.size).toBe(0);
  });

  it("accrues the leg distance on TrailerArrivedAtHub (route geometry → miles)", () => {
    const state = fold([
      occ(routeRegistered("A", "B", [A, B])),
      occ(departed("T1", "A", "B", "TRIP1")),
      occ(arrived("T1", "B", "TRIP1")),
    ]);
    const miles = milesOf(state, "T1");
    expect(miles).toBeGreaterThan(60); // ~69 mi
    expect(miles).toBeLessThan(75);
  });

  it("accumulates across multiple legs", () => {
    const state = fold([
      occ(routeRegistered("A", "B", [A, B])),
      occ(routeRegistered("B", "A", [B, A])),
      occ(departed("T1", "A", "B", "TRIP1")),
      occ(arrived("T1", "B", "TRIP1")),
      occ(departed("T1", "B", "A", "TRIP2")),
      occ(arrived("T1", "A", "TRIP2")),
    ]);
    const miles = milesOf(state, "T1");
    expect(miles).toBeGreaterThan(130); // ~2 × 69 mi
  });

  it("resets milesSinceRefuel to 0 on TruckRefueled", () => {
    const state = fold([
      occ(routeRegistered("A", "B", [A, B])),
      occ(departed("T1", "A", "B", "TRIP1")),
      occ(arrived("T1", "B", "TRIP1")),
      occ(refueled("T1", "TRIP1", 1200)),
    ]);
    expect(milesOf(state, "T1")).toBe(0);
  });

  it("accrues again after a reset (refuel does not stop the odometer)", () => {
    const state = fold([
      occ(routeRegistered("A", "B", [A, B])),
      occ(routeRegistered("B", "A", [B, A])),
      occ(departed("T1", "A", "B", "TRIP1")),
      occ(arrived("T1", "B", "TRIP1")),
      occ(refueled("T1", "TRIP1", 69)),
      occ(departed("T1", "B", "A", "TRIP2")),
      occ(arrived("T1", "A", "TRIP2")),
    ]);
    const miles = milesOf(state, "T1");
    expect(miles).toBeGreaterThan(60);
    expect(miles).toBeLessThan(75); // only the post-refuel leg counts
  });

  it("a zero-distance leg (coincident hubs) accrues 0 miles", () => {
    const state = fold([
      occ(routeRegistered("A", "A2", [A, A])),
      occ(departed("T1", "A", "A2", "TRIP1")),
      occ(arrived("T1", "A2", "TRIP1")),
    ]);
    expect(milesOf(state, "T1")).toBe(0);
  });

  it("is pure: re-folding the same events yields the same state", () => {
    const events = [
      occ(routeRegistered("A", "B", [A, B])),
      occ(departed("T1", "A", "B", "TRIP1")),
      occ(arrived("T1", "B", "TRIP1")),
    ];
    const a = fold(events);
    const b = fold(events);
    expect(milesOf(a, "T1")).toBe(milesOf(b, "T1"));
  });

  it("an unknown leg (no RouteRegistered geometry) accrues 0 (fail-soft)", () => {
    const state = fold([
      occ(departed("T1", "X", "Y", "TRIP1")),
      occ(arrived("T1", "Y", "TRIP1")),
    ]);
    expect(milesOf(state, "T1")).toBe(0);
  });
});
