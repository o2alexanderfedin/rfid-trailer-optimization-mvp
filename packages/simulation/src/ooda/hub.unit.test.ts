import { describe, expect, it } from "vitest";
import { deriveAgentRng } from "./rng.js";
import { decideHub } from "./hub.js";
import type { HubObservation } from "./hub.js";

/**
 * Phase-24 OODA-02 — the pure hub Observe→Decide→Act function (RED first).
 *
 * `decideHub(obs, rng)` is PURE + DETERMINISTIC: identical (frozen obs, rng-state)
 * ⇒ identical `HubDecision`. It mirrors the truck Decide's structure (a priority
 * ladder over a FROZEN, integer/string-only observation; any tie-break draws ONLY
 * from the passed per-agent substream). The default branch returns a no-op
 * `{ kind: "hold" }` so every hub always has a feasible action and a tick always
 * closes (the P25 no-livelock foundation). Pure leaf — no engine import, no
 * wall-clock, no `Math.random`.
 */

/** A quiet hub: empty queues, dock free, nothing staged ⇒ the no-op hold default. */
const idleObs: HubObservation = {
  kind: "hub",
  stableId: "MEM",
  tick: 1000,
  assignedCenterId: "MEM",
  inboundQueueDepth: 0,
  outboundQueueDepth: 0,
  dockDoorsAvailable: 2,
  trailerFillCount: 0,
  pendingConsolidationCount: 0,
};

const rng = () => deriveAgentRng(42, "MEM");

describe("decideHub — determinism + purity (OODA-02 / DET-03)", () => {
  it("identical (obs, rng-state) ⇒ identical decision", () => {
    expect(decideHub(idleObs, rng())).toEqual(decideHub(idleObs, rng()));
  });

  it("never mutates the observation", () => {
    const snapshot: HubObservation = structuredClone(idleObs);
    decideHub(idleObs, rng());
    expect(idleObs).toEqual(snapshot);
  });

  it("an idle hub holds (the no-op default — a tick always closes)", () => {
    const d = decideHub(idleObs, rng());
    expect(d.kind).toBe("hold");
  });
});

describe("decideHub — closed-union priority ladder (OODA-02)", () => {
  it("outbound freight + a free dock + a filled trailer ⇒ dispatch", () => {
    const obs: HubObservation = {
      ...idleObs,
      outboundQueueDepth: 12,
      dockDoorsAvailable: 1,
      trailerFillCount: 8,
    };
    const d = decideHub(obs, rng());
    expect(d.kind).toBe("dispatch");
    if (d.kind === "dispatch") expect(d.trailerId.length).toBeGreaterThan(0);
  });

  it("pending consolidation freight ⇒ consolidate (when not dispatching)", () => {
    const obs: HubObservation = {
      ...idleObs,
      // No outbound dispatch trigger (no free trailer fill), but freight is staged
      // for a spoke→center consolidation.
      outboundQueueDepth: 0,
      trailerFillCount: 0,
      pendingConsolidationCount: 5,
    };
    const d = decideHub(obs, rng());
    expect(d.kind).toBe("consolidate");
    if (d.kind === "consolidate") {
      expect(d.spokeHubId.length).toBeGreaterThan(0);
      expect(Array.isArray(d.packageIds)).toBe(true);
    }
  });

  it("outbound freight but NO free dock ⇒ hold (dock-busy), not dispatch", () => {
    const obs: HubObservation = {
      ...idleObs,
      outboundQueueDepth: 20,
      trailerFillCount: 8,
      dockDoorsAvailable: 0, // every door busy
    };
    const d = decideHub(obs, rng());
    expect(d.kind).toBe("hold");
  });

  it("dispatch beats consolidate beats hold (priority order)", () => {
    // An observation that satisfies EVERY trigger; dispatch must win.
    const allTriggers: HubObservation = {
      ...idleObs,
      outboundQueueDepth: 30,
      dockDoorsAvailable: 2,
      trailerFillCount: 10,
      pendingConsolidationCount: 9,
    };
    expect(decideHub(allTriggers, rng()).kind).toBe("dispatch");
  });

  it("the decision is a value of the closed union (kind is one of the 3 variants)", () => {
    for (const obs of [
      idleObs,
      { ...idleObs, outboundQueueDepth: 12, trailerFillCount: 8, dockDoorsAvailable: 1 },
      { ...idleObs, pendingConsolidationCount: 4 },
    ]) {
      const d = decideHub(obs, rng());
      expect(["dispatch", "hold", "consolidate"]).toContain(d.kind);
    }
  });
});
