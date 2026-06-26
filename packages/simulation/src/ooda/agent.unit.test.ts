import { describe, expect, expectTypeOf, it } from "vitest";
import { type Agent, type AgentKind, sortAgentsByStableId } from "./agent.js";
import type { AgentObservation, TruckDecision } from "./observe.js";

/**
 * Phase-24 OODA-04 — the order-independence witness + the frozen-observation /
 * decision contracts (RED first).
 *
 * The single strongest determinism witness (CONTEXT specifics): shuffle the
 * per-tick agent set, sort by stable id, and the batch order is byte-identical —
 * agents are processed by their STABLE id, never Map/Set/array insertion order.
 */

interface TestAgent {
  readonly stableId: string;
  readonly tag: number;
}

const roster: readonly TestAgent[] = [
  { stableId: "T0003", tag: 3 },
  { stableId: "T0001", tag: 1 },
  { stableId: "T0010", tag: 10 },
  { stableId: "T0002", tag: 2 },
  { stableId: "hub-ORD", tag: 99 },
  { stableId: "hub-MEM", tag: 98 },
];

describe("sortAgentsByStableId — order-independence witness (OODA-04)", () => {
  it("sorts ascending by the stable id string", () => {
    const sorted = sortAgentsByStableId(roster).map((a) => a.stableId);
    expect(sorted).toEqual(["T0001", "T0002", "T0003", "T0010", "hub-MEM", "hub-ORD"]);
  });

  it("a SHUFFLED input yields a byte-identical sorted output (the witness)", () => {
    // Several arbitrary permutations of the same set must all sort identically.
    const permutations: TestAgent[][] = [
      [...roster].reverse(),
      [roster[2]!, roster[0]!, roster[5]!, roster[1]!, roster[4]!, roster[3]!],
      [roster[5]!, roster[4]!, roster[3]!, roster[2]!, roster[1]!, roster[0]!],
    ];
    const canonical = sortAgentsByStableId(roster).map((a) => a.stableId);
    for (const perm of permutations) {
      expect(sortAgentsByStableId(perm).map((a) => a.stableId)).toEqual(canonical);
    }
  });

  it("returns a NEW array (never mutates / aliases the input)", () => {
    const input = [...roster];
    const out = sortAgentsByStableId(input);
    expect(out).not.toBe(input);
    // Input order is untouched.
    expect(input.map((a) => a.stableId)).toEqual(roster.map((a) => a.stableId));
  });

  it("is a stable, locale-independent string compare (codepoint order)", () => {
    const ids = [{ stableId: "B" }, { stableId: "a" }, { stableId: "A" }, { stableId: "b" }];
    // ASCII codepoint order: uppercase before lowercase ('A'=65 < 'a'=97).
    expect(sortAgentsByStableId(ids).map((a) => a.stableId)).toEqual(["A", "B", "a", "b"]);
  });
});

describe("Agent / AgentObservation / TruckDecision contracts (OODA-01/04)", () => {
  it("AgentKind is the closed truck|hub literal union", () => {
    expectTypeOf<AgentKind>().toEqualTypeOf<"truck" | "hub">();
  });

  it("Agent carries a readonly stableId + kind", () => {
    const a: Agent = { kind: "truck", stableId: "T0001" };
    expect(a.stableId).toBe("T0001");
    expectTypeOf<Agent["stableId"]>().toEqualTypeOf<string>();
  });

  it("AgentObservation is a readonly integer/string snapshot (no float geometry, no methods)", () => {
    const obs: AgentObservation = {
      kind: "truck",
      stableId: "T0001",
      tick: 1200,
      tripId: "TRIP-9",
      assignedCenterId: "MEM",
      currentLegKey: "MEM->ORD",
      odometerMiles: 412,
      remainingLegalDriveMinutes: 35,
      minutesSinceLastBreak: 470,
      hosClock: {
        driveTodayMin: 640,
        dutyWindowStartAt: "2024-01-01T00:00:00.000Z",
        sinceLastBreakMin: 470,
        weeklyOnDutyMin: 3000,
        comeOnDutyAt: "2024-01-01T00:00:00.000Z",
        sleeperBerthLongMin: 0,
        sleeperBerthShortMin: 0,
      },
      nextHubId: "ORD",
      nextHubQueueDepth: 7,
      nextHubDockAvailable: false,
    };
    expect(obs.odometerMiles).toBe(412);
    // All decision-relevant numerics are integers (PITFALLS Pitfall 2 — no
    // transcendental geometry in hashed/decision payloads).
    expectTypeOf<AgentObservation["odometerMiles"]>().toEqualTypeOf<number>();
    expectTypeOf<AgentObservation["remainingLegalDriveMinutes"]>().toEqualTypeOf<number>();
    expectTypeOf<AgentObservation["nextHubDockAvailable"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AgentObservation["currentLegKey"]>().toEqualTypeOf<string | null>();
  });

  it("TruckDecision is a closed discriminated union (proceed|divert|rest|refuel|hold)", () => {
    const decisions: TruckDecision[] = [
      { kind: "proceed" },
      { kind: "divert", toHubId: "DFW", reason: "next-hub-congested" },
      { kind: "rest", reason: "rest-10h", durationMin: 600 },
      { kind: "refuel", gallons: 120, odometerMiles: 1500, durationMin: 30 },
      { kind: "hold", reason: "dock-unavailable" },
    ];
    expect(decisions.map((d) => d.kind)).toEqual([
      "proceed",
      "divert",
      "rest",
      "refuel",
      "hold",
    ]);
    expectTypeOf<TruckDecision["kind"]>().toEqualTypeOf<
      "proceed" | "divert" | "rest" | "refuel" | "hold"
    >();
  });
});
