import {
  applyDrivingLeg,
  DEFAULT_FUEL_CONFIG,
  DEFAULT_HOS_CONFIG,
  type HosClock,
  isoToEpochMinutes,
  mayDriveNow,
} from "@mm/domain";
import { describe, expect, it } from "vitest";

import { deriveAgentRng } from "./rng.js";
import { decideHub, type HubObservation } from "./hub.js";
import type { AgentObservation } from "./observe.js";
import {
  hubDockFeasibility,
  truckLegFeasibility,
} from "./feasibility.js";
import { decideTruck } from "./truck.js";

/**
 * Phase-24 OODA-03 — BINDING LOCAL FEASIBILITY (RED first).
 *
 * The feasibility predicates are PURE adapters that DELEGATE to the shared engines
 * (REUSE, do NOT rebuild). Tasks:
 *  - Task 1: `truckLegFeasibility` / `hubDockFeasibility` verdicts + a REUSE-WITNESS
 *    boundary test proving the HOS verdict matches a direct `mayDriveNow` /
 *    `applyDrivingLeg` call on the same inputs.
 *  - Task 2: the Decide functions gate every outcome through the verdict so an
 *    infeasible outcome (drive-while-illegal / dispatch-without-dock) is UNREACHABLE
 *    across the observation space (the un-overridable OODA-03 contract).
 */

const WINDOW_START = "2024-01-01T00:00:00.000Z";
const NOW_MIN = isoToEpochMinutes("2024-01-01T05:00:00.000Z");

/** A fresh, fully-legal HOS clock (post-reset). */
const HOS_FULL: HosClock = {
  driveTodayMin: 0,
  dutyWindowStartAt: WINDOW_START,
  sinceLastBreakMin: 0,
  weeklyOnDutyMin: 0,
  comeOnDutyAt: WINDOW_START,
  sleeperBerthLongMin: 0,
  sleeperBerthShortMin: 0,
};

/** A clock at the 11h driving limit ⇒ a 10h reset is the binding rest. */
const HOS_OUT_OF_DRIVE: HosClock = {
  ...HOS_FULL,
  driveTodayMin: DEFAULT_HOS_CONFIG.maxDriveMin, // 660 — exactly at the 11h edge
};

/** A clock exactly at the 8h break boundary ⇒ a 30-min break is the binding rest. */
const HOS_AT_BREAK_EDGE: HosClock = {
  ...HOS_FULL,
  // Drive minutes well under the 11h cap, but 8h since the last break ⇒ break binds.
  driveTodayMin: 100,
  sinceLastBreakMin: DEFAULT_HOS_CONFIG.breakAfterDriveMin, // 480 — exactly at the 8h edge
};

function truckObs(over: Partial<AgentObservation> & { hosClock: HosClock }): AgentObservation {
  return {
    kind: "truck",
    stableId: "T0001",
    tick: 300,
    tripId: "TRIP-1",
    assignedCenterId: "MEM",
    currentLegKey: "MEM->ORD",
    odometerMiles: 100,
    remainingLegalDriveMinutes: 240,
    minutesSinceLastBreak: 60,
    nextHubId: "ORD",
    nextHubQueueDepth: 2,
    nextHubDockAvailable: true,
    ...over,
  };
}

const FUEL = DEFAULT_FUEL_CONFIG;

