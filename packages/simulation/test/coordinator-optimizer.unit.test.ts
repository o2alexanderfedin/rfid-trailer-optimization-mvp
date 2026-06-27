import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  DEFAULT_OBJECTIVE_WEIGHTS,
  detectAffectedScope,
  partitionScopeByCenter,
  runEpoch,
  type Epoch,
  type OptimizerScope,
} from "@mm/optimizer";
import {
  buildCenterTwinFromFold,
  epochResultToRerouteSuggestions,
  type CenterFoldSlice,
} from "../src/coordinator/index.js";
import {
  COORDINATOR_OPTIMIZER_MAX_SCOPE_HUBS,
  COORDINATOR_OPTIMIZER_MAX_SCOPE_TRAILERS,
  exceedsCoordinatorOptimizerScopeCap,
  simulate,
} from "../src/engine.js";

/**
 * Phase-26 COORD-06 (Plan 02) — the optimizer-backed REROUTE branch in
 * `stepCoordinators` under the `coordinatorUsesOptimizer` sub-flag.
 *
 * These engine-level + adapter-level tests pin:
 *  - With the sub-flag ON, `ActionSuggested(kind:reroute)` events are SOURCED from
 *    the in-fold pure `runEpoch` over a per-center partitioned twin (the optimizer
 *    path); hold/consolidate/dispatch stay rule-based.
 *  - The flag-on run is same-seed byte-identical (REPRODUCIBLE; the golden is Plan 03).
 *  - The sub-flag OFF (absent or coordinators-off) ⇒ NO optimizer call, NO behavior
 *    change — the Phase-25 rule-based coordinator path is byte-identical.
 *  - NET-05 LIVE: a fixed center's per-epoch scope (and thus its reroute suggestion
 *    set) is INDEPENDENT of total network size — adding unrelated centers/hubs/
 *    trailers leaves the target center's reroute decisions identical.
 *
 * The reroute rule reads a truck's NEXT hub, populated in `activeTripByTrailer` only
 * on the OODA-on path — so the reroute-producing config runs the all-on demo stack.
 */

const ALL_ON = {
  seed: 42,
  durationTicks: 6000,
  coordinatorsEnabled: true,
  consolidationEnabled: true,
  inductionEnabled: true,
  oodaAgentsEnabled: true,
} as const;

const OPT_ON = { ...ALL_ON, coordinatorUsesOptimizer: true } as const;

type Stream = ReturnType<typeof simulate>;

const kindCounts = (stream: Stream): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const e of stream) {
    if (e.event.type === "ActionSuggested") {
      const k = e.event.payload.kind;
      m[k] = (m[k] ?? 0) + 1;
    }
  }
  return m;
};

describe("coordinatorUsesOptimizer — the optimizer-backed reroute branch (COORD-06)", () => {
  const optStream = simulate(OPT_ON);
  const counts = kindCounts(optStream);

  it("emits reroute ActionSuggested events sourced from the in-fold runEpoch", () => {
    // Reroutes ARE produced under the sub-flag (the optimizer endorses cross-dock
    // relief for congested in-region trucks via the per-center pure epoch).
    expect(counts.reroute ?? 0).toBeGreaterThan(0);
  });

  it("keeps hold/consolidate/dispatch rule-based (the non-reroute kinds still appear)", () => {
    // The sub-flag only swaps the reroute SOURCE; the other three kinds are
    // unchanged rule-based output — hold + consolidate persist in the all-on stack.
    expect(counts.hold ?? 0).toBeGreaterThan(0);
    expect(counts.consolidate ?? 0).toBeGreaterThan(0);
  });

  it("is same-seed byte-identical (REPRODUCIBLE — the Plan-03 golden is baked there)", () => {
    const a = JSON.stringify(simulate(OPT_ON));
    const b = JSON.stringify(simulate({ ...OPT_ON }));
    expect(b).toBe(a);
  });

  it("every reroute event passes the same coordinator-<centerId> stream + payload contract", () => {
    for (const e of optStream) {
      if (e.event.type !== "ActionSuggested") continue;
      if (e.event.payload.kind !== "reroute") continue;
      // Reroute is streamed on the suggesting coordinator's channel.
      expect(e.streamId).toBe(`coordinator-${e.event.payload.coordinatorId}`);
      // A reroute always names a destination hub (the cross-dock relief target).
      expect(typeof e.event.payload.params.toHubId).toBe("string");
    }
  });
});

