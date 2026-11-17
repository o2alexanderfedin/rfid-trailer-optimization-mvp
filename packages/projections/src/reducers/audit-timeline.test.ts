import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import { type StoredEventLike, auditTimelineReducer } from "./audit-timeline.js";

/**
 * Plan 05-04 Task 1 (TDD RED → GREEN): audit-timeline reducer extended to index
 * trailer streams + capture the recommendation on plan-lifecycle events.
 *
 * Tests:
 *  1. Trailer-naming events (TrailerDeparted/ArrivedAtHub/Docked) produce trailer-
 *     keyed entries (trailerId set, packageId null).
 *  2. PlanGenerated / PlanAccepted produce trailer-keyed entries carrying the
 *     captured recommendation text.
 *  3. Package-naming events still produce their package-keyed entries (regression
 *     guard).
 *  4. Non-entity events (HubRegistered, RouteRegistered, RfidObserved, etc.) still
 *     return null (no spurious rows).
 *  5. Golden-replay: the reducer is a PURE function of the stored event — identical
 *     inputs always produce deep-equal output (FND-04 discipline).
 *  6. Idempotency (P5a): re-applying the same stored event produces the same entry
 *     (the upsert target is the same `global_seq` row — no duplicate).
 */

const T0 = Date.parse("2026-02-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function stored(event: DomainEvent, globalSeq: bigint, occurredAt: string): StoredEventLike {
  return { event, globalSeq, occurredAt };
}

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function trailerDeparted(
  trailerId: string,
  fromHubId: string,
  toHubId: string,
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: {
      trailerId,
      fromHubId,
      toHubId,
      tripId: "TRIP1",
      packageIds: [],
    },
  };
}

function trailerArrived(trailerId: string, hubId: string): DomainEvent {
  return {
    type: "TrailerArrivedAtHub",
    schemaVersion: 1,
    payload: { trailerId, hubId, tripId: "TRIP1" },
  };
}

function trailerDocked(trailerId: string, hubId: string): DomainEvent {
  return {
    type: "TrailerDocked",
    schemaVersion: 1,
    payload: { trailerId, hubId, dockDoorId: "DOCK7" },
  };
}

function planGenerated(trailerId: string, objectiveCost: number): DomainEvent {
  return {
    type: "PlanGenerated",
    schemaVersion: 1,
    payload: {
      epochId: "E1",
      scopeHash: "HASH1",
      planId: "PLAN1",
      trailerId,
      objectiveCost,
      feasible: true,
      occurredAt: at(0),
    },
  };
}

