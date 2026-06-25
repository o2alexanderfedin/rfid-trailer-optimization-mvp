import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";

import { detectAffectedScope } from "./scope.js";
import type { Epoch } from "./types.js";

/**
 * OPT-05: a rolling epoch is SCOPED to only the hubs/trailers referenced by the
 * new events — never the whole network. `detectAffectedScope(events, epoch)`
 * collects exactly the referenced ids (sorted, deduped) and bounds the horizon
 * from the epoch clock — so a 10-hub network with events touching 2 hubs yields a
 * scope of those 2.
 */

const EPOCH: Epoch = { epochId: "e1", nowMin: 100, freezeWindowMin: 15 };

function departed(
  trailerId: string,
  fromHubId: string,
  toHubId: string,
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId: `${trailerId}-trip`, packageIds: [] },
  };
}

function arrived(trailerId: string, hubId: string): DomainEvent {
  return {
    type: "TrailerArrivedAtHub",
    schemaVersion: 1,
    payload: { trailerId, hubId, tripId: `${trailerId}-trip` },
  };
}

function inducted(inductionHubId: string, destHubId: string): DomainEvent {
  return {
    type: "PackageInducted",
    schemaVersion: 1,
    payload: {
      packageId: "EXT-P00001",
      inductionHubId,
      destHubId,
      slaClass: "express",
      slaDeadlineIso: "2026-06-24T12:00:00.000Z",
      externalOriginRef: "EXT-00001",
      occurredAt: "2026-06-24T08:00:00.000Z",
    },
  };
}

describe("detectAffectedScope (OPT-05 scoped epoch)", () => {
  it("collects ONLY the hubs/trailers referenced by the events, not the whole network", () => {
    const events: DomainEvent[] = [
      departed("T1", "H1", "H2"),
      arrived("T2", "H3"),
    ];
    const scope = detectAffectedScope(events, EPOCH);

    expect([...scope.hubIds].sort()).toEqual(["H1", "H2", "H3"]);
    expect([...scope.trailerIds].sort()).toEqual(["T1", "T2"]);
  });

  it("dedupes repeated ids and returns sorted, stable arrays (determinism)", () => {
    const events: DomainEvent[] = [
      departed("T1", "H2", "H1"),
      departed("T1", "H1", "H2"),
      arrived("T1", "H2"),
    ];
    const scope = detectAffectedScope(events, EPOCH);

    expect(scope.hubIds).toEqual(["H1", "H2"]);
    expect(scope.trailerIds).toEqual(["T1"]);
  });

  it("derives the horizon from the epoch clock (nowMin), never the wall clock", () => {
    const scope = detectAffectedScope([departed("T1", "H1", "H2")], EPOCH);
    expect(scope.horizonStartMin).toBe(EPOCH.nowMin);
    expect(scope.horizonEndMin).toBeGreaterThan(EPOCH.nowMin);
    expect(scope.timeStepMin).toBeGreaterThan(0);
  });

  it("yields an EMPTY scope for an empty event batch (nothing affected)", () => {
    const scope = detectAffectedScope([], EPOCH);
    expect(scope.hubIds).toEqual([]);
    expect(scope.trailerIds).toEqual([]);
  });

  // v2.0 IND-03: a PackageInducted event re-scopes the optimizer to BOTH the
  // induction hub (new demand origin) and the destination hub — not [] (Pitfall 3).
  it("PackageInducted scopes to [inductionHubId, destHubId] (IND-03)", () => {
    const scope = detectAffectedScope([inducted("HA", "HB")], EPOCH);
    expect([...scope.hubIds].sort()).toEqual(["HA", "HB"]);
    expect(scope.trailerIds).toEqual([]);
  });
});
