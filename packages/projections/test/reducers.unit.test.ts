import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  DIRECT_SCAN_CONFIDENCE,
  emptyHubInventoryState,
  emptyPackageLocationState,
  emptyTrailerStateMap,
  hubInventoryReducer,
  type OccurredEvent,
  packageLocationReducer,
  trailerStateReducer,
} from "../src/index.js";

/**
 * Task 1 (RED → GREEN): pure operational reducers (FND-05/06/07) with NO DB.
 *
 * The reducers are folded over a hand-seeded `OccurredEvent[]` (event + its
 * domain `occurredAt`). The tests assert (a) the documented projected state,
 * (b) purity — identical input yields deep-equal output and replaying the same
 * list twice from empty is identical, and (c) the determinism guard — stable,
 * total ordering independent of payload-array order.
 */

const T0 = Date.parse("2026-02-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function evt(event: DomainEvent, occurredAt: string): OccurredEvent {
  return { event, occurredAt };
}

function scanned(
  packageId: string,
  hubId: string,
  scanType: "inbound" | "outbound" | "load" | "unload",
): DomainEvent {
  return {
    type: "PackageScanned",
    schemaVersion: 1,
    payload: { packageId, hubId, scanType },
  };
}

function arrived(packageId: string, hubId: string): DomainEvent {
  return {
    type: "PackageArrivedAtHub",
    schemaVersion: 1,
    payload: { packageId, hubId },
  };
}

// v2.0 IND-01: an externally-induced package entering at a spoke hub.
function inducted(
  packageId: string,
  inductionHubId: string,
  destHubId: string,
  occurredAt: string,
): DomainEvent {
  return {
    type: "PackageInducted",
    schemaVersion: 1,
    payload: {
      packageId,
      inductionHubId,
      destHubId,
      slaClass: "express",
      slaDeadlineIso: "2026-06-24T12:00:00.000Z",
      externalOriginRef: `EXT-${packageId}`,
      occurredAt,
    },
  };
}

function departed(
  trailerId: string,
  fromHubId: string,
  toHubId: string,
  tripId: string,
  packageIds: string[],
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId, packageIds },
  };
}

function trailerArrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return {
    type: "TrailerArrivedAtHub",
    schemaVersion: 1,
    payload: { trailerId, hubId, tripId },
  };
}

function docked(trailerId: string, hubId: string, dockDoorId: string): DomainEvent {
  return {
    type: "TrailerDocked",
    schemaVersion: 1,
    payload: { trailerId, hubId, dockDoorId },
  };
}

function driverAssigned(
  driverId: string,
  tripId: string,
  trailerId: string,
  occurredAt: string,
): DomainEvent {
  return {
    type: "DriverAssignedToTrip",
    schemaVersion: 1,
    payload: { driverId, tripId, trailerId, occurredAt },
  };
}

function driverSwapped(
  outgoingDriverId: string,
  incomingDriverId: string,
  hubId: string,
  tripId: string,
  trailerId: string,
  occurredAt: string,
): DomainEvent {
  return {
    type: "DriverSwappedAtHub",
    schemaVersion: 1,
    payload: { outgoingDriverId, incomingDriverId, hubId, tripId, trailerId, occurredAt },
  };
}

function foldPackage(events: OccurredEvent[]) {
  return events.reduce(packageLocationReducer, emptyPackageLocationState);
}
function foldTrailer(events: OccurredEvent[]) {
  return events.reduce(trailerStateReducer, emptyTrailerStateMap);
}
function foldHub(events: OccurredEvent[]) {
  return events.reduce(hubInventoryReducer, emptyHubInventoryState);
}

