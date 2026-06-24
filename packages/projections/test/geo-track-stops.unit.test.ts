import { describe, expect, it } from "vitest";
import type { DomainEvent, LonLat } from "@mm/domain";
import {
  emptyGeoTrackState,
  type GeoKeyframe,
  type GeoTrackState,
  geoTrackReducer,
  type StoredEventLike,
} from "../src/index.js";

/**
 * SP2 Task 3 — geo-track `rested` / `refueling` stop keyframes (spec §6).
 *
 * On `TruckRested` / `TruckRefueled` the geo-track reducer emits a keyframe at the
 * INTERPOLATED route position for the stop's `occurredAt` — the fraction along the
 * in-flight leg geometry between the `depart` keyframe time and the leg's expected
 * arrival. It carries `durationMinutes` so the client parks the marker for the
 * stop's length, and a key that lets a stop COEXIST with depart/arrive (no
 * overwrite). Determinism (P3): positions are a pure function of logged geometry +
 * `occurredAt` (no clock, no RNG), so a rebuild is byte-identical to the live run.
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

let seq = 0n;
function stored(event: DomainEvent, occurredAt: string): StoredEventLike {
  seq += 1n;
  return { globalSeq: seq, event, occurredAt };
}

function routeRegistered(from: string, to: string, geometry: LonLat[]): DomainEvent {
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
function rested(trailerId: string, tripId: string, durationMin: number, occAt: string): DomainEvent {
  return {
    type: "TruckRested",
    schemaVersion: 1,
    payload: { trailerId, tripId, reason: "rest-10h", durationMin, occurredAt: occAt },
  };
}
function refueled(trailerId: string, tripId: string, durationMin: number, occAt: string): DomainEvent {
  return {
    type: "TruckRefueled",
    schemaVersion: 1,
    payload: { trailerId, tripId, gallons: 100, odometerMiles: 1200, durationMin, occurredAt: occAt },
  };
}

function foldGeo(events: StoredEventLike[]): {
  state: GeoTrackState;
  keyframes: GeoKeyframe[];
} {
  let state = emptyGeoTrackState;
  const keyframes: GeoKeyframe[] = [];
  for (const e of events) {
    const step = geoTrackReducer(state, e);
    state = step.state;
    keyframes.push(...step.keyframes);
  }
  return { state, keyframes };
}

// A straight east-west leg from A to B (10 degrees of longitude at the equator).
const A: LonLat = [0, 0];
const B: LonLat = [10, 0];

describe("geoTrackReducer — rested/refueling stop keyframes (spec §6)", () => {
  it("emits a `rested` keyframe at an INTERPOLATED mid-leg position", () => {
    const { keyframes } = foldGeo([
      stored(routeRegistered("A", "B", [A, B]), at(0)),
      stored(departed("T1", "A", "B", "TRIP1"), at(0)),
      // The rest occurs partway along the leg (deterministic mid-leg occurredAt).
      stored(rested("T1", "TRIP1", 600, at(30 * 60_000)), at(30 * 60_000)),
    ]);
    const k = keyframes.find((kf) => kf.kind === "rested");
    expect(k).toBeDefined();
    // The interpolated lon must be strictly BETWEEN the leg endpoints (mid-route).
    expect(k!.lon).toBeGreaterThan(A[0]);
    expect(k!.lon).toBeLessThan(B[0]);
    // Latitude stays on the leg (≈0 for an east-west line).
    expect(Math.abs(k!.lat)).toBeLessThan(0.001);
    // The stop carries its duration (so the client parks the marker).
    expect(k!.durationMinutes).toBe(600);
    expect(k!.trailerId).toBe("T1");
    expect(k!.tripId).toBe("TRIP1");
  });

  it("emits a `refueling` keyframe carrying its refuel durationMinutes", () => {
    const { keyframes } = foldGeo([
      stored(routeRegistered("A", "B", [A, B]), at(0)),
      stored(departed("T1", "A", "B", "TRIP1"), at(0)),
      stored(refueled("T1", "TRIP1", 30, at(20 * 60_000)), at(20 * 60_000)),
    ]);
    const k = keyframes.find((kf) => kf.kind === "refueling");
    expect(k).toBeDefined();
    expect(k!.durationMinutes).toBe(30);
    expect(k!.lon).toBeGreaterThan(A[0]);
    expect(k!.lon).toBeLessThan(B[0]);
  });

  it("a stop keyframe does NOT overwrite the trip's depart/arrive keyframes (distinct key)", () => {
    const { keyframes } = foldGeo([
      stored(routeRegistered("A", "B", [A, B]), at(0)),
      stored(departed("T1", "A", "B", "TRIP1"), at(0)),
      stored(rested("T1", "TRIP1", 600, at(30 * 60_000)), at(30 * 60_000)),
      stored(refueled("T1", "TRIP1", 30, at(40 * 60_000)), at(40 * 60_000)),
      stored(arrived("T1", "B", "TRIP1"), at(60 * 60_000)),
    ]);
    // All four kinds are present for the same trip — none collides with another.
    const kinds = keyframes.filter((k) => k.tripId === "TRIP1").map((k) => k.kind).sort();
    expect(kinds).toEqual(["arrive", "depart", "rested", "refueling"].sort());
    // The depart keyframe still sits at the leg origin (never clobbered by a stop).
    const dep = keyframes.find((k) => k.kind === "depart" && k.tripId === "TRIP1")!;
    expect([dep.lon, dep.lat]).toEqual(A);
    const arr = keyframes.find((k) => k.kind === "arrive" && k.tripId === "TRIP1")!;
    expect([arr.lon, arr.lat]).toEqual(B);
  });

  it("two stops on the SAME leg get distinct keys (both survive, keyed by occurredAt)", () => {
    const { keyframes } = foldGeo([
      stored(routeRegistered("A", "B", [A, B]), at(0)),
      stored(departed("T1", "A", "B", "TRIP1"), at(0)),
      stored(rested("T1", "TRIP1", 30, at(10 * 60_000)), at(10 * 60_000)),
      stored(rested("T1", "TRIP1", 600, at(40 * 60_000)), at(40 * 60_000)),
    ]);
    const rests = keyframes.filter((k) => k.kind === "rested" && k.tripId === "TRIP1");
    expect(rests.length).toBe(2);
    // The later rest is farther along the leg than the earlier one.
    const sorted = [rests[0]!, rests[1]!].sort((a, b) => a.lon - b.lon);
    expect(sorted[1]!.lon).toBeGreaterThan(sorted[0]!.lon);
  });

  it("a stop for a trip with NO departure/route yields no keyframe (fail-soft)", () => {
    const { keyframes } = foldGeo([
      stored(rested("T1", "TRIP-UNKNOWN", 600, at(10 * 60_000)), at(10 * 60_000)),
    ]);
    expect(keyframes.filter((k) => k.kind === "rested")).toHaveLength(0);
  });

  it("depart/arrive keyframes still carry no durationMinutes (additive, back-compat)", () => {
    const { keyframes } = foldGeo([
      stored(routeRegistered("A", "B", [A, B]), at(0)),
      stored(departed("T1", "A", "B", "TRIP1"), at(0)),
      stored(arrived("T1", "B", "TRIP1"), at(60 * 60_000)),
    ]);
    for (const k of keyframes) {
      if (k.kind === "depart" || k.kind === "arrive") {
        expect(k.durationMinutes).toBeUndefined();
      }
    }
  });

  it("is deterministic: identical event lists ⇒ byte-identical keyframes", () => {
    const events = (): StoredEventLike[] => {
      seq = 0n;
      return [
        stored(routeRegistered("A", "B", [A, B]), at(0)),
        stored(departed("T1", "A", "B", "TRIP1"), at(0)),
        stored(rested("T1", "TRIP1", 600, at(30 * 60_000)), at(30 * 60_000)),
      ];
    };
    const a = foldGeo(events()).keyframes;
    const b = foldGeo(events()).keyframes;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
