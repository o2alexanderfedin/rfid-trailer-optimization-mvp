import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DEFAULT_HOS_CONFIG,
  driverSchema,
  hosClockSchema,
  hosConfigSchema,
  tripSchema,
  type Driver,
  type DutyStatus,
  type HosClock,
  type HosConfig,
  type Trip,
} from "../src/index.js";

/**
 * Phase-9 domain primitives (v1.2): the `Driver` entity, the `HosClock`
 * value-object, the full-FMCSA `HosConfig`, and the back-compat `Trip.driverId`.
 *
 * These tests assert the *contract* (zod validation + inferred-type shape) the
 * way the existing entity tests do — no behavior is introduced in this phase.
 */

// --- DRV-01: Driver entity --------------------------------------------------

describe("Driver entity (DRV-01)", () => {
  const driver: Driver = {
    driverId: "DRV-1",
    name: "Pat Carrier",
    licenseClass: "A",
    dutyStatus: "driving",
  };

  it("parses a fully-populated driver", () => {
    expect(driverSchema.parse(driver)).toEqual(driver);
  });

  it("name and licenseClass are optional (minimal driver is valid)", () => {
    const minimal = { driverId: "DRV-2", dutyStatus: "off_duty" } as const;
    expect(driverSchema.parse(minimal)).toEqual(minimal);
  });

  it("dutyStatus is the closed {driving, on_break, resting, off_duty} taxonomy", () => {
    for (const dutyStatus of ["driving", "on_break", "resting", "off_duty"]) {
      expect(
        driverSchema.parse({ driverId: "D", dutyStatus }).dutyStatus,
      ).toBe(dutyStatus);
    }
    expect(() =>
      driverSchema.parse({ driverId: "D", dutyStatus: "napping" }),
    ).toThrow();
  });

  it("rejects an empty driverId and a missing dutyStatus", () => {
    expect(() =>
      driverSchema.parse({ driverId: "", dutyStatus: "driving" }),
    ).toThrow();
    expect(() => driverSchema.parse({ driverId: "D" })).toThrow();
  });

  it("the inferred type is the single source of truth", () => {
    expectTypeOf<Driver["driverId"]>().toEqualTypeOf<string>();
    expectTypeOf<Driver["dutyStatus"]>().toEqualTypeOf<DutyStatus>();
    expectTypeOf<DutyStatus>().toEqualTypeOf<
      "driving" | "on_break" | "resting" | "off_duty"
    >();
    expectTypeOf<Driver["name"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Driver["licenseClass"]>().toEqualTypeOf<string | undefined>();
  });
});

// --- DRV-02: HosClock value-object ------------------------------------------

describe("HosClock value-object (DRV-02)", () => {
  const clock: HosClock = {
    driveTodayMin: 120,
    dutyWindowStartAt: "2024-01-01T08:00:00.000Z",
    sinceLastBreakMin: 120,
    weeklyOnDutyMin: 600,
    comeOnDutyAt: "2024-01-01T08:00:00.000Z",
    sleeperBerthLongMin: 0,
    sleeperBerthShortMin: 0,
  };

  it("parses a full clock with integer-minute counters + ISO stamps", () => {
    expect(hosClockSchema.parse(clock)).toEqual(clock);
  });

  it("minute counters are non-negative integers (reject negative / fractional)", () => {
    expect(() =>
      hosClockSchema.parse({ ...clock, driveTodayMin: -1 }),
    ).toThrow();
    expect(() =>
      hosClockSchema.parse({ ...clock, sinceLastBreakMin: 12.5 }),
    ).toThrow();
    expect(() =>
      hosClockSchema.parse({ ...clock, weeklyOnDutyMin: 1.1 }),
    ).toThrow();
  });

  it("ISO stamp fields must be non-empty", () => {
    expect(() =>
      hosClockSchema.parse({ ...clock, dutyWindowStartAt: "" }),
    ).toThrow();
    expect(() =>
      hosClockSchema.parse({ ...clock, comeOnDutyAt: "" }),
    ).toThrow();
  });

  it("carries the sleeper-berth split accumulators (7/3 & 8/2 provisions)", () => {
    expectTypeOf<HosClock["sleeperBerthLongMin"]>().toEqualTypeOf<number>();
    expectTypeOf<HosClock["sleeperBerthShortMin"]>().toEqualTypeOf<number>();
    const split = hosClockSchema.parse({
      ...clock,
      sleeperBerthLongMin: 420,
      sleeperBerthShortMin: 180,
    });
    expect(split.sleeperBerthLongMin).toBe(420);
    expect(split.sleeperBerthShortMin).toBe(180);
  });

  it("the inferred type exposes the integer-minute fields", () => {
    expectTypeOf<HosClock["driveTodayMin"]>().toEqualTypeOf<number>();
    expectTypeOf<HosClock["dutyWindowStartAt"]>().toEqualTypeOf<string>();
    expectTypeOf<HosClock["sinceLastBreakMin"]>().toEqualTypeOf<number>();
    expectTypeOf<HosClock["weeklyOnDutyMin"]>().toEqualTypeOf<number>();
    expectTypeOf<HosClock["comeOnDutyAt"]>().toEqualTypeOf<string>();
  });
});

// --- DRV-03: Trip back-compat (optional driverId) ---------------------------

describe("Trip carries an optional driverId (DRV-03)", () => {
  it("an unassigned trip (no driverId) stays valid — back-compat", () => {
    const trip = {
      tripId: "TRIP-1",
      trailerId: "T1",
      fromHubId: "MEM",
      toHubId: "ORD",
    };
    expect(tripSchema.parse(trip)).toEqual(trip);
  });

  it("a trip may bind exactly one driver", () => {
    const trip: Trip = {
      tripId: "TRIP-1",
      trailerId: "T1",
      fromHubId: "MEM",
      toHubId: "ORD",
      driverId: "DRV-1",
    };
    expect(tripSchema.parse(trip).driverId).toBe("DRV-1");
  });

  it("driverId, when present, must be a non-empty id", () => {
    expect(() =>
      tripSchema.parse({
        tripId: "TRIP-1",
        trailerId: "T1",
        fromHubId: "MEM",
        toHubId: "ORD",
        driverId: "",
      }),
    ).toThrow();
  });

  it("the inferred type makes driverId optional", () => {
    expectTypeOf<Trip["driverId"]>().toEqualTypeOf<string | undefined>();
  });
});

// --- HOS-01: HosConfig + DEFAULT_HOS_CONFIG ---------------------------------

describe("HosConfig + DEFAULT_HOS_CONFIG (HOS-01)", () => {
  it("DEFAULT_HOS_CONFIG holds the full-FMCSA integer-minute constants", () => {
    expect(DEFAULT_HOS_CONFIG.maxDriveMin).toBe(660); // 11h
    expect(DEFAULT_HOS_CONFIG.dutyWindowMin).toBe(840); // 14h
    expect(DEFAULT_HOS_CONFIG.breakAfterDriveMin).toBe(480); // 8h
    expect(DEFAULT_HOS_CONFIG.minBreakMin).toBe(30);
    expect(DEFAULT_HOS_CONFIG.resetOffDutyMin).toBe(600); // 10h
    expect(DEFAULT_HOS_CONFIG.weeklyCapMin).toBe(4200); // 70h / 8-day
    expect(DEFAULT_HOS_CONFIG.restartMin).toBe(2040); // 34h
  });

  it("carries the sleeper-berth split parameters (7/3 and 8/2)", () => {
    // 7/3 split: a 7h berth period + a 3h period (neither < 2h, total >= 10h).
    expect(DEFAULT_HOS_CONFIG.sleeperBerthLongMin).toBe(420); // 7h
    expect(DEFAULT_HOS_CONFIG.sleeperBerthShortMin).toBe(180); // 3h
    // 8/2 split: an 8h berth period + a 2h period.
    expect(DEFAULT_HOS_CONFIG.sleeperBerthAltLongMin).toBe(480); // 8h
    expect(DEFAULT_HOS_CONFIG.sleeperBerthAltShortMin).toBe(120); // 2h
  });

  it("DEFAULT_HOS_CONFIG validates against hosConfigSchema", () => {
    expect(hosConfigSchema.parse(DEFAULT_HOS_CONFIG)).toEqual(DEFAULT_HOS_CONFIG);
  });

  it("config minutes are positive integers (reject zero / fractional)", () => {
    expect(() =>
      hosConfigSchema.parse({ ...DEFAULT_HOS_CONFIG, maxDriveMin: 0 }),
    ).toThrow();
    expect(() =>
      hosConfigSchema.parse({ ...DEFAULT_HOS_CONFIG, minBreakMin: 30.5 }),
    ).toThrow();
  });

  it("HosConfig is a readonly integer-minute contract", () => {
    expectTypeOf<HosConfig["maxDriveMin"]>().toEqualTypeOf<number>();
    expectTypeOf<HosConfig["weeklyCapMin"]>().toEqualTypeOf<number>();
    expectTypeOf<HosConfig["restartMin"]>().toEqualTypeOf<number>();
  });
});
