import { describe, expect, it } from "vitest";

import type {
  HubDockFeasibility,
  TruckLegFeasibility,
} from "../ooda/feasibility.js";
import type { CoordinatorSuggestion } from "./coordinator.js";
import { arbitrateSuggestion } from "./handshake.js";

/**
 * Phase-25 COORD-02 (consume half) — `arbitrateSuggestion` PURE arbitration tests.
 *
 * The handshake's un-overridable contract (24-03): a coordinator advises, but the
 * agent's OWN binding local feasibility verdict decides. `arbitrateSuggestion`
 * READS the verdict (it never recomputes feasibility) and maps a (suggestion,
 * verdict) pair to either accept(+bindingKind) or reject(+reasonCode on the closed
 * Plan-01 enum). The HOS > fuel > dock priority mirrors the 24-03 feasibility gate
 * ladder; a hold is the always-feasible no-op (the COORD-05 substrate).
 */

// A feasible truck verdict: may drive, no rest/refuel due.
const FEASIBLE_TRUCK: TruckLegFeasibility = {
  canDrive: true,
  mustRest: false,
  mustRefuel: false,
  remainingDriveMinutes: 240,
  restReason: null,
};

// HOS-out: the truck may NOT drive (a 10h reset is due).
const HOS_OUT_TRUCK: TruckLegFeasibility = {
  canDrive: false,
  mustRest: true,
  mustRefuel: false,
  remainingDriveMinutes: 0,
  restReason: "rest-10h",
};

// Fuel-out but legally able to drive: the binding reason is fuel.
const FUEL_OUT_TRUCK: TruckLegFeasibility = {
  canDrive: true,
  mustRest: false,
  mustRefuel: true,
  remainingDriveMinutes: 180,
  restReason: null,
};

const DOCK_FREE: HubDockFeasibility = { canDispatch: true, canConsolidate: true };
const DOCK_FULL: HubDockFeasibility = { canDispatch: false, canConsolidate: false };

const reroute: CoordinatorSuggestion = {
  kind: "reroute",
  targetAgentId: "T0001",
  toHubId: "HUB-CTR",
};
const hold: CoordinatorSuggestion = { kind: "hold", targetAgentId: "HUB-A" };
const consolidate: CoordinatorSuggestion = {
  kind: "consolidate",
  targetAgentId: "HUB-A",
};
const dispatch: CoordinatorSuggestion = {
  kind: "dispatch",
  targetAgentId: "HUB-A",
  toHubId: "HUB-CTR",
};

describe("arbitrateSuggestion — the un-overridable feasibility contract (COORD-02)", () => {
  it("rejects a reroute with 'hos' when the truck may not legally drive", () => {
    const result = arbitrateSuggestion(reroute, HOS_OUT_TRUCK);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reasonCode).toBe("hos");
  });

  it("rejects a reroute with 'fuel' when the truck must refuel (HOS clear)", () => {
    const result = arbitrateSuggestion(reroute, FUEL_OUT_TRUCK);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reasonCode).toBe("fuel");
  });

  it("rejects a dispatch with 'dock' when no dock door is free", () => {
    const result = arbitrateSuggestion(dispatch, DOCK_FULL);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reasonCode).toBe("dock");
  });

  it("rejects a consolidate with 'dock' when no dock door is free", () => {
    const result = arbitrateSuggestion(consolidate, DOCK_FULL);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reasonCode).toBe("dock");
  });

  it("accepts a reroute with bindingKind 'divert' when the truck is feasible", () => {
    const result = arbitrateSuggestion(reroute, FEASIBLE_TRUCK);
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.bindingKind).toBe("divert");
  });

  it("accepts a dispatch with bindingKind 'dispatch' when a dock is free", () => {
    const result = arbitrateSuggestion(dispatch, DOCK_FREE);
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.bindingKind).toBe("dispatch");
  });

  it("accepts a consolidate with bindingKind 'consolidate' when a dock is free", () => {
    const result = arbitrateSuggestion(consolidate, DOCK_FREE);
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.bindingKind).toBe("consolidate");
  });

  it("ALWAYS accepts a hold with bindingKind 'none' (the feasible no-op default)", () => {
    // A hold never rejects regardless of the verdict — the COORD-05 substrate.
    for (const verdict of [FEASIBLE_TRUCK, HOS_OUT_TRUCK, FUEL_OUT_TRUCK]) {
      const result = arbitrateSuggestion(hold, verdict);
      expect(result.accepted).toBe(true);
      if (result.accepted) expect(result.bindingKind).toBe("none");
    }
  });

  it("preserves HOS > fuel priority: an HOS-out AND fuel-out truck rejects with 'hos'", () => {
    const both: TruckLegFeasibility = {
      canDrive: false,
      mustRest: true,
      mustRefuel: true,
      remainingDriveMinutes: 0,
      restReason: "rest-10h",
    };
    const result = arbitrateSuggestion(reroute, both);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reasonCode).toBe("hos");
  });

  it("is PURE + deterministic: identical inputs ⇒ identical output", () => {
    const a = arbitrateSuggestion(reroute, FEASIBLE_TRUCK);
    const b = arbitrateSuggestion(reroute, FEASIBLE_TRUCK);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("the reject reasonCode is exactly the closed Plan-01 enum (hos|fuel|dock|infeasible)", () => {
    const closed = new Set(["hos", "fuel", "dock", "infeasible"]);
    const rejects = [
      arbitrateSuggestion(reroute, HOS_OUT_TRUCK),
      arbitrateSuggestion(reroute, FUEL_OUT_TRUCK),
      arbitrateSuggestion(dispatch, DOCK_FULL),
    ];
    for (const r of rejects) {
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(closed.has(r.reasonCode)).toBe(true);
    }
  });
});
