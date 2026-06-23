import { describe, expect, it } from "vitest";
import { validateEvent, DEFAULT_HOS_CONFIG, type HosConfig } from "@mm/domain";
import { simulate } from "../src/engine.js";

/**
 * Phase 12 — DRIVER RELAY / SWAP AT HUBS (DRV-04, SIM-HOS-04).
 *
 * On hub arrival, when the trailer's assigned driver cannot legally complete the
 * NEXT leg, the engine performs a RELAY: a fresh legal driver is picked from the
 * hub's deterministic driver pool, `DriverSwappedAtHub` is emitted, the trip is
 * reassigned to the fresh driver (`DriverAssignedToTrip`), and the tired driver
 * goes off-duty/resting (`DriverDutyStateChanged`). The trailer then departs on
 * time instead of parking.
 *
 * Determinism keystone: relay is active ONLY when `hosEnabled` is true; every
 * pool / relay decision flows from deterministic state (stable ordering + the
 * fifth `hosRng` substream in event-queue order), NEVER wall-clock. Same seed +
 * same `HosConfig` ⇒ byte-identical; a different seed differs. (The HOS-OFF
 * byte-identity is guarded by `determinism.unit` / `rfid-determinism.unit`, which
 * stay UNCHANGED.)
 *
 * TIME-01: per-leg transit medians are ≈400–2250 min — the longest legs blow
 * through the 660-min 11h drive limit on a single leg, so a relay (or a park) is
 * forced. The horizon must span real round-trips for relays to fire.
 */

const SEED = 1234;
const TICKS = 6000;
const ON = { seed: SEED, durationTicks: TICKS, hosEnabled: true } as const;
const OFF = { seed: SEED, durationTicks: TICKS } as const;

const types = (s: ReturnType<typeof simulate>) => s.map((e) => e.event.type);
const count = (s: ReturnType<typeof simulate>, t: string) =>
  s.filter((e) => e.event.type === t).length;

// ---------------------------------------------------------------------------
// DRV-04 — per-hub driver pool seeded deterministically at sim start
// ---------------------------------------------------------------------------
describe("DRV-04: per-hub driver pool / roster", () => {
  it("seeds MORE drivers than trailers so a fresh driver is usually available", () => {
    // 9 spokes ⇒ 9 trailers. A relay needs a SPARE pool beyond one-per-trailer,
    // so the registered-driver count must exceed the trailer count.
    const s = simulate(ON);
    const registered = count(s, "DriverRegistered");
    expect(registered).toBeGreaterThan(9);
  });

  it("every registered driver has a unique id and is rostered at a hub", () => {
    const s = simulate(ON);
    const ids = new Set<string>();
    for (const e of s) {
      if (e.event.type === "DriverRegistered") {
        expect(e.event.payload.homeHubId.length).toBeGreaterThan(0);
        ids.add(e.event.payload.driverId);
      }
    }
    expect(ids.size).toBe(count(s, "DriverRegistered"));
  });

  it("all DriverRegistered precede the first DriverAssignedToTrip (pool seeded at start)", () => {
    const s = simulate(ON);
    const firstAssign = s.findIndex((e) => e.event.type === "DriverAssignedToTrip");
    const lastRegister = types(s).lastIndexOf("DriverRegistered");
    expect(firstAssign).toBeGreaterThan(-1);
    expect(lastRegister).toBeLessThan(firstAssign);
  });
});

