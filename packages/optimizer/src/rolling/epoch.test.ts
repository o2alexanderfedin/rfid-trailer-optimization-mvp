import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";

import { DEFAULT_OBJECTIVE_WEIGHTS } from "../objective/weights.js";
import { detectAffectedScope } from "./scope.js";
import { scopeHash } from "./freeze-idempotency.js";
import { runEpoch } from "./epoch.js";
import type { Epoch, EpochInput, TwinSnapshot } from "./types.js";

/**
 * OPT-04/05/06 — `runEpoch` is the PURE rolling-epoch core: data in, data out,
 * NO IO, NO clock, NO RNG. It composes the Wave-2 algorithms over the twin and
 * returns the `PlanGenerated`/`PlanAccepted` payloads + per-trailer
 * recommendations.
 *
 * THE KEYSTONE: two `runEpoch` calls with identical `(epoch, input, weights)`
 * return a DEEP-EQUAL result (incl. `scopeHash`) — the anti-P7 idempotency proof.
 */

function departed(trailerId: string, fromHubId: string, toHubId: string): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId: `${trailerId}-trip`, packageIds: [] },
  };
}

function snapshot(): TwinSnapshot {
  return {
    hubs: ["H1", "H2", "H3"],
    routes: [
      { routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin: 30, capacity: 20 },
      { routeId: "R2", fromHubId: "H2", toHubId: "H3", travelMin: 40, capacity: 20 },
    ],
    trailers: [
      {
        trailerId: "T1",
        currentHubId: "H1",
        // Departs well after the freeze window ⇒ optimizable.
        departureMin: 300,
        capacity: 20,
        route: [
          { hubId: "H2", stopIndex: 0 },
          { hubId: "H3", stopIndex: 1 },
        ],
        blocks: [
          { blockId: "B1", nextUnloadHubId: "H2", volume: 6 },
          { blockId: "B2", nextUnloadHubId: "H3", volume: 8 },
        ],
      },
    ],
  };
}

const EPOCH: Epoch = { epochId: "e1", nowMin: 100, freezeWindowMin: 15 };

function input(): EpochInput {
  return { events: [departed("T1", "H1", "H2")], twinSnapshot: snapshot() };
}