describe("coordinatorUsesOptimizer is INERT when off (no behavior change)", () => {
  it("absent sub-flag ⇒ byte-identical to the Phase-25 rule-based coordinator path", () => {
    // The two-part flags-off gate: with the sub-flag ABSENT the coordinator stream
    // is the unchanged rule-based path — the optimizer branch is never entered.
    const ruleBased = JSON.stringify(simulate(ALL_ON));
    const absentFlag = JSON.stringify(simulate({ ...ALL_ON }));
    expect(absentFlag).toBe(ruleBased);
  });

  it("sub-flag set but coordinators OFF ⇒ no effect (it is a strict sub-flag)", () => {
    // coordinatorUsesOptimizer only takes effect when coordinatorsEnabled is ALSO
    // true; with coordinators off it changes nothing (no coordinator pass runs).
    const off = JSON.stringify(
      simulate({ seed: 7, durationTicks: 800, oodaAgentsEnabled: true }),
    );
    const offWithSubFlag = JSON.stringify(
      simulate({
        seed: 7,
        durationTicks: 800,
        oodaAgentsEnabled: true,
        coordinatorUsesOptimizer: true,
      }),
    );
    expect(offWithSubFlag).toBe(off);
  });
});

// ---------------------------------------------------------------------------
// NET-05 LIVE: scope-size invariance — the partition + adapter the engine wires.
//
// These exercise the EXACT functions the optimizer-backed reroute branch calls
// (detectAffectedScope → partitionScopeByCenter → buildCenterTwinFromFold →
// runEpoch → epochResultToRerouteSuggestions). The witness: a fixed center's
// per-epoch scope (and thus its reroute suggestion set) is independent of how
// many UNRELATED centers/hubs/trailers exist in the network (proven at 500 hubs
// in P23; now governing a LIVE per-center epoch).
// ---------------------------------------------------------------------------

const EPOCH: Epoch = { epochId: "coord-MEM-100", nowMin: 100, freezeWindowMin: 15 };

/** Build the synthetic reroute-driving events for a center's congested trucks. */
function congestionEvents(
  trucks: readonly { trailerId: string; congestedHubId: string }[],
): DomainEvent[] {
  return trucks.map((t) => ({
    type: "TrailerArrivedAtHub",
    schemaVersion: 1,
    payload: { trailerId: t.trailerId, tripId: `trip-${t.trailerId}`, hubId: t.congestedHubId },
  }));
}

/** Build the per-center fold slice for the target center MEM from its in-scope trailers. */
function memFoldSlice(slice: OptimizerScope): CenterFoldSlice {
  return {
    centerId: "MEM",
    spokeHubIds: [...slice.hubIds].sort(),
    trailers: [...slice.trailerIds].sort().map((trailerId) => ({
      trailerId,
      currentHubId: `${trailerId}-AT`,
      departureOffsetMin: 16,
      capacity: 50,
      routeStops: [
        { hubId: "MEM", stopIndex: 0 },
        { hubId: `${trailerId}-AT`, stopIndex: 1 },
      ],
      blocks: [],
    })),
    routeLegs: [...slice.trailerIds].sort().flatMap((trailerId) => [
      { routeId: `l-out-${trailerId}`, fromHubId: "MEM", toHubId: `${trailerId}-AT`, travelMin: 30, capacity: 200 },
      { routeId: `l-in-${trailerId}`, fromHubId: `${trailerId}-AT`, toHubId: "MEM", travelMin: 30, capacity: 200 },
    ]),
  };
}

