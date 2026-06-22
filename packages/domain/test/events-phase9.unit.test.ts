import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertNever,
  driverAssignedToTripSchema,
  driverDutyStateChangedSchema,
  driverRegisteredSchema,
  driverSwappedAtHubSchema,
  loadStartedSchema,
  unloadCompletedSchema,
  unloadStartedSchema,
  validateEvent,
  ValidationError,
  type DomainEvent,
  type DomainEventType,
  type DriverAssignedToTrip,
  type DriverDutyStateChanged,
  type DriverRegistered,
  type DriverSwappedAtHub,
  type HosClock,
  type LoadStarted,
  type UnloadCompleted,
  type UnloadStarted,
} from "../src/index.js";

/**
 * Phase-9 (v1.2 DRV/EVT) — RED first.
 *
 * Extends the CLOSED `DomainEvent` union with the four driver-lifecycle events
 * (EVT-01) and the three authoritative load/unload phase events (EVT-02). These
 * tests assert:
 *
 *  - each new event validates through `validateEvent` and round-trips,
 *  - the payloads are `.strict()` (extra field rejected) and `id`s non-empty,
 *  - `DriverDutyStateChanged` carries a `reason` + an `HosClock` snapshot,
 *  - the phase events carry ONLY `{trailerId, hubId, tripId, occurredAt}` —
 *    no RNG payload (determinism keystone),
 *  - the new types are exhaustively handled in a `switch` over `DomainEvent`.
 *
 * No behavior is introduced here — this phase only DEFINES the events.
 */

const occurredAt = "2024-01-01T08:00:00.000Z";

const clockSnapshot: HosClock = {
  driveTodayMin: 120,
  dutyWindowStartAt: occurredAt,
  sinceLastBreakMin: 120,
  weeklyOnDutyMin: 600,
  comeOnDutyAt: occurredAt,
  sleeperBerthLongMin: 0,
  sleeperBerthShortMin: 0,
};

// --- Canonical valid fixtures ----------------------------------------------

const driverRegistered: DriverRegistered = {
  type: "DriverRegistered",
  schemaVersion: 1,
  payload: {
    driverId: "DRV-1",
    name: "Pat Carrier",
    licenseClass: "A",
    homeHubId: "MEM",
    occurredAt,
  },
};

const driverAssignedToTrip: DriverAssignedToTrip = {
  type: "DriverAssignedToTrip",
  schemaVersion: 1,
  payload: {
    driverId: "DRV-1",
    tripId: "TRIP-1",
    trailerId: "T1",
    occurredAt,
  },
};

const driverDutyStateChanged: DriverDutyStateChanged = {
  type: "DriverDutyStateChanged",
  schemaVersion: 1,
  payload: {
    driverId: "DRV-1",
    dutyStatus: "driving",
    reason: "trip-dispatched",
    clock: clockSnapshot,
    occurredAt,
  },
};

const driverSwappedAtHub: DriverSwappedAtHub = {
  type: "DriverSwappedAtHub",
  schemaVersion: 1,
  payload: {
    outgoingDriverId: "DRV-1",
    incomingDriverId: "DRV-2",
    hubId: "ORD",
    tripId: "TRIP-1",
    trailerId: "T1",
    occurredAt,
  },
};

const unloadStarted: UnloadStarted = {
  type: "UnloadStarted",
  schemaVersion: 1,
  payload: { trailerId: "T1", hubId: "ORD", tripId: "TRIP-1", occurredAt },
};

const loadStarted: LoadStarted = {
  type: "LoadStarted",
  schemaVersion: 1,
  payload: { trailerId: "T1", hubId: "ORD", tripId: "TRIP-1", occurredAt },
};

const unloadCompleted: UnloadCompleted = {
  type: "UnloadCompleted",
  schemaVersion: 1,
  payload: { trailerId: "T1", hubId: "ORD", tripId: "TRIP-1", occurredAt },
};

const PHASE9_EVENTS: readonly DomainEvent[] = [
  driverRegistered,
  driverAssignedToTrip,
  driverDutyStateChanged,
  driverSwappedAtHub,
  unloadStarted,
  loadStarted,
  unloadCompleted,
];