describe("runEpoch (OPT-04/05/06 pure rolling core)", () => {
  it("KEYSTONE: identical (epoch,input,weights) ⇒ byte-identical EpochResult", () => {
    const a = runEpoch(EPOCH, input(), DEFAULT_OBJECTIVE_WEIGHTS);
    const b = runEpoch(EPOCH, input(), DEFAULT_OBJECTIVE_WEIGHTS);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("reports the scopeHash of the affected scope (idempotency key)", () => {
    const result = runEpoch(EPOCH, input(), DEFAULT_OBJECTIVE_WEIGHTS);
    const scope = detectAffectedScope(input().events, EPOCH);
    expect(result.scopeHash).toBe(scopeHash(scope, snapshot()));
    expect(result.epochId).toBe(EPOCH.epochId);
  });

  it("produces a PlanGenerated payload for the candidate, gated feasibility SEPARATE from cost (anti-P2)", () => {
    const result = runEpoch(EPOCH, input(), DEFAULT_OBJECTIVE_WEIGHTS);
    expect(result.generated).not.toBeNull();
    expect(result.generated!.epochId).toBe(EPOCH.epochId);
    expect(result.generated!.scopeHash).toBe(result.scopeHash);
    expect(typeof result.generated!.feasible).toBe("boolean");
    expect(typeof result.generated!.objectiveCost).toBe("number");
    // occurredAt is supplied (from the epoch clock), never Date.now-derived.
    expect(result.generated!.occurredAt.length).toBeGreaterThan(0);
  });

  it("on a feasible improving candidate, emits exactly ONE PlanAccepted matching the generated plan", () => {
    const result = runEpoch(EPOCH, input(), DEFAULT_OBJECTIVE_WEIGHTS);
    if (result.accepted !== null) {
      expect(result.accepted.planId).toBe(result.generated!.planId);
      expect(result.accepted.scopeHash).toBe(result.scopeHash);
      expect(result.accepted.trailerId).toBe(result.generated!.trailerId);
    }
    // Feasible candidate ⇒ accepted (the demo accepts the first feasible plan).
    expect(result.generated!.feasible).toBe(true);
    expect(result.accepted).not.toBeNull();
  });

  it("surfaces a per-trailer recommendation with an objective breakdown (explainability)", () => {
    const result = runEpoch(EPOCH, input(), DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = result.recommendations.find((r) => r.trailerId === "T1");
    expect(rec).toBeDefined();
    expect(rec!.breakdown.total).toBeCloseTo(rec!.objectiveCost);
    expect(rec!.frozen).toBe(false);
  });

  it("FREEZE (OPT-06): a trailer departing within the freeze window is left untouched (frozen, no plan change)", () => {
    const snap = snapshot();
    // Freeze the trailer: depart within [now, now+freeze] = [100,115].
    (snap.trailers[0] as { departureMin: number }).departureMin = 108;
    const frozenInput: EpochInput = { events: [departed("T1", "H1", "H2")], twinSnapshot: snap };

    const result = runEpoch(EPOCH, frozenInput, DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = result.recommendations.find((r) => r.trailerId === "T1");
    expect(rec!.frozen).toBe(true);
    // A frozen trailer yields no accepted plan change.
    expect(result.accepted).toBeNull();
  });

  it("EMPTY scope ⇒ no plan generated/accepted (nothing affected)", () => {
    const empty: EpochInput = { events: [], twinSnapshot: snapshot() };
    const result = runEpoch(EPOCH, empty, DEFAULT_OBJECTIVE_WEIGHTS);
    expect(result.generated).toBeNull();
    expect(result.accepted).toBeNull();
    expect(result.recommendations).toEqual([]);
  });

  it("does NOT mutate the input snapshot (twin sandbox; OPT-04 zero side effects)", () => {
    const inp = input();
    const before = JSON.stringify(inp.twinSnapshot);
    runEpoch(EPOCH, inp, DEFAULT_OBJECTIVE_WEIGHTS);
    expect(JSON.stringify(inp.twinSnapshot)).toBe(before);
  });

  it("CAPACITY (FIX 1): an off-route block's volume still counts toward demand (gate not bypassable)", () => {
    // The trailer's route is H2,H3 (capacity 20). Its blocks fit those stops with
    // volume 6+8=14 ≤ 20. But it ALSO carries an extra block destined for H9 — a
    // hub NOT on its route. Previously that off-route volume was silently dropped
    // from the capacity demand, so a trailer could be loaded beyond capacity yet
    // still pass the gate. With the fix, EVERY assigned block contributes its
    // volume, so 6+8+10 = 24 > 20 ⇒ the candidate is flagged INFEASIBLE.
    const snap = snapshot();
    (snap.trailers[0] as { blocks: { blockId: string; nextUnloadHubId: string; volume: number }[] }).blocks = [
      { blockId: "B1", nextUnloadHubId: "H2", volume: 6 },
      { blockId: "B2", nextUnloadHubId: "H3", volume: 8 },
      // Off-route block: H9 is not in the trailer's route — its volume must NOT vanish.
      { blockId: "B3", nextUnloadHubId: "H9", volume: 10 },
    ];
    const overInput: EpochInput = { events: [departed("T1", "H1", "H2")], twinSnapshot: snap };

    const result = runEpoch(EPOCH, overInput, DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = result.recommendations.find((r) => r.trailerId === "T1");
    expect(rec).toBeDefined();
    // Total assigned volume (24) exceeds capacity (20) ⇒ infeasible, not accepted.
    expect(rec!.feasible).toBe(false);
    expect(result.accepted).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — localRepair wired into live epoch for infeasible trailers (OPT-07)
// FIX 2 — real rehandleScore (not hardcoded 0) for live epoch (OPT-05)
// ---------------------------------------------------------------------------

/**
 * Build a snapshot where T1's blocks are in LIFO-WRONG order (a later-unload
 * block sits at depth 0/rear, blocking an earlier-unload block). The route is
 * H2 (stop 0) then H3 (stop 1). B2 should unload last (H3=stop 1) but is
 * at depth 0 (rear); B1 unloads first (H2=stop 0) but is behind B2.
 * This is a LIFO violation that scorePlan should score as non-zero rehandle.
 *
 * NOTE: routeTrailers in the epoch uses block volumes vs trailer capacity for
 * feasibility; the VRPTW capacity gate (total demand > capacity) drives route
 * infeasibility. For a trailer with total demand=14 ≤ capacity=20 the route
 * is FEASIBLE but the LIFO order still incurs a non-zero rehandleScore when
 * scored with scorePlan (the soft scorer).
 *
 * For FIX 1 (repair wiring), we need an INFEASIBLE route, which means we
 * need total demand > capacity so routeTrailers returns feasible=false.
 */
function infeasibleSnapshot(): TwinSnapshot {
  // Capacity = 10, total block volume = 6+8 = 14 > 10 ⇒ route infeasible.
  return {
    hubs: ["H1", "H2", "H3"],
    routes: [
      { routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin: 30, capacity: 10 },
      { routeId: "R2", fromHubId: "H2", toHubId: "H3", travelMin: 40, capacity: 10 },
    ],
    trailers: [
      {
        trailerId: "T1",
        currentHubId: "H1",
        departureMin: 300, // not frozen
        capacity: 10, // total volume 6+8=14 > 10 ⇒ infeasible
        route: [
          { hubId: "H2", stopIndex: 0 },
          { hubId: "H3", stopIndex: 1 },
        ],
        blocks: [
          { blockId: "B1", nextUnloadHubId: "H2", volume: 6 },
          { blockId: "B2", nextUnloadHubId: "H3", volume: 8 },
        ],
      },
    ],
  };
}

/**
 * Build a snapshot where T1 has blocks in LIFO-WRONG order (B2 destined for
 * H3/stop-1 but volume is smaller, B1 for H2/stop-0). Total volume fits in
 * capacity=20 so the route is FEASIBLE. The rehandle scorer penalises the
 * load arrangement when we synthesise the LoadPlan in FIFO (wrong) order.
 *
 * The test verifies rehandleScore > 0 only when the blocks are in wrong order
 * relative to the route. This is the FIX 2 test.
 */
function rehandleSnapshot(): TwinSnapshot {
  return {
    hubs: ["H1", "H2", "H3"],
    routes: [
      { routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin: 30, capacity: 50 },
      { routeId: "R2", fromHubId: "H2", toHubId: "H3", travelMin: 40, capacity: 50 },
    ],
    trailers: [
      {
        trailerId: "T1",
        currentHubId: "H1",
        departureMin: 300,
        capacity: 50,
        route: [
          { hubId: "H2", stopIndex: 0 }, // H2 unloads FIRST — must be at rear (low depth)
          { hubId: "H3", stopIndex: 1 }, // H3 unloads SECOND — must be deeper (high depth)
        ],
        // B2 goes to H3 (stop 1, deeper/nose), B1 goes to H2 (stop 0, rear).
        // In the twin's block list order they come as B1(H2) first then B2(H3).
        // The epoch must detect that any block destined for a later stop placed
        // in front of an earlier-stop block incurs rehandle cost.
        blocks: [
          { blockId: "B1", nextUnloadHubId: "H2", volume: 5 }, // unloads first → should be at depth 0 (rear)
          { blockId: "B2", nextUnloadHubId: "H3", volume: 5 }, // unloads second → should be at depth 1 (nose)
        ],
      },
    ],
  };
}

describe("runEpoch FIX 1 — localRepair wired for infeasible trailers (OPT-07)", () => {
  const EPOCH_FIX: Epoch = { epochId: "e-fix1", nowMin: 100, freezeWindowMin: 15 };

  it("RED: infeasible trailer's recommendation carries repairRecommendations (not undefined)", () => {
    const snap = infeasibleSnapshot();
    const inp: EpochInput = {
      events: [departed("T1", "H1", "H2")],
      twinSnapshot: snap,
    };
    const result = runEpoch(EPOCH_FIX, inp, DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = result.recommendations.find((r) => r.trailerId === "T1");
    expect(rec).toBeDefined();
    expect(rec!.feasible).toBe(false);
    // FIX 1: repairRecommendations must be present (not undefined) and non-empty
    // for an infeasible trailer. Before the fix this field is always absent.
    expect(rec!.repairRecommendations).toBeDefined();
    expect((rec!.repairRecommendations ?? []).length).toBeGreaterThan(0);
  });

  it("RED: each repair recommendation has a valid kind and non-empty rationale", () => {
    const snap = infeasibleSnapshot();
    const inp: EpochInput = {
      events: [departed("T1", "H1", "H2")],
      twinSnapshot: snap,
    };
    const result = runEpoch(EPOCH_FIX, inp, DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = result.recommendations.find((r) => r.trailerId === "T1");
    expect(rec).toBeDefined();
    const recs = rec!.repairRecommendations ?? [];
    for (const r of recs) {
      expect(["split", "reassign", "hold", "overCarry"]).toContain(r.kind);
      expect(typeof r.rationale).toBe("string");
      expect(r.rationale.length).toBeGreaterThan(0);
    }
  });

  it("RED: feasible trailers do NOT carry repairRecommendations (only on infeasible)", () => {
    const snap = snapshot(); // feasible trailer (T1 with capacity=20, volume=14)
    const inp: EpochInput = {
      events: [departed("T1", "H1", "H2")],
      twinSnapshot: snap,
    };
    const result = runEpoch(EPOCH_FIX, inp, DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = result.recommendations.find((r) => r.trailerId === "T1");
    expect(rec).toBeDefined();
    expect(rec!.feasible).toBe(true);
    // Feasible trailer should NOT have repairRecommendations
    expect(rec!.repairRecommendations).toBeUndefined();
  });

  it("RED: idempotency preserved — two runs with infeasible trailer return deep-equal result", () => {
    const inp: EpochInput = {
      events: [departed("T1", "H1", "H2")],
      twinSnapshot: infeasibleSnapshot(),
    };
    const a = runEpoch(EPOCH_FIX, inp, DEFAULT_OBJECTIVE_WEIGHTS);
    const b = runEpoch(EPOCH_FIX, inp, DEFAULT_OBJECTIVE_WEIGHTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/**
 * Build a snapshot where T1's blocks are in LIFO-WRONG order:
 * B_NOSE (H3/stop-1, should be at depth 1/nose) is listed FIRST in the blocks
 * array, B_REAR (H2/stop-0, should be at depth 0/rear) is listed SECOND.
 *
 * After FIX 2, the epoch synthesises a LoadPlan by placing blocks in the order
 * they appear in the twin (array order maps to depth 0, 1, …). So B_NOSE ends
 * up at depth 0 (rear) and B_REAR ends up at depth 1 (nose) — a LIFO violation.
 * scorePlan will score this as rehandleScore > 0.
 *
 * Route: H2=stop 0 (first to unload, should be at depth 0/rear)
 *        H3=stop 1 (second to unload, should be at depth 1/nose)
 * Wrong arrangement: B_H3_NOSE at depth 0, B_H2_REAR at depth 1 → B_H2_REAR
 * is blocked by B_H3_NOSE (B_H3_NOSE must be moved to reach B_H2_REAR at stop 0).
 */
function lifoWrongSnapshot(): TwinSnapshot {
  return {
    hubs: ["H1", "H2", "H3"],
    routes: [
      { routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin: 30, capacity: 50 },
      { routeId: "R2", fromHubId: "H2", toHubId: "H3", travelMin: 40, capacity: 50 },
    ],
    trailers: [
      {
        trailerId: "T1",
        currentHubId: "H1",
        departureMin: 300,
        capacity: 50,
        route: [
          { hubId: "H2", stopIndex: 0 }, // H2 is stop 0 — first to unload
          { hubId: "H3", stopIndex: 1 }, // H3 is stop 1 — second to unload
        ],
        // WRONG ORDER: H3-block is first (depth 0/rear), H2-block is second (depth 1/nose).
        // H2 (stop 0) should be at depth 0 (rear). H3 (stop 1) should be at depth 1 (nose).
        // With this arrangement H3-block blocks H2-block → rehandleScore > 0 after FIX 2.
        blocks: [
          { blockId: "B_H3", nextUnloadHubId: "H3", volume: 5 }, // stop 1 — SHOULD be deeper but at depth 0 (wrong)
          { blockId: "B_H2", nextUnloadHubId: "H2", volume: 5 }, // stop 0 — SHOULD be at rear but at depth 1 (wrong)
        ],
      },
    ],
  };
}

describe("runEpoch FIX 2 — real rehandleScore (not hardcoded 0) in epoch metrics", () => {
  const EPOCH_FIX2: Epoch = { epochId: "e-fix2", nowMin: 100, freezeWindowMin: 15 };

  it("RED: a LIFO-WRONG load arrangement yields non-zero rehandle in the epoch breakdown", () => {
    // B_H3 at depth 0 (rear), B_H2 at depth 1 (nose). H2 is stop 0 (unloads
    // first) but is behind H3 (stop 1, unloads second) → B_H3 blocks B_H2.
    // After FIX 2: scorePlan detects the LIFO violation → rehandleScore > 0
    // → breakdown.rehandle > 0.
    // Before FIX 2: metricsFor always returns rehandleScore: 0 → breakdown.rehandle === 0.
    const snap = lifoWrongSnapshot();
    const inp: EpochInput = {
      events: [departed("T1", "H1", "H2")],
      twinSnapshot: snap,
    };
    const result = runEpoch(EPOCH_FIX2, inp, DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = result.recommendations.find((r) => r.trailerId === "T1");
    expect(rec).toBeDefined();
    expect(rec!.feasible).toBe(true); // route is feasible (volume fits capacity)
    // FIX 2: LIFO-wrong arrangement → rehandle cost > 0
    expect(rec!.breakdown.rehandle).toBeGreaterThan(0);
  });

  it("RED: a LIFO-CORRECT load arrangement yields rehandle=0 in the epoch breakdown", () => {
    // B1→H2 (stop 0, at depth 0=rear), B2→H3 (stop 1, at depth 1=nose): correct.
    // scorePlan should return rehandleScore=0.
    const snap = snapshot(); // correct LIFO order: B1@depth0, B2@depth1
    const inp: EpochInput = {
      events: [departed("T1", "H1", "H2")],
      twinSnapshot: snap,
    };
    const result = runEpoch(EPOCH_FIX2, inp, DEFAULT_OBJECTIVE_WEIGHTS);
    const rec = result.recommendations.find((r) => r.trailerId === "T1");
    expect(rec).toBeDefined();
    expect(rec!.feasible).toBe(true);
    expect(rec!.breakdown.rehandle).toBe(0);
  });
});
