import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DomainEvent,
  type TruckRefueled,
  type TruckRested,
  truckRefueledSchema,
  truckRestedSchema,
  validateEvent,
  ValidationError,
  DEFAULT_FUEL_CONFIG,
  type FuelConfig,
} from "../index.js";

/**
 * SP2 Task 1 (RED first): the two NEW visible-stop events — `TruckRested`
 * (emitted alongside an HOS rest/break) and `TruckRefueled` (odometer crosses the
 * refuel threshold). Both are first-class members of the CLOSED, VERSIONED
 * `DomainEvent` union, zod-validated through the `validateEvent` boundary, with
 * the build gate (`contract.assert.ts`) enforcing schema/union parity and
 * exhaustiveness.
 *
 * Determinism keystone (spec §4): the payloads carry NO lon/lat and NO RNG value
 * — only ids, a clock, and the durations/odometer derived deterministically from
 * the sim. `occurredAt` is a caller-supplied domain-clock string.
 */

const rested: TruckRested = {
  type: "TruckRested",
  schemaVersion: 1,
  payload: {
    trailerId: "T001",
    tripId: "TRIP00001",
    reason: "rest-10h",
    durationMin: 600,
    occurredAt: "2026-04-01T05:00:00.000Z",
  },
};

const refueled: TruckRefueled = {
  type: "TruckRefueled",
  schemaVersion: 1,
  payload: {
    trailerId: "T001",
    tripId: "TRIP00001",
    gallons: 150,
    odometerMiles: 1234,
    durationMin: 30,
    occurredAt: "2026-04-01T05:30:00.000Z",
  },
};

describe("DEFAULT_FUEL_CONFIG (spec §4)", () => {
  it("is OFF by default with the locked tank-model constants", () => {
    const cfg: FuelConfig = DEFAULT_FUEL_CONFIG;
    expect(cfg.enabled).toBe(false);
    expect(cfg.tankCapacityGallons).toBe(150);
    expect(cfg.milesPerGallon).toBe(6.5);
    expect(cfg.refuelThresholdMiles).toBe(1200);
    expect(cfg.refuelTimeMinutes).toBe(30);
  });

  it("types `enabled` as optional and the numeric fields as required", () => {
    expectTypeOf(DEFAULT_FUEL_CONFIG.tankCapacityGallons).toEqualTypeOf<number>();
    expectTypeOf(DEFAULT_FUEL_CONFIG.milesPerGallon).toEqualTypeOf<number>();
    expectTypeOf(DEFAULT_FUEL_CONFIG.refuelThresholdMiles).toEqualTypeOf<number>();
    expectTypeOf(DEFAULT_FUEL_CONFIG.refuelTimeMinutes).toEqualTypeOf<number>();
  });
});

describe("TruckRested / TruckRefueled — closed-union membership (SP2 §4)", () => {
  it("both are assignable to the DomainEvent union", () => {
    const events: readonly DomainEvent[] = [rested, refueled];
    expect(events.map((e) => e.type)).toEqual(["TruckRested", "TruckRefueled"]);
    expectTypeOf(rested).toMatchTypeOf<DomainEvent>();
    expectTypeOf(refueled).toMatchTypeOf<DomainEvent>();
  });

  it("TruckRested pins its discriminator + version + payload field types", () => {
    expectTypeOf(rested.type).toEqualTypeOf<"TruckRested">();
    expectTypeOf(rested.schemaVersion).toEqualTypeOf<1>();
    expectTypeOf(rested.payload.reason).toEqualTypeOf<"rest-10h" | "break-30min">();
    expectTypeOf(rested.payload.durationMin).toEqualTypeOf<number>();
    expectTypeOf(rested.payload.occurredAt).toEqualTypeOf<string>();
  });

  it("TruckRefueled pins its payload field types (odometer + gallons, NO geo)", () => {
    expectTypeOf(refueled.type).toEqualTypeOf<"TruckRefueled">();
    expectTypeOf(refueled.payload.gallons).toEqualTypeOf<number>();
    expectTypeOf(refueled.payload.odometerMiles).toEqualTypeOf<number>();
    expectTypeOf(refueled.payload.durationMin).toEqualTypeOf<number>();
    // No lon/lat in the payload — positions are computed by the geo-track projection.
    expectTypeOf(refueled.payload).not.toHaveProperty("lon");
    expectTypeOf(refueled.payload).not.toHaveProperty("lat");
  });
});

describe("validateEvent — accepts well-formed fuel/stop events", () => {
  it("round-trips a well-formed TruckRested as a typed event", () => {
    const parsed = validateEvent(rested);
    expect(parsed).toEqual(rested);
    expect(parsed.type).toBe("TruckRested");
  });

  it("round-trips a well-formed TruckRefueled as a typed event", () => {
    const parsed = validateEvent(refueled);
    expect(parsed).toEqual(refueled);
    expect(parsed.type).toBe("TruckRefueled");
  });

  it("the standalone schemas parse both valid reason enum values", () => {
    expect(truckRestedSchema.safeParse(rested).success).toBe(true);
    expect(
      truckRestedSchema.safeParse({
        ...rested,
        payload: { ...rested.payload, reason: "break-30min", durationMin: 30 },
      }).success,
    ).toBe(true);
    expect(truckRefueledSchema.safeParse(refueled).success).toBe(true);
  });
});

describe("validateEvent — rejects malformed fuel/stop events (T tampering)", () => {
  it("rejects a TruckRested with an unknown reason enum value", () => {
    expect(() =>
      validateEvent({
        type: "TruckRested",
        schemaVersion: 1,
        payload: { ...rested.payload, reason: "lunch" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a TruckRested missing durationMin, naming the field", () => {
    const { durationMin: _omit, ...withoutDuration } = rested.payload;
    void _omit;
    let caught: unknown;
    try {
      validateEvent({
        type: "TruckRested",
        schemaVersion: 1,
        payload: withoutDuration,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toMatch(/durationMin/);
  });

  it("rejects a TruckRested with a negative durationMin", () => {
    expect(() =>
      validateEvent({
        type: "TruckRested",
        schemaVersion: 1,
        payload: { ...rested.payload, durationMin: -1 },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a TruckRefueled with a negative gallons", () => {
    expect(() =>
      validateEvent({
        type: "TruckRefueled",
        schemaVersion: 1,
        payload: { ...refueled.payload, gallons: -5 },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a TruckRefueled with a negative odometerMiles", () => {
    expect(() =>
      validateEvent({
        type: "TruckRefueled",
        schemaVersion: 1,
        payload: { ...refueled.payload, odometerMiles: -1 },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a TruckRefueled with a non-numeric durationMin", () => {
    expect(() =>
      validateEvent({
        type: "TruckRefueled",
        schemaVersion: 1,
        payload: { ...refueled.payload, durationMin: "thirty" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a TruckRefueled with an extra (unrecognized) field — strict payload", () => {
    expect(() =>
      validateEvent({
        type: "TruckRefueled",
        schemaVersion: 1,
        payload: { ...refueled.payload, lon: -90 },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an unsupported schemaVersion for a fuel event", () => {
    expect(() =>
      validateEvent({
        type: "TruckRefueled",
        schemaVersion: 2,
        payload: refueled.payload,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a TruckRested with an empty trailerId (non-empty id constraint)", () => {
    expect(() =>
      validateEvent({
        type: "TruckRested",
        schemaVersion: 1,
        payload: { ...rested.payload, trailerId: "" },
      }),
    ).toThrow(ValidationError);
  });
});
