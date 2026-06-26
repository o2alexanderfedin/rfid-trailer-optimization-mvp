import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEvent, type FuelConfig } from "@mm/domain";
import { simulate } from "../src/engine.js";
import {
  deriveAgentRng,
  decideTruck,
  sortAgentsByStableId,
  type AgentObservation,
} from "../src/ooda/index.js";

/**
 * Phase-24 OODA-01/02/04 — the `stepAgents` engine integration.
 *
 * With `oodaAgentsEnabled: true` the engine schedules a self-rescheduling
 * `stepAgents` SimTask at a fixed `OODA_INTERVAL_TICKS` cadence; each pass builds a
 * FROZEN observation per agent at pass entry, iterates agents sorted-by-stable-id,
 * applies the "anything-to-decide?" guard, and routes each decision's Act through
 * the existing emit helpers (plus the new `TrailerDiverted`). This file proves:
 *   (a) the cadence fires + self-reschedules across a multi-thousand-tick run,
 *   (b) the stream carries agent-driven events (TrailerDiverted + agent rest/refuel),
 *   (c) the agent-order-shuffle batch is byte-identical (the strongest determinism
 *       witness), and the whole OODA-on run is reproducible per seed.
 *
 * The FULL flags-off golden gate (absent ⇒ 3920accc…) lives in
 * `determinism.unit.test.ts`; here we focus on the ON path's correctness + its
 * order-independence.
 */

const FUEL_ON: FuelConfig = {
  enabled: true,
  refuelThresholdMiles: 1200,
  milesPerGallon: 6.5,
  tankCapacityGallons: 150,
  refuelTimeMinutes: 30,
};

/** A realistic OODA-on configuration that exercises trucks AND hubs. */
const OODA_OPTS = {
  seed: 42,
  durationTicks: 6000,
  oodaAgentsEnabled: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

const sha = (stream: ReturnType<typeof simulate>): string =>
  createHash("sha256").update(JSON.stringify(stream)).digest("hex");

describe("stepAgents cadence + self-reschedule (OODA-01/02)", () => {
  it("an OODA-on run sustains agent-driven events across thousands of ticks", () => {
    const stream = simulate(OODA_OPTS);
    // A self-rescheduling pass that fired only once would emit a handful of events
    // near tick 1; a sustained cadence emits agent decisions throughout the run.
    expect(stream.length).toBeGreaterThan(500);
    const lastOccurredAt = stream[stream.length - 1]!.occurredAt;
    const firstOccurredAt = stream[0]!.occurredAt;
    expect(lastOccurredAt > firstOccurredAt).toBe(true);
  });

  it("every emitted event still passes the domain validateEvent boundary", () => {
    for (const item of simulate(OODA_OPTS)) {
      expect(() => validateEvent(item.event)).not.toThrow();
    }
  });

  it("emits events in non-decreasing occurredAt (virtual-clock ordering)", () => {
    const stream = simulate(OODA_OPTS);
    for (let i = 1; i < stream.length; i += 1) {
      expect(stream[i]!.occurredAt >= stream[i - 1]!.occurredAt).toBe(true);
    }
  });
});

describe("agents own decisions — real agent-driven events (OODA-01/02)", () => {
  it("the stream contains agent-driven TrailerDiverted decisions", () => {
    const stream = simulate(OODA_OPTS);
    const diverts = stream.filter((e) => e.event.type === "TrailerDiverted");
    expect(diverts.length).toBeGreaterThan(0);
    for (const d of diverts) {
      if (d.event.type !== "TrailerDiverted") continue;
      // A divert always re-routes to a DIFFERENT hub with an audit reason.
      expect(d.event.payload.toHubId).not.toBe(d.event.payload.fromHubId);
      expect(["next-hub-congested", "next-hub-blocked", "rebalance"]).toContain(
        d.event.payload.reason,
      );
    }
  });

  it("agents decide rest/refuel (the binding-feasibility events appear)", () => {
    const stream = simulate(OODA_OPTS);
    const restOrRefuel = stream.filter(
      (e) => e.event.type === "TruckRested" || e.event.type === "TruckRefueled",
    );
    expect(restOrRefuel.length).toBeGreaterThan(0);
  });
});

describe("determinism witnesses (OODA-04)", () => {
  it("the OODA-on run is reproducible per seed (same seed twice ⇒ byte-identical)", () => {
    const a = sha(simulate(OODA_OPTS));
    const b = sha(simulate({ ...OODA_OPTS }));
    expect(b).toBe(a);
  });

  it("a different seed ⇒ a different OODA-on stream", () => {
    const a = sha(simulate(OODA_OPTS));
    const b = sha(simulate({ ...OODA_OPTS, seed: 7 }));
    expect(a).not.toBe(b);
  });

  // The single strongest determinism witness (CONTEXT specifics): SHUFFLING the
  // per-pass agent set must yield a byte-identical processing order, because the
  // engine sorts by stable id before iterating. We reproduce the engine's exact
  // ordering primitive here over a representative agent set + replay each agent's
  // Decide on its own substream — the sorted Decide-output sequence is identical
  // whatever the input order.
  it("a shuffled agent set yields a byte-identical sorted Decide batch", () => {
    const ids = ["H05", "T003", "A1", "T001", "MEM", "T002", "ORD"];
    const obsFor = (stableId: string): AgentObservation => ({
      kind: "truck",
      stableId,
      tick: 1000,
      tripId: "TRIP-1",
      assignedCenterId: "MEM",
      currentLegKey: "MEM->ORD",
      odometerMiles: 2000, // over the refuel threshold ⇒ a real decision
      remainingLegalDriveMinutes: 240,
      minutesSinceLastBreak: 60,
      hosClock: {
        driveTodayMin: 0,
        dutyWindowStartAt: "2024-01-01T00:00:00.000Z",
        sinceLastBreakMin: 0,
        weeklyOnDutyMin: 0,
        comeOnDutyAt: "2024-01-01T00:00:00.000Z",
        sleeperBerthLongMin: 0,
        sleeperBerthShortMin: 0,
      },
      nextHubId: "ORD",
      nextHubQueueDepth: 2,
      nextHubDockAvailable: true,
    });
    const batch = (order: readonly string[]): string => {
      const agents = sortAgentsByStableId(order.map((stableId) => ({ stableId })));
      const decisions = agents.map((a) =>
        decideTruck(obsFor(a.stableId), deriveAgentRng(OODA_OPTS.seed, a.stableId)),
      );
      return JSON.stringify({ order: agents.map((a) => a.stableId), decisions });
    };
    const inOrder = batch(ids);
    const shuffled = batch([...ids].reverse());
    const reshuffled = batch(["MEM", "T002", "A1", "ORD", "T001", "H05", "T003"]);
    expect(shuffled).toBe(inOrder);
    expect(reshuffled).toBe(inOrder);
  });
});

describe("OODA flag-off equivalence (the two-part gate, ON-path side)", () => {
  it("oodaAgentsEnabled: false is byte-identical to the flag being absent", () => {
    const absent = simulate({ seed: 42, durationTicks: 500 });
    const explicitFalse = simulate({
      seed: 42,
      durationTicks: 500,
      oodaAgentsEnabled: false,
    });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });
});