describe("truckLegFeasibility — HOS + fuel verdict (OODA-03 Task 1)", () => {
  it("a fully-legal clock with fuel headroom ⇒ all-clear (canDrive, no rest, no refuel)", () => {
    const v = truckLegFeasibility(truckObs({ hosClock: HOS_FULL }), DEFAULT_HOS_CONFIG, FUEL, NOW_MIN);
    expect(v.canDrive).toBe(true);
    expect(v.mustRest).toBe(false);
    expect(v.mustRefuel).toBe(false);
    expect(v.restReason).toBeNull();
    expect(v.remainingDriveMinutes).toBeGreaterThan(0);
  });

  it("out of legal driving hours (11h limit) ⇒ canDrive:false, mustRest:true (rest-10h)", () => {
    const v = truckLegFeasibility(
      truckObs({ hosClock: HOS_OUT_OF_DRIVE }),
      DEFAULT_HOS_CONFIG,
      FUEL,
      NOW_MIN,
    );
    expect(v.canDrive).toBe(false);
    expect(v.mustRest).toBe(true);
    expect(v.restReason).toBe("rest-10h");
  });

  it("at the 8h break boundary ⇒ canDrive:false, mustRest:true (break-30min)", () => {
    const v = truckLegFeasibility(
      truckObs({ hosClock: HOS_AT_BREAK_EDGE }),
      DEFAULT_HOS_CONFIG,
      FUEL,
      NOW_MIN,
    );
    expect(v.canDrive).toBe(false);
    expect(v.mustRest).toBe(true);
    expect(v.restReason).toBe("break-30min");
  });

  it("odometer over the SAME refuelThresholdMiles the engine uses ⇒ mustRefuel:true", () => {
    const over = truckObs({ hosClock: HOS_FULL, odometerMiles: FUEL.refuelThresholdMiles });
    expect(truckLegFeasibility(over, DEFAULT_HOS_CONFIG, FUEL, NOW_MIN).mustRefuel).toBe(true);
    const under = truckObs({ hosClock: HOS_FULL, odometerMiles: FUEL.refuelThresholdMiles - 1 });
    expect(truckLegFeasibility(under, DEFAULT_HOS_CONFIG, FUEL, NOW_MIN).mustRefuel).toBe(false);
  });

  it("is PURE — identical inputs ⇒ identical verdict, never mutates the observation", () => {
    const obs = truckObs({ hosClock: HOS_FULL });
    const snapshot = structuredClone(obs);
    const a = truckLegFeasibility(obs, DEFAULT_HOS_CONFIG, FUEL, NOW_MIN);
    const b = truckLegFeasibility(obs, DEFAULT_HOS_CONFIG, FUEL, NOW_MIN);
    expect(a).toEqual(b);
    expect(obs).toEqual(snapshot);
  });
});

describe("truckLegFeasibility — REUSE WITNESS (delegates, does not reimplement)", () => {
  // The strongest anti-drift test (T-24-09): feed BOUNDARY clocks (exactly at the
  // 11h / 8h edges) and assert the predicate's HOS verdict AGREES with a DIRECT
  // call to the domain engine on the same inputs. If the predicate reimplemented
  // the FMCSA math, the two could diverge at the edge — this proves delegation.
  const boundaryClocks: ReadonlyArray<readonly [string, HosClock]> = [
    ["fully-legal", HOS_FULL],
    ["at-11h-limit", HOS_OUT_OF_DRIVE],
    ["at-8h-break-edge", HOS_AT_BREAK_EDGE],
    ["one-under-11h", { ...HOS_FULL, driveTodayMin: DEFAULT_HOS_CONFIG.maxDriveMin - 1 }],
    ["one-over-8h-break", { ...HOS_FULL, sinceLastBreakMin: DEFAULT_HOS_CONFIG.breakAfterDriveMin + 1, driveTodayMin: 50 }],
  ];

  for (const [label, clock] of boundaryClocks) {
    it(`canDrive matches mayDriveNow directly (${label})`, () => {
      const v = truckLegFeasibility(truckObs({ hosClock: clock }), DEFAULT_HOS_CONFIG, FUEL, NOW_MIN);
      expect(v.canDrive).toBe(mayDriveNow(clock, DEFAULT_HOS_CONFIG, NOW_MIN));
    });

    it(`restReason matches the engine's applyDrivingLeg segment plan (${label})`, () => {
      const v = truckLegFeasibility(truckObs({ hosClock: clock }), DEFAULT_HOS_CONFIG, FUEL, NOW_MIN);
      if (v.canDrive) {
        expect(v.restReason).toBeNull();
        return;
      }
      // Reproduce the engine's own plan and read the first inserted rest off it —
      // the predicate must report the SAME binding rest the engine would insert.
      const plan = applyDrivingLeg(clock, DEFAULT_HOS_CONFIG, 1, clock.dutyWindowStartAt);
      const inserted = plan.segments.find((s) => s.kind !== "drive");
      const expected = inserted?.kind === "break" ? "break-30min" : "rest-10h";
      expect(v.restReason).toBe(expected);
    });
  }
});

function hubObs(over: Partial<HubObservation>): HubObservation {
  return {
    kind: "hub",
    stableId: "MEM",
    tick: 300,
    assignedCenterId: "MEM",
    inboundQueueDepth: 0,
    outboundQueueDepth: 0,
    dockDoorsAvailable: 1,
    trailerFillCount: 0,
    pendingConsolidationCount: 0,
    ...over,
  };
}

describe("hubDockFeasibility — dock verdict (OODA-03 Task 1)", () => {
  it("a free dock door ⇒ canDispatch + canConsolidate", () => {
    expect(hubDockFeasibility(hubObs({ dockDoorsAvailable: 1 }))).toEqual({
      canDispatch: true,
      canConsolidate: true,
    });
  });

  it("no free dock door ⇒ neither (the hub is bound to hold)", () => {
    expect(hubDockFeasibility(hubObs({ dockDoorsAvailable: 0 }))).toEqual({
      canDispatch: false,
      canConsolidate: false,
    });
  });
});