// ---------------------------------------------------------------------------
// FND-05: package last-seen location + confidence + timestamp
// ---------------------------------------------------------------------------
describe("packageLocationReducer (FND-05)", () => {
  it("projects last-seen hub + confidence + timestamp from the latest sighting", () => {
    const events = [
      evt(arrived("P1", "MEM"), at(0)),
      evt(scanned("P1", "MEM", "inbound"), at(1_000)),
      evt(scanned("P1", "DFW", "outbound"), at(2_000)),
    ];
    const state = foldPackage(events);
    expect(state.get("P1")).toEqual({
      packageId: "P1",
      hubId: "DFW",
      confidence: DIRECT_SCAN_CONFIDENCE,
      lastSeenAt: at(2_000),
    });
  });

  it("tracks multiple packages independently", () => {
    const state = foldPackage([
      evt(scanned("P1", "MEM", "inbound"), at(0)),
      evt(scanned("P2", "LAX", "inbound"), at(1_000)),
    ]);
    expect(state.get("P1")?.hubId).toBe("MEM");
    expect(state.get("P2")?.hubId).toBe("LAX");
    expect(state.size).toBe(2);
  });

  it("confidence is the fixed direct-scan value (1.0) — field present for FND-05", () => {
    const state = foldPackage([evt(scanned("P1", "MEM", "inbound"), at(0))]);
    expect(state.get("P1")?.confidence).toBe(1);
  });

  it("all time values originate from event.occurredAt, never the wall clock", () => {
    const ts = at(99_000);
    const state = foldPackage([evt(scanned("P1", "MEM", "inbound"), ts)]);
    expect(state.get("P1")?.lastSeenAt).toBe(ts);
  });

  // v2.0 IND-01: external induction places the package at its INDUCTION hub
  // (the first network-visible sighting), keyed off `occurredAt`.
  it("PackageInducted sets last-known-location to inductionHubId (IND-01)", () => {
    const ts = at(7_000);
    const state = foldPackage([
      evt(inducted("EXT-P00001", "MEM", "DFW", ts), ts),
    ]);
    expect(state.get("EXT-P00001")).toEqual({
      packageId: "EXT-P00001",
      hubId: "MEM",
      confidence: DIRECT_SCAN_CONFIDENCE,
      lastSeenAt: ts,
    });
  });
});

// ---------------------------------------------------------------------------
// FND-06: trailer current state / assignment
// ---------------------------------------------------------------------------
describe("trailerStateReducer (FND-06)", () => {
  it("departure sets in_transit, captures trip + manifest, clears hub", () => {
    const state = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P3", "P1", "P2"]), at(0)),
    ]);
    expect(state.get("T1")).toEqual({
      trailerId: "T1",
      status: "in_transit",
      currentHubId: null,
      tripId: "TRIP1",
      dockDoorId: null,
      assignedPackageIds: ["P1", "P2", "P3"], // sorted, order-stable
      driverId: null,
      lastEventAt: at(0),
    });
  });

  it("arrival sets arrived + current hub, carrying the manifest forward", () => {
    const state = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1", "P2"]), at(0)),
      evt(trailerArrived("T1", "DFW", "TRIP1"), at(1_000)),
    ]);
    expect(state.get("T1")).toMatchObject({
      status: "arrived",
      currentHubId: "DFW",
      tripId: "TRIP1",
      assignedPackageIds: ["P1", "P2"],
      lastEventAt: at(1_000),
    });
  });

  it("docking sets docked + dock door, keeping current hub", () => {
    const state = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1"]), at(0)),
      evt(trailerArrived("T1", "DFW", "TRIP1"), at(1_000)),
      evt(docked("T1", "DFW", "DOCK7"), at(2_000)),
    ]);
    expect(state.get("T1")).toMatchObject({
      status: "docked",
      currentHubId: "DFW",
      dockDoorId: "DOCK7",
      tripId: "TRIP1",
    });
  });

  // PRJ-02: the assigned driver is stamped onto trailer_state (join-free hub
  // detail) from DriverAssignedToTrip / DriverSwappedAtHub.
  it("departure leaves driverId null until a driver is assigned", () => {
    const state = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1"]), at(0)),
    ]);
    expect(state.get("T1")?.driverId).toBeNull();
  });

  it("DriverAssignedToTrip stamps the driverId onto the trailer row", () => {
    const state = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1"]), at(0)),
      evt(driverAssigned("D1", "TRIP1", "T1", at(1_000)), at(1_000)),
    ]);
    expect(state.get("T1")).toMatchObject({
      trailerId: "T1",
      status: "in_transit",
      driverId: "D1",
      lastEventAt: at(1_000),
    });
  });

  it("DriverSwappedAtHub restamps the trailer's driverId to the incoming driver", () => {
    const state = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1"]), at(0)),
      evt(driverAssigned("D1", "TRIP1", "T1", at(1_000)), at(1_000)),
      evt(driverSwapped("D1", "D2", "DFW", "TRIP1", "T1", at(2_000)), at(2_000)),
    ]);
    expect(state.get("T1")?.driverId).toBe("D2");
    expect(state.get("T1")?.lastEventAt).toBe(at(2_000));
  });

  it("the assigned driverId carries across subsequent lifecycle events", () => {
    const state = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1"]), at(0)),
      evt(driverAssigned("D1", "TRIP1", "T1", at(1_000)), at(1_000)),
      evt(trailerArrived("T1", "DFW", "TRIP1"), at(2_000)),
      evt(docked("T1", "DFW", "DOCK7"), at(3_000)),
    ]);
    expect(state.get("T1")?.driverId).toBe("D1");
    expect(state.get("T1")?.status).toBe("docked");
  });

  it("a DriverAssignedToTrip for an unseen trailer creates the stamped row", () => {
    const state = foldTrailer([evt(driverAssigned("D1", "TRIP1", "T9", at(0)), at(0))]);
    expect(state.get("T9")?.driverId).toBe("D1");
  });
});

