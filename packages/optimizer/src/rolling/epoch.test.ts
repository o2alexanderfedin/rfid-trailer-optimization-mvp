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
});