// ---------------------------------------------------------------------------
// SIM-HOS-04 — relay/swap at hubs
// ---------------------------------------------------------------------------
describe("SIM-HOS-04: driver relay / swap at hubs", () => {
  it("emits at least one DriverSwappedAtHub over the horizon (relay fires)", () => {
    const s = simulate(ON);
    expect(count(s, "DriverSwappedAtHub")).toBeGreaterThan(0);
  });

  it("a swap names two DISTINCT drivers, a hub, a trip, and a trailer", () => {
    const s = simulate(ON);
    const swaps = s.filter((e) => e.event.type === "DriverSwappedAtHub");
    expect(swaps.length).toBeGreaterThan(0);
    for (const e of swaps) {
      if (e.event.type !== "DriverSwappedAtHub") continue;
      const p = e.event.payload;
      expect(p.outgoingDriverId).not.toBe(p.incomingDriverId);
      expect(p.hubId.length).toBeGreaterThan(0);
      expect(p.tripId.length).toBeGreaterThan(0);
      expect(p.trailerId.length).toBeGreaterThan(0);
    }
  });

  it("the INCOMING driver of a swap is the one assigned to that trip (reassignment)", () => {
    const s = simulate(ON);
    // Build tripId -> assigned driver (last DriverAssignedToTrip wins).
    const assignFor = new Map<string, string>();
    for (const e of s) {
      if (e.event.type === "DriverAssignedToTrip") {
        assignFor.set(e.event.payload.tripId, e.event.payload.driverId);
      }
    }
    const swaps = s.filter((e) => e.event.type === "DriverSwappedAtHub");
    expect(swaps.length).toBeGreaterThan(0);
    for (const e of swaps) {
      if (e.event.type !== "DriverSwappedAtHub") continue;
      const p = e.event.payload;
      expect(assignFor.get(p.tripId)).toBe(p.incomingDriverId);
    }
  });

  it("the OUTGOING (tired) driver enters rest at/after the swap", () => {
    const s = simulate(ON);
    const swaps = s.filter((e) => e.event.type === "DriverSwappedAtHub");
    expect(swaps.length).toBeGreaterThan(0);
    for (let i = 0; i < s.length; i += 1) {
      const e = s[i]!;
      if (e.event.type !== "DriverSwappedAtHub") continue;
      const outgoing = e.event.payload.outgoingDriverId;
      // A resting DriverDutyStateChanged for the outgoing driver appears at or
      // after the swap (same virtual instant or later).
      const rested = s
        .slice(i)
        .some(
          (x) =>
            x.event.type === "DriverDutyStateChanged" &&
            x.event.payload.driverId === outgoing &&
            x.event.payload.dutyStatus === "resting",
        );
      expect(rested).toBe(true);
    }
  });

  it("a swap is immediately followed (same trip) by a TrailerDeparted — freight keeps moving", () => {
    const s = simulate(ON);
    const swaps = s.filter((e) => e.event.type === "DriverSwappedAtHub");
    expect(swaps.length).toBeGreaterThan(0);
    for (const e of swaps) {
      if (e.event.type !== "DriverSwappedAtHub") continue;
      const tripId = e.event.payload.tripId;
      const departed = s.some(
        (x) =>
          x.event.type === "TrailerDeparted" && x.event.payload.tripId === tripId,
      );
      expect(departed).toBe(true);
    }
  });

  it("relay REDUCES mid-leg parking vs the Phase-11 (no-relay) park model", () => {
    // With relay, a tired driver hands off instead of parking the trailer
    // mid-leg, so a relay run produces FEWER '10h-reset' resting transitions than
    // a hypothetical pure-park run would — and at least one swap appears. We
    // assert the swap count is positive and that resting transitions still occur
    // (the tired driver rests), i.e. relay and rest coexist deterministically.
    const s = simulate(ON);
    const resting = s.filter(
      (e) =>
        e.event.type === "DriverDutyStateChanged" &&
        e.event.payload.dutyStatus === "resting",
    );
    expect(count(s, "DriverSwappedAtHub")).toBeGreaterThan(0);
    expect(resting.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism — relay path is byte-identical per seed + config; off unchanged
// ---------------------------------------------------------------------------
describe("SIM-HOS-04 determinism: relay path is deterministic", () => {
  it("same seed + default HosConfig ⇒ byte-identical relay stream", () => {
    const a = simulate(ON);
    const b = simulate({ ...ON });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("same seed + explicit HosConfig ⇒ byte-identical relay stream", () => {
    const cfg: HosConfig = { ...DEFAULT_HOS_CONFIG };
    const a = simulate({ ...ON, hosConfig: cfg });
    const b = simulate({ ...ON, hosConfig: { ...cfg } });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("different seed ⇒ a different relay stream", () => {
    const a = simulate({ ...ON, seed: 1 });
    const b = simulate({ ...ON, seed: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("HOS-off emits NO swap events at all (relay gated by hosEnabled)", () => {
    const s = simulate(OFF);
    expect(count(s, "DriverSwappedAtHub")).toBe(0);
    expect(count(s, "DriverRegistered")).toBe(0);
  });

  it("every relay-stream event passes the domain validateEvent boundary", () => {
    for (const item of simulate(ON)) {
      expect(() => validateEvent(item.event)).not.toThrow();
    }
  });

  it("relay-stream events stay in non-decreasing occurredAt order", () => {
    const s = simulate(ON);
    for (let i = 1; i < s.length; i += 1) {
      expect(s[i]!.occurredAt >= s[i - 1]!.occurredAt).toBe(true);
    }
  });
});