// ---------------------------------------------------------------------------
// FND-07: hub inventory inbound / outbound / staged
// ---------------------------------------------------------------------------
describe("hubInventoryReducer (FND-07)", () => {
  it("buckets packages by their latest scan type per hub", () => {
    const state = foldHub([
      evt(arrived("P1", "MEM"), at(0)), // inbound
      evt(scanned("P2", "MEM", "inbound"), at(1_000)), // inbound
      evt(scanned("P3", "MEM", "unload"), at(2_000)), // staged
      evt(scanned("P4", "MEM", "outbound"), at(3_000)), // outbound
    ]);
    expect(state.hubs.get("MEM")).toEqual({
      hubId: "MEM",
      inbound: ["P1", "P2"],
      staged: ["P3"],
      outbound: ["P4"],
    });
  });

  // IND-03 / Decision 3: externally-induced freight enters the induction hub's
  // INBOUND bucket — the same optimizer demand path as PackageArrivedAtHub.
  it("PackageInducted places the package in inductionHubId.inbound (IND-03)", () => {
    const state = foldHub([
      evt(inducted("EXT-P00001", "MEM", "DFW", at(0)), at(0)),
    ]);
    const mem = state.hubs.get("MEM");
    expect(mem?.inbound).toEqual(["EXT-P00001"]);
    expect(mem?.outbound).toEqual([]);
    expect(mem?.staged).toEqual([]);
    // It lands at the INDUCTION hub, not the destination hub.
    expect(state.hubs.get("DFW")).toBeUndefined();
  });

  it("moving a package to a new bucket removes it from the old (no double-count)", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "inbound"), at(0)),
      evt(scanned("P1", "MEM", "outbound"), at(1_000)),
    ]);
    const mem = state.hubs.get("MEM");
    expect(mem?.inbound).toEqual([]);
    expect(mem?.outbound).toEqual(["P1"]);
  });

  it("a load scan removes the package from hub inventory entirely", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "inbound"), at(0)),
      evt(scanned("P1", "MEM", "load"), at(1_000)),
    ]);
    const mem = state.hubs.get("MEM");
    expect(mem?.inbound).toEqual([]);
    expect(mem?.outbound).toEqual([]);
    expect(mem?.staged).toEqual([]);
  });

  it("moving a package across hubs removes it from the prior hub", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "inbound"), at(0)),
      evt(scanned("P1", "DFW", "inbound"), at(1_000)),
    ]);
    expect(state.hubs.get("MEM")?.inbound).toEqual([]);
    expect(state.hubs.get("DFW")?.inbound).toEqual(["P1"]);
  });

  // M-3 (FND-07): TrailerDeparted carries an authoritative `packageIds` manifest.
  // A departure WITHOUT explicit per-package `load` scans must still decrement the
  // SOURCE hub's inventory using that manifest — otherwise the package lingers in
  // an outbound/staged bucket forever and over-counts source-hub inventory.
  it("a departure decrements source-hub inventory from the packageIds manifest (no load scan)", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "outbound"), at(0)), // staged outbound, NO load scan
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1"]), at(1_000)),
    ]);
    const mem = state.hubs.get("MEM");
    expect(mem?.outbound).toEqual([]);
    expect(mem?.inbound).toEqual([]);
    expect(mem?.staged).toEqual([]);
  });

  it("a departure removes only its manifest's packages, leaving others in inventory", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "outbound"), at(0)),
      evt(scanned("P2", "MEM", "outbound"), at(1_000)),
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1"]), at(2_000)),
    ]);
    const mem = state.hubs.get("MEM");
    expect(mem?.outbound).toEqual(["P2"]); // P2 stays; only P1 departed
  });

  it("an explicit load scan before departure stays correct (idempotent removal)", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "outbound"), at(0)),
      evt(scanned("P1", "MEM", "load"), at(1_000)), // canonical path: load scan
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1"]), at(2_000)), // redundant now
    ]);
    const mem = state.hubs.get("MEM");
    expect(mem?.outbound).toEqual([]);
    expect(mem?.staged).toEqual([]);
    expect(mem?.inbound).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Purity (PITFALLS P3 / P5a)
