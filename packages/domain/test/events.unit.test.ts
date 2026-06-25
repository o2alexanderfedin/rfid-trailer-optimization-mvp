import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertNever,
  type DomainEvent,
  type DomainEventType,
  type HubRegistered,
  type MissedUnloadDetected,
  type PackageArrivedAtHub,
  type PackageCreated,
  type PackageScanned,
  type PlanAccepted,
  type PlanGenerated,
  type RfidObserved,
  type RouteRegistered,
  type TrailerArrivedAtHub,
  type TrailerDeparted,
  type TrailerDocked,
  type WrongTrailerDetected,
} from "../src/index.js";
import type {
  DockDoor,
  Hub,
  LoadBlock,
  Package,
  Route,
  Trailer,
  TrailerSlice,
  Trip,
} from "../src/index.js";

/**
 * Task 1 (RED first): the closed, versioned `DomainEvent` discriminated union
 * + the Phase-1 entity types. These tests assert the *contract*, mostly at the
 * type level, plus a runtime exhaustiveness smoke test.
 */

const hubRegistered: HubRegistered = {
  type: "HubRegistered",
  schemaVersion: 1,
  payload: { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
};

const routeRegistered: RouteRegistered = {
  type: "RouteRegistered",
  schemaVersion: 1,
  payload: {
    routeId: "R1",
    fromHubId: "MEM",
    toHubId: "ORD",
    geometry: [
      [-90.049, 35.1495],
      [-87.6298, 41.8781],
    ],
  },
};

const packageCreated: PackageCreated = {
  type: "PackageCreated",
  schemaVersion: 1,
  payload: {
    packageId: "P1",
    originHubId: "MEM",
    destHubId: "ORD",
    sizeClass: "medium",
    weight: 4.2,
  },
};

const packageScanned: PackageScanned = {
  type: "PackageScanned",
  schemaVersion: 1,
  payload: { packageId: "P1", hubId: "MEM", scanType: "inbound" },
};

const packageArrived: PackageArrivedAtHub = {
  type: "PackageArrivedAtHub",
  schemaVersion: 1,
  payload: { packageId: "P1", hubId: "ORD" },
};

const trailerDeparted: TrailerDeparted = {
  type: "TrailerDeparted",
  schemaVersion: 1,
  payload: {
    trailerId: "T1",
    fromHubId: "MEM",
    toHubId: "ORD",
    tripId: "TRIP-1",
    packageIds: ["P1", "P2"],
  },
};

const trailerArrived: TrailerArrivedAtHub = {
  type: "TrailerArrivedAtHub",
  schemaVersion: 1,
  payload: { trailerId: "T1", hubId: "ORD", tripId: "TRIP-1" },
};

const trailerDocked: TrailerDocked = {
  type: "TrailerDocked",
  schemaVersion: 1,
  payload: { trailerId: "T1", hubId: "ORD", dockDoorId: "DOCK-12" },
};

// --- Phase-3 RFID-assisted validation events (SNS-01/04/05) ----------------

const rfidObserved: RfidObserved = {
  type: "RfidObserved",
  schemaVersion: 1,
  payload: {
    tagId: "TAG-1",
    readerId: "READER-1",
    antennaId: "ANT-1",
    rssi: -55,
    trailerId: "T1",
    hubId: "ORD",
    confidence: 0.8,
  },
};

const wrongTrailerDetected: WrongTrailerDetected = {
  type: "WrongTrailerDetected",
  schemaVersion: 1,
  payload: {
    packageId: "P1",
    observedTrailerId: "T2",
    plannedTrailerId: "T1",
    confidence: 0.7,
    severity: "warning",
    recommendedAction: "reroute",
  },
};

const missedUnloadDetected: MissedUnloadDetected = {
  type: "MissedUnloadDetected",
  schemaVersion: 1,
  payload: {
    packageId: "P1",
    trailerId: "T1",
    hubId: "ORD",
    confidence: 0.75,
    severity: "critical",
    recommendedAction: "hold",
  },
};

// --- Phase-4 plan-lifecycle events (OPT-04) --------------------------------

const planGenerated: PlanGenerated = {
  type: "PlanGenerated",
  schemaVersion: 1,
  payload: {
    epochId: "EPOCH-1",
    scopeHash: "HASH-1",
    planId: "PLAN-1",
    trailerId: "T1",
    objectiveCost: 120,
    feasible: true,
    occurredAt: "2024-01-01T00:00:00.000Z",
  },
};

const planAccepted: PlanAccepted = {
  type: "PlanAccepted",
  schemaVersion: 1,
  payload: {
    epochId: "EPOCH-1",
    scopeHash: "HASH-1",
    planId: "PLAN-1",
    trailerId: "T1",
    occurredAt: "2024-01-01T00:00:00.000Z",
  },
};

const ALL_EVENTS: readonly DomainEvent[] = [
  hubRegistered,
  routeRegistered,
  packageCreated,
  packageScanned,
  packageArrived,
  trailerDeparted,
  trailerArrived,
  trailerDocked,
  rfidObserved,
  wrongTrailerDetected,
  missedUnloadDetected,
  planGenerated,
  planAccepted,
];

/**
 * The canonical closed-union exhaustiveness pattern: a `switch` over the
 * discriminator whose `default` branch is `assertNever(e)`. If a member is
 * added to `DomainEvent` without a case here, this STOPS COMPILING — which is
 * exactly the closed-union guarantee the plan requires.
 */
function describeEvent(e: DomainEvent): string {
  switch (e.type) {
    case "HubRegistered":
      return e.payload.hubId;
    case "RouteRegistered":
      return e.payload.routeId;
    case "PackageCreated":
      return e.payload.packageId;
    case "PackageScanned":
      return e.payload.packageId;
    case "PackageArrivedAtHub":
      return e.payload.packageId;
    case "TrailerDeparted":
      return e.payload.trailerId;
    case "TrailerArrivedAtHub":
      return e.payload.trailerId;
    case "TrailerDocked":
      return e.payload.trailerId;
    case "RfidObserved":
      return e.payload.tagId;
    case "WrongTrailerDetected":
      return e.payload.packageId;
    case "MissedUnloadDetected":
      return e.payload.packageId;
    case "PlanGenerated":
      return e.payload.planId;
    case "PlanAccepted":
      return e.payload.planId;
    // Phase-9 (v1.2) driver-lifecycle + load/unload phase events.
    case "DriverRegistered":
      return e.payload.driverId;
    case "DriverAssignedToTrip":
      return e.payload.driverId;
    case "DriverDutyStateChanged":
      return e.payload.driverId;
    case "DriverSwappedAtHub":
      return e.payload.incomingDriverId;
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
      return e.payload.trailerId;
    // SP2 (v1.3) rest/fuel stop events.
    case "TruckRested":
      return e.payload.trailerId;
    case "TruckRefueled":
      return e.payload.trailerId;
    // v2.0 external induction (IND-01).
    case "PackageInducted":
      return e.payload.packageId;
    // v2.0 bidirectional freight / consolidation (FLOW-04 / D-21-1).
    case "PlanSuperseded":
      return e.payload.priorPlanId;
    // v2.0 outbound delivery (OUT-01) — terminal event.
    case "PackageDelivered":
      return e.payload.packageId;
    default:
      return assertNever(e);
  }
}

describe("DomainEvent closed discriminated union (FND-01)", () => {
  it("covers the 13 pre-v1.2 base event types (8 Phase-1 + 3 Phase-3 RFID + 2 Phase-4 plan)", () => {
    // `ALL_EVENTS` here are the 13 PRE-v1.2 base fixtures; the 7 Phase-9 (v1.2)
    // driver/phase events are fixtured + asserted in events-phase9.unit.test.ts.
    const types = new Set<DomainEventType>(ALL_EVENTS.map((e) => e.type));
    expect(types).toEqual(
      new Set<DomainEventType>([
        "HubRegistered",
        "RouteRegistered",
        "PackageCreated",
        "PackageScanned",
        "PackageArrivedAtHub",
        "TrailerDeparted",
        "TrailerArrivedAtHub",
        "TrailerDocked",
        "RfidObserved",
        "WrongTrailerDetected",
        "MissedUnloadDetected",
        "PlanGenerated",
        "PlanAccepted",
      ]),
    );
  });

  it("every event carries a numeric schemaVersion discriminator (P11)", () => {
    for (const e of ALL_EVENTS) {
      expect(typeof e.schemaVersion).toBe("number");
      // Each Phase-1 event pins its exact version literal (P11) — a stronger
      // guarantee than `number`, and it remains assignable to `number`.
      expectTypeOf(e.schemaVersion).toEqualTypeOf<1>();
      expectTypeOf(e.schemaVersion).toMatchTypeOf<number>();
    }
  });

  it("exhaustive switch over `type` compiles and dispatches every member", () => {
    expect(ALL_EVENTS.map(describeEvent)).toEqual([
      "MEM",
      "R1",
      "P1",
      "P1",
      "P1",
      "T1",
      "T1",
      "T1",
      "TAG-1",
      "P1",
      "P1",
      "PLAN-1",
      "PLAN-1",
    ]);
  });

  it("assertNever throws at runtime if an unreachable branch is hit", () => {
    // Force the unreachable path with an unsafe cast to prove the guard fires.
    expect(() =>
      describeEvent({ type: "Nope" } as unknown as DomainEvent),
    ).toThrow();
  });

  it("DomainEventType is the union of the 25 literal discriminators", () => {
    expectTypeOf<DomainEventType>().toEqualTypeOf<
      | "HubRegistered"
      | "RouteRegistered"
      | "PackageCreated"
      | "PackageScanned"
      | "PackageArrivedAtHub"
      | "TrailerDeparted"
      | "TrailerArrivedAtHub"
      | "TrailerDocked"
      | "RfidObserved"
      | "WrongTrailerDetected"
      | "MissedUnloadDetected"
      | "PlanGenerated"
      | "PlanAccepted"
      // Phase-9 (v1.2) driver-lifecycle + load/unload phase events.
      | "DriverRegistered"
      | "DriverAssignedToTrip"
      | "DriverDutyStateChanged"
      | "DriverSwappedAtHub"
      | "UnloadStarted"
      | "LoadStarted"
      | "UnloadCompleted"
      // SP2 (v1.3) rest/fuel stop events.
      | "TruckRested"
      | "TruckRefueled"
      // v2.0 external induction (IND-01).
      | "PackageInducted"
      // v2.0 bidirectional freight / consolidation (FLOW-04 / D-21-1).
      | "PlanSuperseded"
      // v2.0 outbound delivery (OUT-01) — terminal event.
      | "PackageDelivered"
    >();
  });

  it("each event has the expected payload field types", () => {
    expectTypeOf(packageCreated.payload.sizeClass).toEqualTypeOf<
      "small" | "medium" | "large"
    >();
    expectTypeOf(packageCreated.payload.weight).toEqualTypeOf<number>();
    expectTypeOf(routeRegistered.payload.geometry).toEqualTypeOf<
      [number, number][]
    >();
    expectTypeOf(trailerDeparted.payload.packageIds).toEqualTypeOf<string[]>();
    expectTypeOf(packageScanned.payload.scanType).toEqualTypeOf<
      "inbound" | "outbound" | "load" | "unload"
    >();
  });
});

describe("Phase-1 entity types (FND-01)", () => {
  it("Hub has identity + WGS84 position", () => {
    const hub: Hub = { hubId: "MEM", name: "Memphis", lat: 35.1, lon: -90.0 };
    expect(hub.hubId).toBe("MEM");
    expectTypeOf<Hub>().toMatchObjectType<{
      hubId: string;
      name: string;
      lat: number;
      lon: number;
    }>();
  });

  it("Package references origin/dest hubs, size class and weight", () => {
    const pkg: Package = {
      packageId: "P1",
      originHubId: "MEM",
      destHubId: "ORD",
      sizeClass: "small",
      weight: 1,
    };
    expect(pkg.packageId).toBe("P1");
  });

  it("Trailer, Route, Trip, DockDoor exist with their referenced fields", () => {
    const door: DockDoor = { dockDoorId: "DOCK-12", hubId: "MEM" };
    const trailer: Trailer = { trailerId: "T1", currentHubId: "MEM" };
    const route: Route = {
      routeId: "R1",
      fromHubId: "MEM",
      toHubId: "ORD",
      geometry: [
        [-90.049, 35.1495],
        [-87.6298, 41.8781],
      ],
    };
    const trip: Trip = {
      tripId: "TRIP-1",
      trailerId: "T1",
      fromHubId: "MEM",
      toHubId: "ORD",
    };
    expect([door.dockDoorId, trailer.trailerId, route.routeId, trip.tripId]).toEqual(
      ["DOCK-12", "T1", "R1", "TRIP-1"],
    );
  });

  it("LoadBlock and TrailerSlice carry their Phase-2 fields", () => {
    // Fleshed out in Phase 2: LoadBlock carries its id + 7-part key; TrailerSlice
    // carries depth (0 = rear). Full-shape assertions live in
    // entities-phase2.unit.test.ts.
    expectTypeOf<LoadBlock>().toHaveProperty("loadBlockId");
    expectTypeOf<LoadBlock>().toHaveProperty("key");
    expectTypeOf<TrailerSlice>().toHaveProperty("depth");
  });
});

describe("zero-dependency leaf (FND-01)", () => {
  it("a HubRegistered constructed via the entity type is union-assignable", () => {
    const hub: Hub = { hubId: "MEM", name: "Memphis", lat: 1, lon: 2 };
    const e: DomainEvent = { type: "HubRegistered", schemaVersion: 1, payload: hub };
    expect(e.type).toBe("HubRegistered");
  });
});