function planAccepted(trailerId: string): DomainEvent {
  return {
    type: "PlanAccepted",
    schemaVersion: 1,
    payload: {
      epochId: "E1",
      scopeHash: "HASH1",
      planId: "PLAN1",
      trailerId,
      occurredAt: at(0),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: trailer-naming events
// ---------------------------------------------------------------------------

describe("auditTimelineReducer — trailer streams (Task 1 extension)", () => {
  it("TrailerDeparted produces a trailer-keyed entry with null packageId", () => {
    const entry = auditTimelineReducer(
      stored(trailerDeparted("T1", "MEM", "DFW"), 1n, at(0)),
    );
    expect(entry).not.toBeNull();
    expect(entry?.trailerId).toBe("T1");
    expect(entry?.packageId).toBeNull();
    expect(entry?.eventType).toBe("TrailerDeparted");
    expect(entry?.globalSeq).toBe(1n);
    expect(entry?.occurredAt).toBe(at(0));
    expect(entry?.hubId).toBe("MEM");
    expect(entry?.scanType).toBeNull();
    expect(entry?.recommendation).toBeNull();
  });

  it("TrailerArrivedAtHub produces a trailer-keyed entry with arrival hub", () => {
    const entry = auditTimelineReducer(
      stored(trailerArrived("T1", "DFW"), 2n, at(1_000)),
    );
    expect(entry).not.toBeNull();
    expect(entry?.trailerId).toBe("T1");
    expect(entry?.packageId).toBeNull();
    expect(entry?.eventType).toBe("TrailerArrivedAtHub");
    expect(entry?.hubId).toBe("DFW");
    expect(entry?.recommendation).toBeNull();
  });

  it("TrailerDocked produces a trailer-keyed entry", () => {
    const entry = auditTimelineReducer(
      stored(trailerDocked("T1", "DFW"), 3n, at(2_000)),
    );
    expect(entry).not.toBeNull();
    expect(entry?.trailerId).toBe("T1");
    expect(entry?.packageId).toBeNull();
    expect(entry?.eventType).toBe("TrailerDocked");
    expect(entry?.hubId).toBe("DFW");
  });

  // ---------------------------------------------------------------------------
  // Tests: PlanGenerated / PlanAccepted capture the recommendation
  // ---------------------------------------------------------------------------

  it("PlanGenerated produces a trailer-keyed entry with the captured recommendation", () => {
    const entry = auditTimelineReducer(
      stored(planGenerated("T1", 42.5), 10n, at(5_000)),
    );
    expect(entry).not.toBeNull();
    expect(entry?.trailerId).toBe("T1");
    expect(entry?.packageId).toBeNull();
    expect(entry?.eventType).toBe("PlanGenerated");
    expect(entry?.hubId).toBeNull();
    expect(entry?.scanType).toBeNull();
    // recommendation is captured from the payload (objective cost + feasibility)
    expect(entry?.recommendation).not.toBeNull();
    expect(entry?.recommendation).toContain("42.5");
  });

  it("PlanAccepted produces a trailer-keyed entry with acceptance recorded", () => {
    const entry = auditTimelineReducer(
      stored(planAccepted("T1"), 11n, at(5_100)),
    );
    expect(entry).not.toBeNull();
    expect(entry?.trailerId).toBe("T1");
    expect(entry?.packageId).toBeNull();
    expect(entry?.eventType).toBe("PlanAccepted");
    expect(entry?.recommendation).not.toBeNull();
    expect(entry?.recommendation).toContain("PLAN1");
  });

  // ---------------------------------------------------------------------------
  // Regression: package-naming events still work
  // ---------------------------------------------------------------------------

  it("PackageCreated still produces a package-keyed entry", () => {
    const event: DomainEvent = {
      type: "PackageCreated",
      schemaVersion: 1,
      payload: {
        packageId: "P1",
        originHubId: "MEM",
        destHubId: "DFW",
        sizeClass: "medium",
        weight: 4.2,
        rfidTagId: "TAG1",
      },
    };
    const entry = auditTimelineReducer(stored(event, 20n, at(0)));
    expect(entry).not.toBeNull();
    expect(entry?.packageId).toBe("P1");
    expect(entry?.trailerId).toBeNull();
    expect(entry?.recommendation).toBeNull();
  });

  it("PackageScanned still produces a package-keyed entry", () => {
    const event: DomainEvent = {
      type: "PackageScanned",
      schemaVersion: 1,
      payload: { packageId: "P2", hubId: "DFW", scanType: "inbound" },
    };
    const entry = auditTimelineReducer(stored(event, 21n, at(500)));
    expect(entry).not.toBeNull();
    expect(entry?.packageId).toBe("P2");
    expect(entry?.trailerId).toBeNull();
    expect(entry?.scanType).toBe("inbound");
  });

  // ---------------------------------------------------------------------------
  // Non-entity events still return null
  // ---------------------------------------------------------------------------

  it("HubRegistered returns null (not a package or trailer event)", () => {
    const event: DomainEvent = {
      type: "HubRegistered",
      schemaVersion: 1,
      payload: { hubId: "MEM", name: "Memphis", lat: 35.04, lon: -89.97 },
    };
    expect(auditTimelineReducer(stored(event, 30n, at(0)))).toBeNull();
  });

  it("RouteRegistered returns null", () => {
    const event: DomainEvent = {
      type: "RouteRegistered",
      schemaVersion: 1,
      payload: {
        routeId: "R1",
        fromHubId: "MEM",
        toHubId: "DFW",
        geometry: [[-89, 35]],
      },
    };
    expect(auditTimelineReducer(stored(event, 31n, at(0)))).toBeNull();
  });

  it("RfidObserved returns null (separate observed layer)", () => {
    const event: DomainEvent = {
      type: "RfidObserved",
      schemaVersion: 1,
      payload: {
        tagId: "TAG1",
        readerId: "R1",
        antennaId: "ANT1",
        rssi: -65,
        trailerId: "T1",
        hubId: "MEM",
        confidence: 0.8,
      },
    };
    expect(auditTimelineReducer(stored(event, 32n, at(0)))).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Phase-25 COORD-03: SuggestionRejected / SuggestionAccepted audit rows
  // ---------------------------------------------------------------------------

  it("SuggestionRejected produces an audit row carrying occurredAt + reasonCode + suggestionId", () => {
    const event: DomainEvent = {
      type: "SuggestionRejected",
      schemaVersion: 1,
      payload: { suggestionId: "HUB-CTR-100-0", reasonCode: "hos", occurredAt: at(0) },
    };
    const entry = auditTimelineReducer(stored(event, 40n, at(0)));
    expect(entry).not.toBeNull();
    expect(entry?.eventType).toBe("SuggestionRejected");
    expect(entry?.globalSeq).toBe(40n);
    expect(entry?.occurredAt).toBe(at(0));
    // reasonCode is carried for the audit trail; the suggestionId surfaces in the
    // recommendation text (the captured rationale slot).
    expect(entry?.reasonCode).toBe("hos");
    expect(entry?.recommendation).toContain("HUB-CTR-100-0");
    expect(entry?.recommendation).toContain("hos");
  });

  it("SuggestionAccepted produces an audit row (no reasonCode)", () => {
    const event: DomainEvent = {
      type: "SuggestionAccepted",
      schemaVersion: 1,
      payload: { suggestionId: "HUB-CTR-100-1", occurredAt: at(1_000) },
    };
    const entry = auditTimelineReducer(stored(event, 41n, at(1_000)));
    expect(entry).not.toBeNull();
    expect(entry?.eventType).toBe("SuggestionAccepted");
    expect(entry?.reasonCode).toBeNull();
    expect(entry?.recommendation).toContain("HUB-CTR-100-1");
  });

  it("ActionSuggested remains a no-op (null) in the audit timeline this phase", () => {
    const event: DomainEvent = {
      type: "ActionSuggested",
      schemaVersion: 1,
      payload: {
        suggestionId: "S-1",
        coordinatorId: "HUB-CTR",
        targetAgentId: "T0001",
        kind: "reroute",
        params: { toHubId: "HUB-CTR" },
        issuedAtSimMs: 1000,
        ttlSimMs: 360000,
      },
    };
    expect(auditTimelineReducer(stored(event, 42n, at(0)))).toBeNull();
  });

  it("SuggestionRejected audit rows are PURE (deep-equal across two calls)", () => {
    const e = stored(
      {
        type: "SuggestionRejected",
        schemaVersion: 1,
        payload: { suggestionId: "S-PURE", reasonCode: "dock", occurredAt: at(0) },
      },
      52n,
      at(0),
    );
    expect(auditTimelineReducer(e)).toEqual(auditTimelineReducer(e));
  });

  // ---------------------------------------------------------------------------
  // FND-04 golden-replay: the reducer is a pure function of the stored event
  // ---------------------------------------------------------------------------

  it("produces deep-equal output when called twice with the same stored event (purity)", () => {
    const e = stored(trailerDeparted("T2", "ATL", "LAX"), 50n, at(10_000));
    expect(auditTimelineReducer(e)).toEqual(auditTimelineReducer(e));
  });

  it("produces deep-equal output for PlanGenerated across two calls", () => {
    const e = stored(planGenerated("T3", 99.9), 51n, at(20_000));
    expect(auditTimelineReducer(e)).toEqual(auditTimelineReducer(e));
  });

  // ---------------------------------------------------------------------------
  // P5a idempotency: same global_seq → same row identity (no duplicate)
  // ---------------------------------------------------------------------------

  it("re-applying a trailer event yields the same entry (idempotency target)", () => {
    const e = stored(trailerArrived("T1", "LAX"), 100n, at(30_000));
    const first = auditTimelineReducer(e);
    const second = auditTimelineReducer(e);
    expect(first).toEqual(second);
    // The identity is globalSeq — same event → same row target
    expect(first?.globalSeq).toBe(100n);
  });
});