// ===========================================================================
// Task 2 — infeasible outcomes are UNREACHABLE (the OODA-03 contract).
// ===========================================================================

const rng = () => deriveAgentRng(42, "T0001");

/** Enumerate the truck observation space across HOS × fuel × congestion × dock. */
function truckObservationSpace(): AgentObservation[] {
  const clocks: HosClock[] = [HOS_FULL, HOS_OUT_OF_DRIVE, HOS_AT_BREAK_EDGE];
  const odometers = [0, FUEL.refuelThresholdMiles - 1, FUEL.refuelThresholdMiles, 5_000];
  const queues = [0, 5, 999];
  const docks = [true, false];
  const out: AgentObservation[] = [];
  for (const hosClock of clocks)
    for (const odometerMiles of odometers)
      for (const nextHubQueueDepth of queues)
        for (const nextHubDockAvailable of docks)
          out.push(truckObs({ hosClock, odometerMiles, nextHubQueueDepth, nextHubDockAvailable }));
  return out;
}

const FEAS_CTX = { hosConfig: DEFAULT_HOS_CONFIG, fuelConfig: FUEL, now: NOW_MIN };

describe("decideTruck — infeasible outcomes are UNREACHABLE (OODA-03 Task 2)", () => {
  it("NEVER emits proceed/divert when HOS is out of legal hours (across the space)", () => {
    for (const obs of truckObservationSpace()) {
      const v = truckLegFeasibility(obs, DEFAULT_HOS_CONFIG, FUEL, NOW_MIN);
      const d = decideTruck(obs, rng(), FEAS_CTX);
      if (!v.canDrive) {
        // out of hours ⇒ the agent must bind to rest (or refuel only if also legal —
        // but it isn't, so rest). It must NOT proceed or divert (driving while illegal).
        expect(d.kind === "proceed" || d.kind === "divert").toBe(false);
        expect(d.kind).toBe("rest");
      }
    }
  });

  it("when legal but over the fuel threshold ⇒ refuel (never proceed-while-low-fuel)", () => {
    for (const obs of truckObservationSpace()) {
      const v = truckLegFeasibility(obs, DEFAULT_HOS_CONFIG, FUEL, NOW_MIN);
      const d = decideTruck(obs, rng(), FEAS_CTX);
      if (v.canDrive && v.mustRefuel) {
        expect(d.kind).toBe("refuel");
      }
    }
  });

  it("a feasibility-consistent decision for EVERY observation in the space", () => {
    for (const obs of truckObservationSpace()) {
      const v = truckLegFeasibility(obs, DEFAULT_HOS_CONFIG, FUEL, NOW_MIN);
      const d = decideTruck(obs, rng(), FEAS_CTX);
      if (d.kind === "proceed" || d.kind === "divert") {
        // a moving decision is only legal when the truck may actually drive AND has fuel.
        expect(v.canDrive).toBe(true);
        expect(v.mustRefuel).toBe(false);
      }
    }
  });
});

function hubObservationSpace(): HubObservation[] {
  const out: HubObservation[] = [];
  for (const dockDoorsAvailable of [0, 1])
    for (const outboundQueueDepth of [0, 3])
      for (const pendingConsolidationCount of [0, 4])
        for (const trailerFillCount of [0, 2])
          out.push(
            hubObs({ dockDoorsAvailable, outboundQueueDepth, pendingConsolidationCount, trailerFillCount }),
          );
  return out;
}

describe("decideHub — infeasible dispatch/consolidate is UNREACHABLE (OODA-03 Task 2)", () => {
  it("NEVER dispatches or consolidates when no dock door is free ⇒ hold", () => {
    for (const obs of hubObservationSpace()) {
      const v = hubDockFeasibility(obs);
      const d = decideHub(obs, deriveAgentRng(42, obs.stableId));
      if (!v.canDispatch) {
        expect(d.kind === "dispatch" || d.kind === "consolidate").toBe(false);
        expect(d.kind).toBe("hold");
      }
    }
  });

  it("a dispatch/consolidate decision implies a free dock (feasibility-consistent)", () => {
    for (const obs of hubObservationSpace()) {
      const v = hubDockFeasibility(obs);
      const d = decideHub(obs, deriveAgentRng(42, obs.stableId));
      if (d.kind === "dispatch" || d.kind === "consolidate") {
        expect(v.canDispatch).toBe(true);
      }
    }
  });
});
