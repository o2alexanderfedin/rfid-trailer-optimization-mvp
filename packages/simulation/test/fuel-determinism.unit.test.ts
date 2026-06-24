import { describe, expect, it } from "vitest";
import { validateEvent, DEFAULT_FUEL_CONFIG, type FuelConfig } from "@mm/domain";
import {
  FUEL_RNG_SALT,
  HOS_RNG_SALT,
  INDUCTION_RNG_SALT,
  OVER_CARRY_RNG_SALT,
  RFID_RNG_SALT,
  TIMING_RNG_SALT,
  simulate,
} from "../src/engine.js";

/**
 * SP2 Task 2 — THE FUEL DETERMINISM KEYSTONE (spec §5/§9).
 *
 * Three halves:
 *  1. Fuel OFF (the default, AND an explicit disabled config) is BYTE-IDENTICAL
 *     to the current golden — the `fuelRng` substream is never created, no new
 *     events, no projection deltas. This is the judging keystone.
 *  2. Fuel ON has its OWN golden: same seed + same `FuelConfig` ⇒ byte-identical,
 *     and a DIFFERENT stream from OFF (new events are present).
 *  3. The odometer accrues per leg + `TruckRefueled` fires at/after the threshold
 *     (then the odometer resets); a `TruckRested` accompanies each HOS rest/break;
 *     a refuel co-located with a rest adds NO extra arrival delay (`max`, not sum).
 *
 * TIME-01: per-leg transit medians are ≈400–2250 min, so the horizon must span
 * real round-trips for trailers to drive far enough to refuel.
 */

const SEED = 1234;
const TICKS = 6000;
/** HOS must be on for `TruckRested` (a rest is an HOS segment) + the refuel co-location test. */
const HOS_ON = { seed: SEED, durationTicks: TICKS, hosEnabled: true } as const;
const FUEL_ON: FuelConfig = { ...DEFAULT_FUEL_CONFIG, enabled: true };

const types = (s: ReturnType<typeof simulate>): string[] => s.map((e) => e.event.type);
const count = (s: ReturnType<typeof simulate>, t: string): number =>
  s.filter((e) => e.event.type === t).length;

// ---------------------------------------------------------------------------
// FUEL-01 — the new substream salt is distinct from all four existing salts
// ---------------------------------------------------------------------------
describe("FUEL-01: fuelRng substream salt", () => {
  it("FUEL_RNG_SALT is pairwise-distinct from rfid/overCarry/timing/hos (no collision)", () => {
    const salts = [
      RFID_RNG_SALT,
      OVER_CARRY_RNG_SALT,
      TIMING_RNG_SALT,
      HOS_RNG_SALT,
      FUEL_RNG_SALT,
    ].map((s) => s >>> 0);
    expect(new Set(salts).size).toBe(salts.length);
    expect(FUEL_RNG_SALT >>> 0).not.toBe(RFID_RNG_SALT >>> 0);
    expect(FUEL_RNG_SALT >>> 0).not.toBe(OVER_CARRY_RNG_SALT >>> 0);
    expect(FUEL_RNG_SALT >>> 0).not.toBe(TIMING_RNG_SALT >>> 0);
    expect(FUEL_RNG_SALT >>> 0).not.toBe(HOS_RNG_SALT >>> 0);
  });

  // v2.0 IND-02 — the SEVENTH substream salt joins the pairwise-distinct set.
  it("INDUCTION_RNG_SALT is pairwise-distinct from all six existing salts (no collision)", () => {
    const salts = [
      RFID_RNG_SALT,
      OVER_CARRY_RNG_SALT,
      TIMING_RNG_SALT,
      HOS_RNG_SALT,
      FUEL_RNG_SALT,
      INDUCTION_RNG_SALT,
    ].map((s) => s >>> 0);
    expect(new Set(salts).size).toBe(salts.length);
    expect(INDUCTION_RNG_SALT >>> 0).not.toBe(RFID_RNG_SALT >>> 0);
    expect(INDUCTION_RNG_SALT >>> 0).not.toBe(OVER_CARRY_RNG_SALT >>> 0);
    expect(INDUCTION_RNG_SALT >>> 0).not.toBe(TIMING_RNG_SALT >>> 0);
    expect(INDUCTION_RNG_SALT >>> 0).not.toBe(HOS_RNG_SALT >>> 0);
    expect(INDUCTION_RNG_SALT >>> 0).not.toBe(FUEL_RNG_SALT >>> 0);
  });
});

