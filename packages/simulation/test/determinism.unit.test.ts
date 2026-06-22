import { describe, expect, it } from "vitest";
import { validateEvent } from "@mm/domain";
import { simulate } from "../src/engine.js";

/**
 * SIM-02 — THE DETERMINISM KEYSTONE.
 *
 * The pure generator `simulate({ seed, durationTicks })` returns a
 * `SimulatedEvent[]` with NO database and NO wall-clock/RNG ambient state. Two
 * runs with the same seed MUST be byte-identical (order, payloads, occurredAt);
 * a different seed MUST differ. Every emitted event must pass the domain
 * `validateEvent` boundary, and timestamps must be non-decreasing.
 */

// TIME-01: transit medians are now per-leg, derived from real great-circle
// distance (≈400 min for the shortest spoke leg, ≈2250 min for the longest), so
// the horizon must be long enough for trailers to actually ARRIVE and re-dispatch
// — a 240-tick (4-hour) run no longer completes even the shortest leg.
const OPTS = { seed: 1234, durationTicks: 6000 } as const;

describe("deterministic event stream (SIM-02)", () => {
  it("same seed -> byte-identical stream (deep-equal incl. order + occurredAt)", () => {
    const a = simulate(OPTS);
    const b = simulate({ ...OPTS });
    expect(b).toEqual(a);
    // And byte-identical when JSON-serialized (the literal "byte" assertion).
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("different seed -> different stream", () => {
    const a = simulate({ seed: 1, durationTicks: 240 });
    const b = simulate({ seed: 2, durationTicks: 240 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("emits a non-trivial number of events", () => {
    const events = simulate(OPTS);
    expect(events.length).toBeGreaterThan(50);
  });

  it("every emitted event passes the domain validateEvent boundary", () => {
    for (const item of simulate(OPTS)) {
      expect(() => validateEvent(item.event)).not.toThrow();
    }
  });

  it("opens with HubRegistered + RouteRegistered bootstrap, then operational events", () => {
    const events = simulate(OPTS);
    const types = events.map((e) => e.event.type);
    expect(types).toContain("HubRegistered");
    expect(types).toContain("RouteRegistered");
    expect(types).toContain("PackageCreated");
    expect(types).toContain("PackageScanned");
    expect(types).toContain("PackageArrivedAtHub");
    expect(types).toContain("TrailerDeparted");
    expect(types).toContain("TrailerArrivedAtHub");
    expect(types).toContain("TrailerDocked");

    // All 10 hubs + all routes are registered before any operational event.
    const firstOperational = types.findIndex(
      (t) => t !== "HubRegistered" && t !== "RouteRegistered",
    );
    const bootstrap = types.slice(0, firstOperational);
    expect(bootstrap.filter((t) => t === "HubRegistered").length).toBe(10);
    expect(bootstrap.every((t) => t === "HubRegistered" || t === "RouteRegistered")).toBe(true);
  });

  it("emits events in non-decreasing occurredAt (virtual-clock ordering)", () => {
    const events = simulate(OPTS);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.occurredAt >= events[i - 1]!.occurredAt).toBe(true);
    }
  });

  it("every event has a stream id matching its entity", () => {
    for (const { streamId, event } of simulate(OPTS)) {
      expect(streamId.length).toBeGreaterThan(0);
      switch (event.type) {
        case "HubRegistered":
          expect(streamId).toBe(`hub-${event.payload.hubId}`);
          break;
        case "RouteRegistered":
          expect(streamId).toBe(`route-${event.payload.routeId}`);
          break;
        case "PackageCreated":
        case "PackageScanned":
        case "PackageArrivedAtHub":
          expect(streamId).toBe(`package-${event.payload.packageId}`);
          break;
        case "TrailerDeparted":
        case "TrailerArrivedAtHub":
        case "TrailerDocked":
          expect(streamId).toBe(`trailer-${event.payload.trailerId}`);
          break;
      }
    }
  });

  it("occurredAt comes from the virtual clock (valid ISO, never the wall clock)", () => {
    for (const { occurredAt } of simulate(OPTS)) {
      expect(occurredAt).toBe(new Date(occurredAt).toISOString());
    }
  });
});