/**
 * Closed-union exhaustiveness at the test layer: only the seven Phase-9 members
 * are handled; the `default` is reachable-but-out-of-scope for non-Phase-9
 * events (the type-level exhaustiveness is enforced in contract.assert.ts).
 */
function describePhase9Event(e: DomainEvent): string {
  switch (e.type) {
    case "DriverRegistered":
      return e.payload.driverId;
    case "DriverAssignedToTrip":
      return e.payload.driverId;
    case "DriverDutyStateChanged":
      return e.payload.dutyStatus;
    case "DriverSwappedAtHub":
      return e.payload.incomingDriverId;
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
      return e.payload.trailerId;
    default:
      return "";
  }
}

describe("Phase-9 events validate + round-trip (EVT-01/EVT-02)", () => {
  it.each(PHASE9_EVENTS.map((e) => [e.type, e] as const))(
    "accepts a valid %s and round-trips it deep-equal",
    (_type, event) => {
      expect(validateEvent(event)).toEqual(event);
    },
  );

  it("each Phase-9 event is statically typed as DomainEvent", () => {
    expectTypeOf(driverRegistered).toMatchTypeOf<DomainEvent>();
    expectTypeOf(driverAssignedToTrip).toMatchTypeOf<DomainEvent>();
    expectTypeOf(driverDutyStateChanged).toMatchTypeOf<DomainEvent>();
    expectTypeOf(driverSwappedAtHub).toMatchTypeOf<DomainEvent>();
    expectTypeOf(unloadStarted).toMatchTypeOf<DomainEvent>();
    expectTypeOf(loadStarted).toMatchTypeOf<DomainEvent>();
    expectTypeOf(unloadCompleted).toMatchTypeOf<DomainEvent>();
  });

  it("DomainEventType includes the seven Phase-9 discriminators", () => {
    const types = new Set<DomainEventType>(PHASE9_EVENTS.map((e) => e.type));
    expect(types).toEqual(
      new Set<DomainEventType>([
        "DriverRegistered",
        "DriverAssignedToTrip",
        "DriverDutyStateChanged",
        "DriverSwappedAtHub",
        "UnloadStarted",
        "LoadStarted",
        "UnloadCompleted",
      ]),
    );
  });

  it("exhaustive switch dispatches every Phase-9 member", () => {
    expect(PHASE9_EVENTS.map(describePhase9Event)).toEqual([
      "DRV-1", // DriverRegistered.driverId
      "DRV-1", // DriverAssignedToTrip.driverId
      "driving", // DriverDutyStateChanged.dutyStatus
      "DRV-2", // DriverSwappedAtHub.incomingDriverId
      "T1", // UnloadStarted.trailerId
      "T1", // LoadStarted.trailerId
      "T1", // UnloadCompleted.trailerId
    ]);
    expect(() => assertNever({ type: "Nope" } as never)).toThrow();
  });
});