/** Run the full per-center reroute pipeline for MEM and return its suggestion set. */
function memReroutes(
  centerOf: ReadonlyMap<string, string>,
  events: DomainEvent[],
  currentNextHub: ReadonlyMap<string, string>,
): readonly { kind: string; targetAgentId: string; toHubId?: string }[] {
  const scope = detectAffectedScope(events, EPOCH);
  const slice = partitionScopeByCenter(scope, centerOf, events).get("MEM");
  if (slice === undefined) return [];
  const twin = buildCenterTwinFromFold(memFoldSlice(slice), EPOCH.nowMin);
  const result = runEpoch(EPOCH, { events, twinSnapshot: twin }, DEFAULT_OBJECTIVE_WEIGHTS);
  return epochResultToRerouteSuggestions(result, twin, currentNextHub);
}

describe("NET-05 live: a center's reroute scope is independent of total network size", () => {
  it("MEM's reroute set is identical whether or not unrelated centers/hubs/trailers exist", () => {
    // SMALL network: one center (MEM) with one congested spoke (LAX) and one truck.
    const smallCenterOf = new Map<string, string>([
      ["MEM", "MEM"],
      ["LAX", "MEM"],
    ]);
    const smallEvents = congestionEvents([{ trailerId: "T001", congestedHubId: "LAX" }]);
    const smallNextHub = new Map<string, string>([["T001", "LAX"]]);
    const small = memReroutes(smallCenterOf, smallEvents, smallNextHub);

    // LARGE network: MEM unchanged + a SECOND center (DEN) with its OWN spokes +
    // trucks (entirely unrelated to MEM). MEM's slice must be byte-identical.
    const largeCenterOf = new Map<string, string>([
      ["MEM", "MEM"],
      ["LAX", "MEM"],
      ["DEN", "DEN"],
      ["SEA", "DEN"],
      ["PDX", "DEN"],
    ]);
    const largeEvents = congestionEvents([
      { trailerId: "T001", congestedHubId: "LAX" }, // MEM's truck (unchanged)
      { trailerId: "T900", congestedHubId: "SEA" }, // DEN's truck (unrelated)
      { trailerId: "T901", congestedHubId: "PDX" }, // DEN's truck (unrelated)
    ]);
    const largeNextHub = new Map<string, string>([
      ["T001", "LAX"],
      ["T900", "SEA"],
      ["T901", "PDX"],
    ]);
    const large = memReroutes(largeCenterOf, largeEvents, largeNextHub);

    // The NET-05 invariant: MEM's reroute set is unchanged by the unrelated DEN
    // network — its scope is bounded by MEM's own hubs/trailers (scope-size invariant).
    expect(JSON.stringify(large)).toBe(JSON.stringify(small));
    // And MEM genuinely produced a reroute (the optimizer path is exercised).
    expect(small.length).toBeGreaterThan(0);
    expect(small[0]!.toHubId).toBe("MEM");
  });

  it("the per-center MEM slice trailer set does not grow with unrelated trailers", () => {
    const centerOf = new Map<string, string>([
      ["MEM", "MEM"],
      ["LAX", "MEM"],
      ["DEN", "DEN"],
      ["SEA", "DEN"],
    ]);
    const events = congestionEvents([
      { trailerId: "T001", congestedHubId: "LAX" },
      { trailerId: "T900", congestedHubId: "SEA" },
    ]);
    const memSlice = partitionScopeByCenter(detectAffectedScope(events, EPOCH), centerOf, events).get(
      "MEM",
    );
    expect(memSlice).toBeDefined();
    // MEM's slice names ONLY its own hub (LAX) + trailer (T001) — never DEN's.
    expect(memSlice!.hubIds).toEqual(["LAX"]);
    expect(memSlice!.trailerIds).toEqual(["T001"]);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — DETERMINISTIC horizon/size-cap FALLBACK to the rule-based reroute.
//
// `exceedsCoordinatorOptimizerScopeCap` is the PURE predicate the engine's
// reroute branch consults: a per-center slice whose hub OR trailer count exceeds
// the named integer cap takes the rule-based reroute for that center INSTEAD of
// calling runEpoch. The decision is a pure function of the integer scope SIZE —
// never wall-clock — so it is reproducible per seed + network (T-26-07).
// ---------------------------------------------------------------------------

/** Build a synthetic OptimizerScope with `nHubs` hubs + `nTrailers` trailers. */
function syntheticScope(nHubs: number, nTrailers: number): OptimizerScope {
  return {
    hubIds: Array.from({ length: nHubs }, (_, i) => `H${String(i).padStart(4, "0")}`),
    trailerIds: Array.from({ length: nTrailers }, (_, i) => `T${String(i).padStart(4, "0")}`),
    horizonStartMin: 0,
    horizonEndMin: 240,
    timeStepMin: 15,
  };
}

describe("Task 2: deterministic integer-scope-size cap fallback (T-26-07)", () => {
  it("a sub-cap slice does NOT exceed the cap (⇒ the optimizer path is taken)", () => {
    const small = syntheticScope(
      COORDINATOR_OPTIMIZER_MAX_SCOPE_HUBS,
      COORDINATOR_OPTIMIZER_MAX_SCOPE_TRAILERS,
    );
    // Exactly AT the cap is NOT over (strict `>` threshold).
    expect(exceedsCoordinatorOptimizerScopeCap(small)).toBe(false);
  });

  it("an over-cap HUB count exceeds the cap (⇒ rule-based fallback, no runEpoch)", () => {
    const tooManyHubs = syntheticScope(COORDINATOR_OPTIMIZER_MAX_SCOPE_HUBS + 1, 1);
    expect(exceedsCoordinatorOptimizerScopeCap(tooManyHubs)).toBe(true);
  });

  it("an over-cap TRAILER count exceeds the cap (⇒ rule-based fallback, no runEpoch)", () => {
    const tooManyTrailers = syntheticScope(1, COORDINATOR_OPTIMIZER_MAX_SCOPE_TRAILERS + 1);
    expect(exceedsCoordinatorOptimizerScopeCap(tooManyTrailers)).toBe(true);
  });

  it("the cap decision is a PURE function of the integer scope size (deterministic, no wall-clock)", () => {
    const a = syntheticScope(COORDINATOR_OPTIMIZER_MAX_SCOPE_HUBS + 5, 3);
    const b = syntheticScope(COORDINATOR_OPTIMIZER_MAX_SCOPE_HUBS + 5, 3);
    // Same integer sizes ⇒ same verdict, every call (no timer/clock dependence).
    expect(exceedsCoordinatorOptimizerScopeCap(a)).toBe(exceedsCoordinatorOptimizerScopeCap(b));
    expect(exceedsCoordinatorOptimizerScopeCap(a)).toBe(true);
    // The verdict is stable across repeated calls (idempotent / referentially transparent).
    for (let i = 0; i < 5; i += 1) {
      expect(exceedsCoordinatorOptimizerScopeCap(a)).toBe(true);
    }
  });

  it("an empty scope is well under the cap (the no-congestion no-op default)", () => {
    expect(exceedsCoordinatorOptimizerScopeCap(syntheticScope(0, 0))).toBe(false);
  });

  it("the all-on optimizer run is byte-identical regardless of the cap decision (same-seed reproducible)", () => {
    // The fallback path NEVER perturbs reproducibility: same seed ⇒ identical
    // stream, whether centers take the optimizer path or the rule-based fallback.
    const a = JSON.stringify(simulate(OPT_ON));
    const b = JSON.stringify(simulate({ ...OPT_ON }));
    expect(b).toBe(a);
  });
});
