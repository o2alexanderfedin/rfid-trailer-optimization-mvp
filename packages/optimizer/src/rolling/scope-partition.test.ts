import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";

import { detectAffectedScope, partitionScopeByCenter } from "./scope.js";
import type { Epoch } from "./types.js";

/**
 * NET-05 (Phase 23) — the per-center SCOPE PARTITION.
 *
 * `partitionScopeByCenter(scope, centerOf)` groups a flat {@link detectAffectedScope}
 * result by each hub's owning center, so a single center's rolling epoch contains
 * ONLY that center's hubs/trailers (its slice size is independent of the rest of
 * the continental network — the real scaling fix). It is ADDITIVE: the original
 * `detectAffectedScope` output is unchanged (legacy byte-identical), and the
 * partition's UNION reproduces the flat scope (no hub lost).
 */

const EPOCH: Epoch = { epochId: "e1", nowMin: 100, freezeWindowMin: 15 };

function departed(trailerId: string, fromHubId: string, toHubId: string): DomainEvent {
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

// Two centers, RA (hubs RA + SA1/SA2) and RB (hubs RB + SB1/SB2), plus a third
// center RC with many spokes (the scope-size-invariant control).
const CENTER_OF = new Map<string, string>([
  ["RA", "RA"],
  ["SA1", "RA"],
  ["SA2", "RA"],
  ["RB", "RB"],
  ["SB1", "RB"],
  ["SB2", "RB"],
  ["RC", "RC"],
  ["SC1", "RC"],
  ["SC2", "RC"],
  ["SC3", "RC"],
  ["SC4", "RC"],
  ["SC5", "RC"],
]);

describe("detectAffectedScope — legacy unchanged (NET-05 additive regression)", () => {
  it("the flat scope is byte-identical whether or not a partition is applied afterward", () => {
    const events: DomainEvent[] = [
      departed("T1", "RA", "SA1"),
      arrived("T2", "SB1"),
    ];
    const scope = detectAffectedScope(events, EPOCH);
    // The flat scope is exactly the sorted/deduped union (today's behavior).
    expect(scope.hubIds).toEqual(["RA", "SA1", "SB1"]);
    expect(scope.trailerIds).toEqual(["T1", "T2"]);
    // Partitioning afterward does NOT mutate the input scope.
    const before = JSON.stringify(scope);
    partitionScopeByCenter(scope, CENTER_OF);
    expect(JSON.stringify(scope)).toBe(before);
  });
});

describe("partitionScopeByCenter — per-center slices (NET-05)", () => {
  it("groups the affected hubs into disjoint-by-center scopes, each a subset of its center's hubs", () => {
    const events: DomainEvent[] = [
      departed("T1", "RA", "SA1"), // RA, SA1 -> center RA
      arrived("T2", "SB1"), // SB1 -> center RB
      departed("T3", "SA2", "RA"), // SA2, RA -> center RA
    ];
    const flat = detectAffectedScope(events, EPOCH);
    const byCenter = partitionScopeByCenter(flat, CENTER_OF);

    // Exactly two centers are touched: RA and RB.
    expect([...byCenter.keys()].sort()).toEqual(["RA", "RB"]);

    const ra = byCenter.get("RA")!;
    const rb = byCenter.get("RB")!;

    // Each slice's hubs all belong to that center.
    for (const h of ra.hubIds) expect(CENTER_OF.get(h)).toBe("RA");
    for (const h of rb.hubIds) expect(CENTER_OF.get(h)).toBe("RB");

    // Disjoint by center (no hub appears in two slices).
    const raSet = new Set(ra.hubIds);
    for (const h of rb.hubIds) expect(raSet.has(h)).toBe(false);

    // The slices are sorted + deduped (anti-P7).
    expect(ra.hubIds).toEqual([...ra.hubIds].sort());
    expect(new Set(ra.hubIds).size).toBe(ra.hubIds.length);

    // The horizon knobs are carried through unchanged.
    expect(ra.horizonStartMin).toBe(flat.horizonStartMin);
    expect(ra.horizonEndMin).toBe(flat.horizonEndMin);
    expect(ra.timeStepMin).toBe(flat.timeStepMin);
  });

  it("the UNION of the per-center hubIds equals the flat scope hubIds (no hub lost)", () => {
    const events: DomainEvent[] = [
      departed("T1", "RA", "SA1"),
      arrived("T2", "SB1"),
      departed("T3", "SC4", "RC"),
    ];
    const flat = detectAffectedScope(events, EPOCH);
    const byCenter = partitionScopeByCenter(flat, CENTER_OF);

    const union = new Set<string>();
    for (const slice of byCenter.values()) for (const h of slice.hubIds) union.add(h);
    expect([...union].sort()).toEqual(flat.hubIds);
  });

  it("partitions trailers by the center of the hubs they touch in the same batch", () => {
    const events: DomainEvent[] = [
      departed("T1", "RA", "SA1"), // T1 touches center RA
      arrived("T2", "SB1"), // T2 touches center RB
    ];
    const flat = detectAffectedScope(events, EPOCH);
    const byCenter = partitionScopeByCenter(flat, CENTER_OF);

    expect(byCenter.get("RA")!.trailerIds).toContain("T1");
    expect(byCenter.get("RB")!.trailerIds).toContain("T2");
    // T1 is NOT pulled into RB's slice (one center never pulls another's trailers).
    expect(byCenter.get("RB")!.trailerIds).not.toContain("T1");
  });

  it("scope-size invariant: a single-center event's slice is independent of other centers' hub counts", () => {
    // One event entirely within center RA.
    const flat = detectAffectedScope([departed("T1", "RA", "SA1")], EPOCH);

    // Two center maps: one with a SMALL RC, one with a HUGE RC. RA's slice must be
    // identical regardless of how many hubs the OTHER centers have.
    const smallNetwork = new Map(CENTER_OF);
    const hugeNetwork = new Map(CENTER_OF);
    for (let i = 0; i < 500; i += 1) hugeNetwork.set(`HUGE${i}`, "RC");

    const raSmall = partitionScopeByCenter(flat, smallNetwork).get("RA")!;
    const raHuge = partitionScopeByCenter(flat, hugeNetwork).get("RA")!;

    expect(raHuge.hubIds).toEqual(raSmall.hubIds);
    expect(raHuge.hubIds.length).toBe(2); // RA + SA1, independent of RC's size
    expect([...partitionScopeByCenter(flat, hugeNetwork).keys()]).toEqual(["RA"]);
  });

  it("a hub with no center mapping is grouped under itself (defensive fallback)", () => {
    const flat = detectAffectedScope([arrived("T1", "ORPHAN")], EPOCH);
    const byCenter = partitionScopeByCenter(flat, CENTER_OF);
    expect(byCenter.get("ORPHAN")!.hubIds).toEqual(["ORPHAN"]);
  });
});
