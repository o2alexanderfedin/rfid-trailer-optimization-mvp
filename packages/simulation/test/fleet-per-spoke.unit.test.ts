/**
 * fleetPerSpoke — the demo-richness knob that puts MORE trucks on the map at once.
 *
 * Keystone: the DEFAULT (1) must be byte-identical to omitting the option, so the
 * pre-fleet determinism goldens are untouched. N>1 seeds spokes×N trailers (one
 * primary driver each), scales the package volume + relay spare pool by N, and is
 * still fully deterministic per (seed, N).
 */
import { describe, expect, it } from "vitest";
import { simulate, type SimulatedEvent } from "../src/engine.js";

/** Distinct trailerIds that ever depart in a stream. */
function departedTrailerIds(stream: readonly SimulatedEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of stream) {
    if (e.event.type === "TrailerDeparted") ids.add(e.event.payload.trailerId);
  }
  return ids;
}

const SPOKES = 9; // USA_HUBS = 1 center (MEM) + 9 spokes.

describe("fleetPerSpoke", () => {
  it("defaults to one trailer per spoke", () => {
    const ids = departedTrailerIds(simulate({ seed: 4242, durationTicks: 200 }));
    expect(ids.size).toBe(SPOKES);
  });

  it("fleetPerSpoke=2 runs 2× the trailers (one primary driver each)", () => {
    const stream = simulate({ seed: 4242, durationTicks: 400, fleetPerSpoke: 2 });
    expect(departedTrailerIds(stream).size).toBe(SPOKES * 2);
  });

  it("fleetPerSpoke=1 is byte-identical to omitting the option (golden keystone)", () => {
    const omitted = simulate({ seed: 4242, durationTicks: 300 });
    const explicitOne = simulate({ seed: 4242, durationTicks: 300, fleetPerSpoke: 1 });
    expect(JSON.stringify(explicitOne)).toBe(JSON.stringify(omitted));
  });

  it("is deterministic for a given (seed, fleetPerSpoke)", () => {
    const a = simulate({ seed: 4242, durationTicks: 300, fleetPerSpoke: 3 });
    const b = simulate({ seed: 4242, durationTicks: 300, fleetPerSpoke: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("HOS-off emits NO driver events even with a larger fleet (determinism keystone)", () => {
    const stream = simulate({ seed: 4242, durationTicks: 300, fleetPerSpoke: 3 });
    const driverEvents = stream.filter((e) => e.event.type.startsWith("Driver"));
    expect(driverEvents).toHaveLength(0);
  });

  it("HOS-on seeds one primary driver per trailer", () => {
    const stream = simulate({
      seed: 4242,
      durationTicks: 200,
      fleetPerSpoke: 2,
      hosEnabled: true,
    });
    const registered = new Set<string>();
    for (const e of stream) {
      if (e.event.type === "DriverRegistered") registered.add(e.event.payload.driverId);
    }
    // Primary roster (one per trailer = SPOKES×2) PLUS the scaled spare pool, so
    // there is at least one primary driver per trailer.
    expect(registered.size).toBeGreaterThanOrEqual(SPOKES * 2);
  });
});
