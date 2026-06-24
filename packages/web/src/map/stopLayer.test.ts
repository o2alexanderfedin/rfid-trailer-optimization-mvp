import { describe, expect, it } from "vitest";
import Point from "ol/geom/Point.js";
import { createTrailerStopLayer, applyTrailerStops } from "./layers.js";
import type { TrailerStop } from "@mm/api";

/**
 * SP2 Task 6 — the parked/refueling STOP layer (spec §8). A trailer at a `rested`
 * or `refueling` stop renders a STATIONARY marker at the stop's interpolated
 * position (no tween during the stop); the marker is removed when the stop set no
 * longer includes it. The marker is keyed by `(trailerId, tripId, startMs)` so a
 * trailer can show distinct stops over its trip without collision.
 */

function stop(over: Partial<TrailerStop> = {}): TrailerStop {
  return {
    trailerId: "T1",
    tripId: "TRIP1",
    kind: "rested",
    lon: -90,
    lat: 35,
    startMs: 1000,
    durationMinutes: 600,
    ...over,
  };
}

describe("trailer-stop layer (spec §8)", () => {
  it("renders one STATIONARY marker feature per stop at its interpolated position", () => {
    const { source } = createTrailerStopLayer();
    applyTrailerStops(source, [stop({ kind: "rested" }), stop({ kind: "refueling", startMs: 2000 })]);
    expect(source.getFeatures().length).toBe(2);
    const f = source.getFeatures()[0]!;
    const geom = f.getGeometry();
    expect(geom).toBeInstanceOf(Point);
    // The feature carries its kind so the StyleFunction colors it distinctly.
    expect(["rested", "refueling"]).toContain(f.get("kind"));
  });

  it("a stationary marker is NOT moved between renders (no tween while parked)", () => {
    const { source } = createTrailerStopLayer();
    applyTrailerStops(source, [stop()]);
    const f = source.getFeatures()[0]!;
    const before = (f.getGeometry() as Point).getCoordinates();
    applyTrailerStops(source, [stop()]); // same stop again
    const after = (f.getGeometry() as Point).getCoordinates();
    expect(after).toEqual(before); // unchanged — the parked marker holds position
  });

  it("removes a stop marker once the stop set no longer includes it (stop finished)", () => {
    const { source } = createTrailerStopLayer();
    applyTrailerStops(source, [stop({ startMs: 1000 }), stop({ startMs: 2000, kind: "refueling" })]);
    expect(source.getFeatures().length).toBe(2);
    // Next snapshot: only the second stop remains active.
    applyTrailerStops(source, [stop({ startMs: 2000, kind: "refueling" })]);
    expect(source.getFeatures().length).toBe(1);
    expect(source.getFeatures()[0]!.get("startMs")).toBe(2000);
  });

  it("an empty stop set clears all parked markers", () => {
    const { source } = createTrailerStopLayer();
    applyTrailerStops(source, [stop()]);
    expect(source.getFeatures().length).toBe(1);
    applyTrailerStops(source, []);
    expect(source.getFeatures().length).toBe(0);
  });
});