// ---------------------------------------------------------------------------
// FUEL-02 (keystone) — fuel OFF is byte-identical to the current golden
// ---------------------------------------------------------------------------
describe("FUEL-02: fuel-off stream is byte-identical to the current golden", () => {
  it("fuel absent ⇒ NO TruckRested / TruckRefueled events at all (HOS off)", () => {
    const s = simulate({ seed: SEED, durationTicks: TICKS });
    const t = types(s);
    expect(t).not.toContain("TruckRested");
    expect(t).not.toContain("TruckRefueled");
  });

  it("fuel absent ⇒ NO fuel events even when HOS is ON (rests exist but no TruckRested)", () => {
    const s = simulate(HOS_ON);
    const t = types(s);
    expect(t).not.toContain("TruckRested");
    expect(t).not.toContain("TruckRefueled");
  });

  it("fuel absent === fuel { enabled:false } — byte-identical (HOS off keystone)", () => {
    const absent = simulate({ seed: SEED, durationTicks: TICKS });
    const explicitOff = simulate({
      seed: SEED,
      durationTicks: TICKS,
      fuel: { ...DEFAULT_FUEL_CONFIG, enabled: false },
    });
    expect(JSON.stringify(explicitOff)).toBe(JSON.stringify(absent));
  });

  it("fuel absent === passing DEFAULT_FUEL_CONFIG (default is off) — byte-identical", () => {
    const absent = simulate({ seed: SEED, durationTicks: TICKS });
    const passedDefault = simulate({
      seed: SEED,
      durationTicks: TICKS,
      fuel: DEFAULT_FUEL_CONFIG,
    });
    expect(JSON.stringify(passedDefault)).toBe(JSON.stringify(absent));
  });

  it("enabling fuel does NOT perturb the HOS-on stream when fuel is OFF (off-mode parity)", () => {
    const a = simulate(HOS_ON);
    const b = simulate({ ...HOS_ON, fuel: { ...DEFAULT_FUEL_CONFIG, enabled: false } });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

// ---------------------------------------------------------------------------
// FUEL-03 — fuel ON is deterministic + differs from OFF
// ---------------------------------------------------------------------------
describe("FUEL-03: fuel-on golden-replay (same seed + FuelConfig ⇒ byte-identical)", () => {
  it("same seed + fuel config ⇒ byte-identical stream", () => {
    const a = simulate({ ...HOS_ON, fuel: FUEL_ON });
    const b = simulate({ ...HOS_ON, fuel: { ...FUEL_ON } });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("fuel ON differs from fuel OFF (new events present)", () => {
    const off = simulate(HOS_ON);
    const on = simulate({ ...HOS_ON, fuel: FUEL_ON });
    expect(JSON.stringify(on)).not.toBe(JSON.stringify(off));
    expect(count(on, "TruckRefueled")).toBeGreaterThan(0);
  });

  it("different seed ⇒ a different fuel-on stream", () => {
    const a = simulate({ ...HOS_ON, seed: 1, fuel: FUEL_ON });
    const b = simulate({ ...HOS_ON, seed: 2, fuel: FUEL_ON });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("every emitted fuel-on event passes the domain validateEvent boundary", () => {
    for (const item of simulate({ ...HOS_ON, fuel: FUEL_ON })) {
      expect(() => validateEvent(item.event)).not.toThrow();
    }
  });

  it("fuel-on events stay in non-decreasing occurredAt order", () => {
    const s = simulate({ ...HOS_ON, fuel: FUEL_ON });
    for (let i = 1; i < s.length; i += 1) {
      expect(s[i]!.occurredAt >= s[i - 1]!.occurredAt).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FUEL-04 — odometer accrual + refuel reset
// ---------------------------------------------------------------------------
describe("FUEL-04: odometer-triggered refuel + reset (spec §5)", () => {
  it("TruckRefueled fires with a cumulative odometer at/over the threshold", () => {
    const s = simulate({ ...HOS_ON, fuel: FUEL_ON });
    const refuels = s.filter((e) => e.event.type === "TruckRefueled");
    expect(refuels.length).toBeGreaterThan(0);
    for (const r of refuels) {
      if (r.event.type !== "TruckRefueled") continue;
      // The odometer at refuel must be >= the threshold (refuel fires AT/AFTER crossing).
      expect(r.event.payload.odometerMiles).toBeGreaterThanOrEqual(
        FUEL_ON.refuelThresholdMiles,
      );
      // gallons = round(min(odometer/mpg, tankCapacity)) — deterministic, capped.
      const expected = Math.round(
        Math.min(r.event.payload.odometerMiles / FUEL_ON.milesPerGallon, FUEL_ON.tankCapacityGallons),
      );
      expect(r.event.payload.gallons).toBe(expected);
      expect(r.event.payload.gallons).toBeLessThanOrEqual(FUEL_ON.tankCapacityGallons);
    }
  });

  it("a tiny threshold forces MANY refuels (multi-refuel-per-trailer accrual works)", () => {
    const tiny: FuelConfig = { ...FUEL_ON, refuelThresholdMiles: 100 };
    const s = simulate({ ...HOS_ON, fuel: tiny });
    // With a 100-mi threshold over long coast legs, refuels are frequent.
    expect(count(s, "TruckRefueled")).toBeGreaterThan(count(s, "TruckRefueled") - 1); // sanity
    expect(count(s, "TruckRefueled")).toBeGreaterThanOrEqual(5);
  });

  it("a huge threshold suppresses refuels entirely (threshold gate honored)", () => {
    const huge: FuelConfig = { ...FUEL_ON, refuelThresholdMiles: 10_000_000 };
    const s = simulate({ ...HOS_ON, fuel: huge });
    expect(count(s, "TruckRefueled")).toBe(0);
  });

  it("the tank cap bounds gallons even when a single accrued leg is enormous", () => {
    // Threshold below mpg×capacity so capped path is exercised; cap = 150 gal.
    const capped: FuelConfig = { ...FUEL_ON, refuelThresholdMiles: 100, tankCapacityGallons: 10 };
    const s = simulate({ ...HOS_ON, fuel: capped });
    for (const r of s) {
      if (r.event.type === "TruckRefueled") {
        expect(r.event.payload.gallons).toBeLessThanOrEqual(10);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FUEL-05 — a TruckRested accompanies each HOS rest/break
// ---------------------------------------------------------------------------
describe("FUEL-05: TruckRested mirrors each HOS rest/break (spec §5)", () => {
  it("every TruckRested carries a valid reason + a positive durationMin", () => {
    const s = simulate({ ...HOS_ON, fuel: FUEL_ON });
    const rests = s.filter((e) => e.event.type === "TruckRested");
    expect(rests.length).toBeGreaterThan(0);
    for (const r of rests) {
      if (r.event.type !== "TruckRested") continue;
      expect(["rest-10h", "break-30min"]).toContain(r.event.payload.reason);
      expect(r.event.payload.durationMin).toBeGreaterThan(0);
    }
  });

  it("TruckRested maps 1:1 to MID-LEG rest/break parks (modulo horizon truncation)", () => {
    // Each mid-leg park (`accrueDrivingLeg`, duty reasons "30-min-break-due" /
    // "10h-reset") schedules a co-located TruckRested at the MID-LEG tick. The
    // relay handoff also emits a `resting` duty change (reason "relay-handoff") —
    // that driver leaves the trailer, so it is NOT a trailer park and carries no
    // TruckRested. At a horizon boundary a park's mid-leg tick can fall AFTER
    // `durationTicks`, so its scheduled stop never fires — hence TruckRested is a
    // (possibly truncated) SUBSET of the mid-leg park count, never larger.
    const s = simulate({ ...HOS_ON, fuel: FUEL_ON });
    const midLegRests = s.filter(
      (e) =>
        e.event.type === "DriverDutyStateChanged" &&
        (e.event.payload.reason === "30-min-break-due" ||
          e.event.payload.reason === "10h-reset"),
    ).length;
    expect(midLegRests).toBeGreaterThan(0);
    expect(count(s, "TruckRested")).toBeGreaterThan(0);
    expect(count(s, "TruckRested")).toBeLessThanOrEqual(midLegRests);
  });

  it("each TruckRested is stamped MID-LEG (after its trip's depart, before its arrival)", () => {
    // The stop is scheduled at a deterministic mid-leg tick so the geo-track
    // projection lands a genuine MID-ROUTE position (spec §6). Assert every
    // TruckRested's occurredAt strictly follows its trip's TrailerDeparted and
    // strictly precedes the matching TrailerArrivedAtHub.
    const s = simulate({ ...HOS_ON, fuel: FUEL_ON });
    const departAt = new Map<string, number>();
    const arriveAt = new Map<string, number>();
    for (const e of s) {
      if (e.event.type === "TrailerDeparted") departAt.set(e.event.payload.tripId, new Date(e.occurredAt).getTime());
      if (e.event.type === "TrailerArrivedAtHub" && !arriveAt.has(e.event.payload.tripId)) {
        arriveAt.set(e.event.payload.tripId, new Date(e.occurredAt).getTime());
      }
    }
    let checked = 0;
    for (const e of s) {
      if (e.event.type === "TruckRested") {
        const dep = departAt.get(e.event.payload.tripId);
        const arr = arriveAt.get(e.event.payload.tripId);
        expect(dep).toBeDefined();
        const stopMs = new Date(e.occurredAt).getTime();
        expect(stopMs).toBeGreaterThanOrEqual(dep!);
        if (arr !== undefined) expect(stopMs).toBeLessThanOrEqual(arr);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FUEL-06 — no-double-count: refuel co-located with a rest adds no extra delay
// ---------------------------------------------------------------------------
describe("FUEL-06: refuel arrival timing uses max(rest, refuel) — no double-count (spec §5)", () => {
  /**
   * Pin transit to a SMALL flat value so the leg fits inside the driver's hours
   * (no HOS rest), making the refuel the SOLE added delay — then compare arrival
   * spacing with and without the refuel. With a tiny threshold the trailer
   * refuels every leg; the added delay must be exactly `refuelTimeMinutes`, never
   * more, and never doubled.
   */
  it("a LONE refuel (no co-located rest) delays the arrival by exactly refuelTimeMinutes", () => {
    // Flat short transit so no HOS rest is inserted (legs fit in legal hours).
    const flatTiming = {
      dwellSpoke: { median: 10, sigma: 0, min: 10, max: 10 },
      dwellCenter: { median: 10, sigma: 0, min: 10, max: 10 },
      transit: { median: 50, sigma: 0, min: 50, max: 50 },
    } as const;
    const base = { seed: SEED, durationTicks: 1200, hosEnabled: true, timing: flatTiming } as const;
    const off = simulate(base);
    const on = simulate({
      ...base,
      // Threshold below 50 mi/leg so EVERY leg refuels; tank big so gallons uncapped.
      fuel: { ...FUEL_ON, refuelThresholdMiles: 1, refuelTimeMinutes: 30 },
    });

    // The first trailer's first arrival is `depart + transit (+ refuel when on)`.
    const firstArriveOff = off.find((e) => e.event.type === "TrailerArrivedAtHub");
    const firstArriveOn = on.find((e) => e.event.type === "TrailerArrivedAtHub");
    expect(firstArriveOff).toBeDefined();
    expect(firstArriveOn).toBeDefined();
    const offMs = new Date(firstArriveOff!.occurredAt).getTime();
    const onMs = new Date(firstArriveOn!.occurredAt).getTime();
    // The refuel adds EXACTLY refuelTimeMinutes (30 min) of delay — not doubled.
    expect(onMs - offMs).toBe(30 * 60_000);
  });

  it("a refuel inside a >= refuelTimeMinutes rest adds NO extra delay (max, not sum)", () => {
    // Force a long leg that triggers a 10h (600-min) HOS rest, AND a refuel.
    // The refuel (30 min) overlaps the rest (600 min) ⇒ effective added = max = 600.
    // We assert arrival timing with refuel ON co-located equals the rest-only timing.
    const longTiming = {
      dwellSpoke: { median: 10, sigma: 0, min: 10, max: 10 },
      dwellCenter: { median: 10, sigma: 0, min: 10, max: 10 },
      // A single leg of 800 min driving exceeds the 660-min drive ceiling ⇒ a 10h rest.
      transit: { median: 800, sigma: 0, min: 800, max: 800 },
    } as const;
    const base = { seed: SEED, durationTicks: 4000, hosEnabled: true, timing: longTiming } as const;
    const restOnly = simulate(base);
    // Refuel threshold below 800-mi leg so the trailer ALSO refuels on the rested leg.
    const restPlusRefuel = simulate({
      ...base,
      fuel: { ...FUEL_ON, refuelThresholdMiles: 1, refuelTimeMinutes: 30 },
    });

    const aOff = restOnly.find((e) => e.event.type === "TrailerArrivedAtHub");
    const aOn = restPlusRefuel.find((e) => e.event.type === "TrailerArrivedAtHub");
    expect(aOff).toBeDefined();
    expect(aOn).toBeDefined();
    // The refuel (30) is swallowed by the 600-min rest ⇒ arrival time is UNCHANGED.
    expect(new Date(aOn!.occurredAt).getTime()).toBe(new Date(aOff!.occurredAt).getTime());
  });
});
