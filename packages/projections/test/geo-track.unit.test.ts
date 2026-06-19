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
 * M-4 (geo-track): the ARRIVAL keyframe must be resolved by the trailer's ACTUAL
 * leg (from the trip context recorded at departure), NOT by a lexicographic guess
 * over all legs whose key ends in `->hubId`. When a hub has 2+ inbound legs with
 * DISTINCT terminal vertices, the arrive point must land on the leg the trip
 * actually travelled.
 *
 * These are pure-reducer tests (no DB). They fold a hand-built stored-event list
 * and assert the emitted keyframes.
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
function departed(
  trailerId: string,
  from: string,
  to: string,
  tripId: string,
  packageIds: string[] = [],
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId: from, toHubId: to, tripId, packageIds },
  };
}
function trailerArrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return { type: "TrailerArrivedAtHub", schemaVersion: 1, payload: { trailerId, hubId, tripId } };
}

/** Fold a stored-event list, collecting every emitted keyframe. */
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

describe("geoTrackReducer arrival-leg resolution (M-4)", () => {
  // Two inbound legs into ZZZ with DISTINCT terminal vertices.
  const LEG_A: LonLat[] = [
    [-100, 40],
    [-95, 38], // AAA->ZZZ ends here
  ];
  const LEG_B: LonLat[] = [
    [-80, 30],
    [-85, 32], // BBB->ZZZ ends here (different terminal vertex)
  ];

  it("resolves the arrive keyframe by the trip's actual leg, not the lexicographically-smallest", () => {
    const { keyframes } = foldGeo([
      stored(routeRegistered("AAA", "ZZZ", LEG_A), at(0)),
      stored(routeRegistered("BBB", "ZZZ", LEG_B), at(0)),
      // The trailer travels the BBB->ZZZ leg (lexicographically LARGER key).
      stored(departed("T1", "BBB", "ZZZ", "TRIP1"), at(1_000)),
      stored(trailerArrived("T1", "ZZZ", "TRIP1"), at(2_000)),
    ]);

    const arrive = keyframes.find((k) => k.kind === "arrive" && k.tripId === "TRIP1");
    expect(arrive).toBeDefined();
    // Must be the LAST vertex of BBB->ZZZ, NOT AAA->ZZZ.
    expect([arrive!.lon, arrive!.lat]).toEqual(LEG_B[LEG_B.length - 1]);
    expect([arrive!.lon, arrive!.lat]).not.toEqual(LEG_A[LEG_A.length - 1]);
  });

  it("depart keyframe sits at the trip's origin (first vertex of the actual leg)", () => {
    const { keyframes } = foldGeo([
      stored(routeRegistered("AAA", "ZZZ", LEG_A), at(0)),
      stored(routeRegistered("BBB", "ZZZ", LEG_B), at(0)),
      stored(departed("T1", "BBB", "ZZZ", "TRIP1"), at(1_000)),
      stored(trailerArrived("T1", "ZZZ", "TRIP1"), at(2_000)),
    ]);
    const depart = keyframes.find((k) => k.kind === "depart" && k.tripId === "TRIP1");
    expect([depart!.lon, depart!.lat]).toEqual(LEG_B[0]);
  });

  it("two trailers arriving at the same hub via different legs each land on their own leg", () => {
    const { keyframes } = foldGeo([
      stored(routeRegistered("AAA", "ZZZ", LEG_A), at(0)),
      stored(routeRegistered("BBB", "ZZZ", LEG_B), at(0)),
      stored(departed("T1", "AAA", "ZZZ", "TRIP-A"), at(1_000)),
      stored(departed("T2", "BBB", "ZZZ", "TRIP-B"), at(1_000)),
      stored(trailerArrived("T1", "ZZZ", "TRIP-A"), at(2_000)),
      stored(trailerArrived("T2", "ZZZ", "TRIP-B"), at(2_000)),
    ]);
    const a = keyframes.find((k) => k.kind === "arrive" && k.tripId === "TRIP-A")!;
    const b = keyframes.find((k) => k.kind === "arrive" && k.tripId === "TRIP-B")!;
    expect([a.lon, a.lat]).toEqual(LEG_A[LEG_A.length - 1]);
    expect([b.lon, b.lat]).toEqual(LEG_B[LEG_B.length - 1]);
  });
});
