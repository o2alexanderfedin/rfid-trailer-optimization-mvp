import { describe, expect, it } from "vitest";
import { deriveAgentRng } from "./rng.js";
import type { AgentObservation } from "./observe.js";
import { decideTruck } from "./truck.js";

/**
 * Phase-24 OODA-01 — the pure truck Observe→Orient→Decide function (RED first).
 *
 * `decideTruck(obs, rng)` is PURE + DETERMINISTIC: identical (frozen obs,
 * rng-state) ⇒ identical decision. It applies a documented priority ladder over
 * the FROZEN observation — binding feasibility first (out of legal hours ⇒ rest;
 * odometer over threshold ⇒ refuel), then divert/hold/proceed. Any stochastic
 * tie-break draws ONLY from the passed substream `rng` — never `Math.random`,
 * never `Date.now()`.
 */

const HOS_FULL = {
  driveTodayMin: 0,
  dutyWindowStartAt: "2024-01-01T00:00:00.000Z",
  sinceLastBreakMin: 0,
  weeklyOnDutyMin: 0,
  comeOnDutyAt: "2024-01-01T00:00:00.000Z",
  sleeperBerthLongMin: 0,
  sleeperBerthShortMin: 0,
} as const;

/** A healthy mid-trip truck with plenty of legal drive time and fuel headroom. */
const baseObs: AgentObservation = {
  kind: "truck",
  stableId: "T0001",
  tick: 1000,
  tripId: "TRIP-1",
  assignedCenterId: "MEM",
  currentLegKey: "MEM->ORD",
  odometerMiles: 100,
  remainingLegalDriveMinutes: 240,
  minutesSinceLastBreak: 60,
  hosClock: HOS_FULL,
  nextHubId: "ORD",
  nextHubQueueDepth: 2,
  nextHubDockAvailable: true,
};

const rng = () => deriveAgentRng(42, "T0001");

describe("decideTruck — determinism + purity (OODA-01 / DET-03)", () => {
  it("identical (obs, rng-state) ⇒ identical decision", () => {
    expect(decideTruck(baseObs, rng())).toEqual(decideTruck(baseObs, rng()));
  });

  it("never mutates the observation", () => {
    const snapshot: AgentObservation = structuredClone(baseObs);
    decideTruck(baseObs, rng());
    expect(baseObs).toEqual(snapshot);
  });

  it("a healthy mid-trip truck proceeds", () => {
    expect(decideTruck(baseObs, rng())).toEqual({ kind: "proceed" });
  });
});

describe("decideTruck — binding-feasibility priority ladder (OODA-01 / OODA-03)", () => {
  it("out of legal driving hours ⇒ rest (HIGHEST priority, beats refuel)", () => {
    const obs: AgentObservation = {
      ...baseObs,
      remainingLegalDriveMinutes: 0,
      odometerMiles: 100_000, // also over any refuel threshold — rest must still win
    };
    const d = decideTruck(obs, rng());
    expect(d.kind).toBe("rest");
    if (d.kind === "rest") {
      expect(d.durationMin).toBeGreaterThan(0);
      expect(["rest-10h", "break-30min"]).toContain(d.reason);
    }
  });

  it("needs a 30-min break (long since last break) ⇒ rest break-30min", () => {
    const obs: AgentObservation = {
      ...baseObs,
      remainingLegalDriveMinutes: 120,
      minutesSinceLastBreak: 8 * 60, // past the 8h break boundary
    };
    const d = decideTruck(obs, rng());
    expect(d.kind).toBe("rest");
    if (d.kind === "rest") expect(d.reason).toBe("break-30min");
  });

  it("odometer over the refuel threshold (and HOS ok) ⇒ refuel", () => {
    const obs: AgentObservation = { ...baseObs, odometerMiles: 2_000 };
    const d = decideTruck(obs, rng());
    expect(d.kind).toBe("refuel");
    if (d.kind === "refuel") {
      expect(d.gallons).toBeGreaterThan(0);
      expect(d.odometerMiles).toBe(2_000);
      expect(d.durationMin).toBeGreaterThan(0);
    }
  });

  it("next-hub congested (and feasible) ⇒ divert to an alternate hub", () => {
    const obs: AgentObservation = {
      ...baseObs,
      nextHubQueueDepth: 999, // heavily congested
      nextHubDockAvailable: false,
      assignedCenterId: "MEM",
    };
    const d = decideTruck(obs, rng());
    expect(d.kind).toBe("divert");
    if (d.kind === "divert") {
      expect(d.toHubId.length).toBeGreaterThan(0);
      expect(d.toHubId).not.toBe(obs.nextHubId); // divert means a DIFFERENT hub
    }
  });

  it("no trip assigned ⇒ hold (no-trip)", () => {
    const obs: AgentObservation = {
      ...baseObs,
      tripId: null,
      currentLegKey: null,
      nextHubId: null,
    };
    const d = decideTruck(obs, rng());
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("no-trip");
  });

  it("dock unavailable but queue manageable ⇒ hold (dock-unavailable), not divert", () => {
    const obs: AgentObservation = {
      ...baseObs,
      nextHubQueueDepth: 3,
      nextHubDockAvailable: false,
    };
    const d = decideTruck(obs, rng());
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("dock-unavailable");
  });

  it("rest beats refuel beats divert beats hold beats proceed (priority order)", () => {
    // Construct an observation that satisfies EVERY trigger; rest must win.
    const allTriggers: AgentObservation = {
      ...baseObs,
      remainingLegalDriveMinutes: 0, // rest trigger
      odometerMiles: 9_999, // refuel trigger
      nextHubQueueDepth: 999, // divert trigger
      nextHubDockAvailable: false, // hold trigger
    };
    expect(decideTruck(allTriggers, rng()).kind).toBe("rest");
  });
});
