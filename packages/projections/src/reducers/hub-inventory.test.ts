import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  type HubInventoryState,
  emptyHubInventoryState,
  hubInventoryReducer,
} from "./hub-inventory.js";
import type { OccurredEvent } from "./reducer.js";

/**
 * Plan 21-03 Task 1 (TDD RED → GREEN): hub-inventory `PlanSuperseded`
 * delete-then-apply (FLOW-04 / D-21-1; Open-Q1 RESOLVED).
 *
 * STAGED SEMANTICS (Open-Q1/A2): `staged` holds BOTH (i) packages unloaded into
 * the yard (`PackageScanned` scanType="unload") AND (ii) the staged scope of an
 * accepted plan. `PlanAccepted` STAYS A NO-OP — its payload carries NO packageIds
 * (schemas.ts), so it cannot stage anything. `PlanSuperseded` is the ONLY
 * stage-mutating plan event: a dumb pure delete-then-apply that removes the prior
 * plan's HOLISTIC `supersededPackageIds` from inventory, so items in the OLD plan
 * but absent in the NEW are wiped (not stranded) and stale `staged` is never
 * double-counted. NO epoch/scope comparison lives in the reducer (D-21-1).
 *
 * Tests:
 *  1. delete-then-apply: PlanSuperseded[P1,P2] wipes P1,P2 from staged; P3 stays.
 *  2. regression: the unload-scan staging path still works AFTER a PlanSuperseded
 *     for an unrelated scope (the two paths do not interfere).
 *  3. no-double-count: a package in inbound is not also in staged after a
 *     supersession naming it (buckets sum to physically-present count).
 *  4. PlanAccepted no-op: a PlanAccepted leaves staged byte-identical.
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

function accepted(
  trailerId: string,
  occurredAt: string,
  epochId = "E1",
  scopeHash = "S1",
  planId = "PLAN1",
): DomainEvent {
  return {
    type: "PlanAccepted",
    schemaVersion: 1,
    payload: { epochId, scopeHash, planId, trailerId, occurredAt },
  };
}

function superseded(
  trailerId: string,
  supersededPackageIds: string[],
  occurredAt: string,
  epochId = "E2",
  scopeHash = "S2",
  priorPlanId = "PLAN1",
  reason = "superseded by a fresher plan",
): DomainEvent {
  return {
    type: "PlanSuperseded",
    schemaVersion: 1,
    payload: {
      epochId,
      scopeHash,
      priorPlanId,
      trailerId,
      supersededPackageIds,
      reason,
      occurredAt,
    },
  };
}

function delivered(packageId: string, hubId: string): DomainEvent {
  return {
    type: "PackageDelivered",
    schemaVersion: 1,
    payload: {
      packageId,
      hubId,
      deliveredAt: "2026-06-24T12:34:00.000Z",
      onTime: true,
      occurredAt: "2026-06-24T12:34:00.000Z",
    },
  };
}

function foldHub(events: OccurredEvent[]): HubInventoryState {
  return events.reduce(hubInventoryReducer, emptyHubInventoryState);
}

describe("hubInventoryReducer — PlanSuperseded delete-then-apply (FLOW-04 / D-21-1)", () => {
  it("wipes the prior plan's supersededPackageIds from staged, leaving non-superseded packages", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "unload"), at(0)), // staged
      evt(scanned("P2", "MEM", "unload"), at(1_000)), // staged
      evt(scanned("P3", "MEM", "unload"), at(2_000)), // staged
      evt(superseded("T1", ["P1", "P2"], at(3_000)), at(3_000)),
    ]);
    const mem = state.hubs.get("MEM");
    // P1, P2 wiped (they were in the superseded prior-plan scope); P3 untouched.
    expect(mem?.staged).toEqual(["P3"]);
    expect(mem?.inbound).toEqual([]);
    expect(mem?.outbound).toEqual([]);
  });

  it("wipes holistic scope across hubs — items present in the OLD plan are not stranded", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "unload"), at(0)),
      evt(scanned("P2", "DFW", "unload"), at(1_000)),
      // The prior plan's holistic scope spans both hubs; both must be wiped.
      evt(superseded("T1", ["P1", "P2"], at(2_000)), at(2_000)),
    ]);
    expect(state.hubs.get("MEM")?.staged).toEqual([]);
    expect(state.hubs.get("DFW")?.staged).toEqual([]);
  });

  it("regression: the unload-scan staging path still works after an unrelated PlanSuperseded", () => {
    const state = foldHub([
      evt(scanned("P1", "MEM", "unload"), at(0)), // staged
      evt(superseded("T9", ["P1"], at(1_000)), at(1_000)), // wipes P1
      evt(scanned("P4", "MEM", "unload"), at(2_000)), // NEW non-plan staging still lands
    ]);
    const mem = state.hubs.get("MEM");
    expect(mem?.staged).toEqual(["P4"]);
  });

  it("no double-count: a package in inbound is not also in staged after supersession naming it", () => {
    const state = foldHub([
      evt(arrived("P1", "MEM"), at(0)), // inbound
      evt(scanned("P2", "MEM", "unload"), at(1_000)), // staged
      evt(superseded("T1", ["P1", "P2"], at(2_000)), at(2_000)),
    ]);
    const mem = state.hubs.get("MEM");
    // Both named packages removed from wherever they sat — no lingering double-count.
    expect(mem?.inbound).toEqual([]);
    expect(mem?.staged).toEqual([]);
    const total =
      (mem?.inbound.length ?? 0) +
      (mem?.outbound.length ?? 0) +
      (mem?.staged.length ?? 0);
    expect(total).toBe(0);
  });

  it("PlanAccepted is a no-op: it carries no packageIds and stages nothing", () => {
    const before = foldHub([evt(scanned("P1", "MEM", "unload"), at(0))]);
    const after = foldHub([
      evt(scanned("P1", "MEM", "unload"), at(0)),
      evt(accepted("T1", at(1_000)), at(1_000)),
    ]);
    // staged is byte-identical before and after the PlanAccepted.
    expect(after.hubs.get("MEM")).toEqual(before.hubs.get("MEM"));
    expect(after.hubs.get("MEM")?.staged).toEqual(["P1"]);
  });

  it("is pure: re-applying the same PlanSuperseded yields deep-equal output", () => {
    const seed = foldHub([evt(scanned("P1", "MEM", "unload"), at(0))]);
    const e = evt(superseded("T1", ["P1"], at(1_000)), at(1_000));
    expect(hubInventoryReducer(seed, e)).toEqual(hubInventoryReducer(seed, e));
  });
});

describe("hubInventoryReducer — PackageDelivered purge (OUT-04 / D-22-1)", () => {
  it("purges the delivered package from hub inventory (placement removed)", () => {
    const state = foldHub([
      evt(arrived("P1", "MEM"), at(0)), // inbound at MEM
      evt(delivered("P1", "MEM"), at(1_000)),
    ]);
    // The placement index no longer references P1, and MEM holds no buckets for it.
    expect(state.placement.has("P1")).toBe(false);
    const mem = state.hubs.get("MEM");
    expect(mem?.inbound).toEqual([]);
    expect(mem?.outbound).toEqual([]);
    expect(mem?.staged).toEqual([]);
  });

  it("is a no-op when the package is absent (idempotent — never throws, D-22-1)", () => {
    const before = foldHub([evt(arrived("P1", "MEM"), at(0))]);
    // Delivering an UNKNOWN packageId must not throw and must leave state intact.
    const after = hubInventoryReducer(
      before,
      evt(delivered("GHOST-99", "MEM"), at(1_000)),
    );
    expect(after.placement.has("P1")).toBe(true);
    expect(after.hubs.get("MEM")?.inbound).toEqual(["P1"]);
  });

  it("re-applying the same PackageDelivered is idempotent (crash-safe replay)", () => {
    const seed = foldHub([evt(arrived("P1", "MEM"), at(0))]);
    const e = evt(delivered("P1", "MEM"), at(1_000));
    const once = hubInventoryReducer(seed, e);
    const twice = hubInventoryReducer(once, e);
    expect(twice).toEqual(once);
    expect(twice.placement.has("P1")).toBe(false);
  });
});