describe("DriverDutyStateChanged carries reason + HosClock snapshot (EVT-01)", () => {
  it("narrows the clock snapshot by discriminator (no `any`)", () => {
    const parsed = validateEvent(driverDutyStateChanged);
    if (parsed.type === "DriverDutyStateChanged") {
      expectTypeOf(parsed.payload.reason).toEqualTypeOf<string>();
      expectTypeOf(parsed.payload.clock).toEqualTypeOf<HosClock>();
      expect(parsed.payload.clock.driveTodayMin).toBe(120);
      expect(parsed.payload.reason).toBe("trip-dispatched");
    }
  });

  it("dutyStatus is the closed {driving,on_break,resting,off_duty} enum", () => {
    for (const dutyStatus of ["driving", "on_break", "resting", "off_duty"]) {
      expect(() =>
        validateEvent({
          ...driverDutyStateChanged,
          payload: { ...driverDutyStateChanged.payload, dutyStatus },
        }),
      ).not.toThrow();
    }
    expect(() =>
      validateEvent({
        ...driverDutyStateChanged,
        payload: { ...driverDutyStateChanged.payload, dutyStatus: "napping" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a clock snapshot with a negative minute counter (strict VO)", () => {
    expect(() =>
      validateEvent({
        ...driverDutyStateChanged,
        payload: {
          ...driverDutyStateChanged.payload,
          clock: { ...clockSnapshot, driveTodayMin: -5 },
        },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an empty reason (non-empty string)", () => {
    expect(() =>
      validateEvent({
        ...driverDutyStateChanged,
        payload: { ...driverDutyStateChanged.payload, reason: "" },
      }),
    ).toThrow(ValidationError);
  });
});

describe("DriverRegistered — optional name/licenseClass, additive (EVT-01)", () => {
  it("accepts a minimal DriverRegistered (no name / licenseClass)", () => {
    const parsed = validateEvent({
      type: "DriverRegistered",
      schemaVersion: 1,
      payload: { driverId: "DRV-9", homeHubId: "MEM", occurredAt },
    });
    if (parsed.type === "DriverRegistered") {
      expect(parsed.payload.name).toBeUndefined();
      expect(parsed.payload.licenseClass).toBeUndefined();
    }
  });

  it("rejects an empty driverId / homeHubId", () => {
    expect(() =>
      validateEvent({
        ...driverRegistered,
        payload: { ...driverRegistered.payload, driverId: "" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvent({
        ...driverRegistered,
        payload: { ...driverRegistered.payload, homeHubId: "" },
      }),
    ).toThrow(ValidationError);
  });
});

describe("phase events carry ONLY {trailerId,hubId,tripId,occurredAt} — no RNG", () => {
  const PHASE_EVENTS = [unloadStarted, loadStarted, unloadCompleted] as const;

  it.each(PHASE_EVENTS.map((e) => [e.type, e] as const))(
    "%s payload keys are exactly the four identifier/clock fields",
    (_type, event) => {
      expect(Object.keys(event.payload).sort()).toEqual([
        "hubId",
        "occurredAt",
        "trailerId",
        "tripId",
      ]);
    },
  );

  it.each(PHASE_EVENTS.map((e) => [e.type, e] as const))(
    "%s rejects an extra field — strict payload (no RNG drift)",
    (_type, event) => {
      expect(() =>
        validateEvent({
          ...event,
          payload: { ...event.payload, rngValue: 0.42 },
        }),
      ).toThrow(ValidationError);
    },
  );

  it.each(PHASE_EVENTS.map((e) => [e.type, e] as const))(
    "%s rejects an empty occurredAt",
    (_type, event) => {
      expect(() =>
        validateEvent({ ...event, payload: { ...event.payload, occurredAt: "" } }),
      ).toThrow(ValidationError);
    },
  );
});

describe("DriverSwappedAtHub — relay handoff (EVT-01)", () => {
  it("names both the outgoing and incoming driver + the hub/trip/trailer", () => {
    const parsed = validateEvent(driverSwappedAtHub);
    if (parsed.type === "DriverSwappedAtHub") {
      expect(parsed.payload.outgoingDriverId).toBe("DRV-1");
      expect(parsed.payload.incomingDriverId).toBe("DRV-2");
      expect(parsed.payload.hubId).toBe("ORD");
    }
  });

  it("rejects an extra field — strict payload", () => {
    expect(() =>
      validateEvent({
        ...driverSwappedAtHub,
        payload: { ...driverSwappedAtHub.payload, surprise: true },
      }),
    ).toThrow(ValidationError);
  });
});

describe("the new Phase-9 schemas are exported and parse standalone", () => {
  it("each per-event schema accepts its fixture", () => {
    expect(driverRegisteredSchema.safeParse(driverRegistered).success).toBe(true);
    expect(driverAssignedToTripSchema.safeParse(driverAssignedToTrip).success).toBe(
      true,
    );
    expect(
      driverDutyStateChangedSchema.safeParse(driverDutyStateChanged).success,
    ).toBe(true);
    expect(driverSwappedAtHubSchema.safeParse(driverSwappedAtHub).success).toBe(
      true,
    );
    expect(unloadStartedSchema.safeParse(unloadStarted).success).toBe(true);
    expect(loadStartedSchema.safeParse(loadStarted).success).toBe(true);
    expect(unloadCompletedSchema.safeParse(unloadCompleted).success).toBe(true);
  });
});