// ---------------------------------------------------------------------------
describe("reducer purity + determinism (P3)", () => {
  const seed: OccurredEvent[] = [
    evt(arrived("P1", "MEM"), at(0)),
    evt(scanned("P1", "MEM", "inbound"), at(1_000)),
    evt(scanned("P2", "MEM", "outbound"), at(1_500)),
    evt(departed("T1", "MEM", "DFW", "TRIP1", ["P5", "P1", "P3"]), at(2_000)),
    evt(trailerArrived("T1", "DFW", "TRIP1"), at(3_000)),
  ];

  it("calling a reducer twice with the same (state, event) yields deep-equal output", () => {
    const e = evt(scanned("P9", "MEM", "inbound"), at(10));
    expect(packageLocationReducer(emptyPackageLocationState, e)).toEqual(
      packageLocationReducer(emptyPackageLocationState, e),
    );
    expect(hubInventoryReducer(emptyHubInventoryState, e)).toEqual(
      hubInventoryReducer(emptyHubInventoryState, e),
    );
    const de = evt(departed("T1", "A", "B", "TR", ["x"]), at(10));
    expect(trailerStateReducer(emptyTrailerStateMap, de)).toEqual(
      trailerStateReducer(emptyTrailerStateMap, de),
    );
  });

  it("replaying the same event list twice from empty yields identical state", () => {
    expect(foldPackage(seed)).toEqual(foldPackage(seed));
    expect(foldTrailer(seed)).toEqual(foldTrailer(seed));
    expect(foldHub(seed)).toEqual(foldHub(seed));
  });

  it("manifest order in the payload does not affect projected state (stable sort)", () => {
    const a = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P3", "P1", "P2"]), at(0)),
    ]);
    const b = foldTrailer([
      evt(departed("T1", "MEM", "DFW", "TRIP1", ["P1", "P2", "P3"]), at(0)),
    ]);
    expect(a.get("T1")?.assignedPackageIds).toEqual(b.get("T1")?.assignedPackageIds);
    expect(a).toEqual(b);
  });

  it("scan insertion order does not affect a hub's bucket ordering (sorted ids)", () => {
    const a = foldHub([
      evt(scanned("P3", "MEM", "inbound"), at(0)),
      evt(scanned("P1", "MEM", "inbound"), at(1)),
      evt(scanned("P2", "MEM", "inbound"), at(2)),
    ]);
    expect(a.hubs.get("MEM")?.inbound).toEqual(["P1", "P2", "P3"]);
  });

  it("does not mutate the input state (immutability)", () => {
    const before = foldPackage(seed);
    const snapshot = new Map(before);
    packageLocationReducer(before, evt(scanned("P1", "ATL", "inbound"), at(9_999)));
    expect(before).toEqual(snapshot);
  });
});
