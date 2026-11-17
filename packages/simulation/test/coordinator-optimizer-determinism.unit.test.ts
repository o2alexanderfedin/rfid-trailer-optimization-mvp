import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEvent, type FuelConfig } from "@mm/domain";
import { simulate } from "../src/engine.js";
import {
  FLAGS_OFF_GOLDEN_SHA256,
  OODA_ON_GOLDEN_SHA256,
  COORDINATOR_ON_GOLDEN_SHA256,
  OPTIMIZER_ON_GOLDEN_SHA256,
} from "./goldens.js";

/**
 * Phase-26 COORD-06 (Plan 03) — THE OPTIMIZER-BACKED COORDINATOR DETERMINISM
 * GOLDEN (the milestone keystone, optimizer arm). Mirrors
 * coordinator-determinism.unit.test.ts EXACTLY, with `coordinatorUsesOptimizer:
 * true` layered onto the Phase-25 all-on coordinator stack.
 *
 * The witnesses:
 *
 *   1. OPTIMIZER-ON GOLDEN: simulate({ seed 42, 10k, the Phase-25 all-on stack +
 *      coordinatorUsesOptimizer:true }) hashes to a committed SHA-256, captured
 *      REPRODUCIBILITY-FIRST (run twice in-process ⇒ equal, AND across two separate
 *      node-process invocations ⇒ equal, BEFORE baking the literal — PITFALLS: never
 *      commit a non-reproducible golden).
 *   2. The optimizer-on stream carries NON-TRIVIAL reroute `ActionSuggested` counts
 *      (the route-aware suggestions are observably present — the optimizer path is
 *      REAL, not skipped) and every emitted event passes the domain `validateEvent`
 *      boundary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOCUMENTED-EQUALITY FINDING (Plan-03, Option A — planner-truth #2 amendment).
 *
 * The plan's original truth #2 expected this golden to DIFFER from the Phase-25
 * rule-based coordinator golden `edfa5a6d…`. Empirically — and verified by direct
 * instrumentation — it is BYTE-IDENTICAL to `edfa5a6d…` on EVERY config tested
 * (single-center legacy, continental, continental+fleet 2/4/8). This is NOT the
 * optimizer being skipped:
 *
 *   - The optimizer is GENUINELY INVOKED: instrumenting the engine's reroute branch
 *     showed `runEpoch` ran 2000 epochs over the 10k seed-42 run, producing 9663
 *     pre-guard reroute suggestions, with 0 fallbacks to the rule-based path (the
 *     scope-size cap is never hit) — the in-fold pure runEpoch really does drive the
 *     reroute kind.
 *   - It ENDORSES THE SAME DECISION as the rule-based heuristic: on the current
 *     Plan-02 per-center twin the route HEAD is structurally pinned to the center
 *     (`obs.centerId`, stopIndex 0) — exactly the `toHubId` the rule-based reroute
 *     also picks (cross-dock relief at the trailer's own center) — AND the twin is
 *     built always-feasible / never-frozen (departureMin past the freeze window,
 *     empty blocks), so the optimizer's `feasible && !frozen` gate never DECLINES a
 *     reroute the rule flags. So the route-aware path can only ENDORSE the same
 *     "reroute the congested truck back to its center" decision — a byte-stable,
 *     reproducible SUPERSET that COINCIDES with the rule-based stream on this
 *     topology.
 *
 * Therefore this golden is asserted EQUAL to `edfa5a6d…` (a truthful determinism
 * pin), and the literal value below IS `edfa5a6d…`. Making the optimizer-backed
 * reroute GENUINELY route-aware-divergent (real freeze-windows/capacity in the twin
 * + a real choice of destination beyond the center) is a Phase-27 carry-over,
 * bundled with the reject-with-reason continental scenario tuning — both are
 * "make the continental demo showcase the smart behaviour" tasks.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const sha = (s: ReturnType<typeof simulate>): string =>
  createHash("sha256").update(JSON.stringify(s)).digest("hex");

const FUEL_ON: FuelConfig = {
  enabled: true,
  refuelThresholdMiles: 1200,
  milesPerGallon: 6.5,
  tankCapacityGallons: 150,
  refuelTimeMinutes: 30,
};

/**
 * The optimizer-on golden configuration: the EXACT Phase-25 all-on coordinator
 * stack (the config the `edfa5a6d…` coordinator golden was captured over — see
 * coordinator-determinism.unit.test.ts) + `coordinatorUsesOptimizer: true`. The
 * LEGACY single-center star is used (NOT `continentalTopology`): the continental
 * topology produces ZERO reroutes (freight spreads thin — the 25-02 finding), so it
 * does not exercise the optimizer reroute path at all; the legacy all-on stack fires
 * non-trivial reroute counts AND genuinely drives `runEpoch` (2000 epochs / 9663
 * pre-guard reroutes / 0 fallbacks, instrumented), so it is the config the optimizer
 * model actually exercises.
 */
const COORDINATOR_OPTIMIZER_ON_OPTS = {
  seed: 42,
  durationTicks: 10000,
  coordinatorsEnabled: true,
  coordinatorUsesOptimizer: true,
  oodaAgentsEnabled: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

// See goldens.ts for OPTIMIZER_ON_GOLDEN_SHA256 (= COORDINATOR_OPTIMIZER_ON) and the
// three prior goldens (COORDINATOR_ON, FLAGS_OFF, OODA_ON) — captured
// reproducibility-first on arm64 darwin (P27-A, plan 27-04). Full provenance, cross-arch
// contingency, and the documented divergence from edfa5a6d… are documented there.
//
// DOCUMENTED DIVERGENCE (P27-A — COORD-06 criterion-1): OPTIMIZER_ON_GOLDEN_SHA256
// DIFFERS from the Phase-25 rule-based coordinator golden edfa5a6d…. The three
// structural pins in `optimizerRerouteFor` have been removed (Plan 27-04 Task 1):
//   PIN 1: route head is now the LEAST-CONGESTED relief spoke (not always obs.centerId)
//   PIN 2: departureOffsetMin derived from real transit median + dwell (not FREEZE+1)
//   PIN 3: real block volume from inboundDepthByHub (not empty blocks) + real per-leg
//          travelMin/distanceMiles from transitByLeg/legMilesFor
// As a result the optimizer can now DECLINE over-capacity reroutes and CHOOSE genuinely
// different destinations — producing a divergent event stream (reroute 7378 vs 9553).
// The three prior goldens (3920accc/edfa5a6d/94689f99) are byte-identical (asserted below).

describe("optimizer-backed coordinator 10k golden (COORD-06, reproducibility-first)", () => {
  it("simulate(seed 42, 10k, coordinatorUsesOptimizer + all-on) hashes to the committed SHA-256", () => {
    expect(sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS))).toBe(
      OPTIMIZER_ON_GOLDEN_SHA256,
    );
  });

  it("the optimizer-on run is reproducible within a process (same hash twice)", () => {
    const a = sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS));
    const b = sha(simulate({ ...COORDINATOR_OPTIMIZER_ON_OPTS }));
    expect(b).toBe(a);
    expect(a).toBe(OPTIMIZER_ON_GOLDEN_SHA256);
  });

  // DOCUMENTED DIVERGENCE (P27-A — COORD-06 criterion-1): the optimizer-on golden
  // DIFFERS from the Phase-25 coordinator-on golden edfa5a6d… — the three structural
  // pins in `optimizerRerouteFor` have been removed so the optimizer can now choose
  // a genuinely different destination (least-congested relief spoke) and DECLINE
  // over-capacity reroutes. This is the route-aware divergence the plan requires.
  it("the optimizer-on golden DIFFERS from the Phase-25 coordinator-on golden edfa5a6d… (route-aware divergence)", () => {
    expect(OPTIMIZER_ON_GOLDEN_SHA256).not.toBe(COORDINATOR_ON_GOLDEN_SHA256);
    expect(sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS))).not.toBe(COORDINATOR_ON_GOLDEN_SHA256);
  });

  it("the optimizer-on golden DIFFERS from the flags-off 3920accc…, OODA-on 94689f99…, AND coordinator-on edfa5a6d…", () => {
    expect(OPTIMIZER_ON_GOLDEN_SHA256).not.toBe(FLAGS_OFF_GOLDEN_SHA256);
    expect(OPTIMIZER_ON_GOLDEN_SHA256).not.toBe(OODA_ON_GOLDEN_SHA256);
    expect(OPTIMIZER_ON_GOLDEN_SHA256).not.toBe(COORDINATOR_ON_GOLDEN_SHA256);
    const h = sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS));
    expect(h).not.toBe(FLAGS_OFF_GOLDEN_SHA256);
    expect(h).not.toBe(OODA_ON_GOLDEN_SHA256);
    expect(h).not.toBe(COORDINATOR_ON_GOLDEN_SHA256);
  });

  it("every emitted optimizer-on event passes the domain validateEvent boundary", () => {
    for (const item of simulate(COORDINATOR_OPTIMIZER_ON_OPTS)) {
      expect(() => validateEvent(item.event)).not.toThrow();
    }
  });

  it("the optimizer-on stream carries non-trivial reroute ActionSuggested counts (the optimizer path is REAL)", () => {
    const stream = simulate(COORDINATOR_OPTIMIZER_ON_OPTS);
    const suggested = stream.filter((e) => e.event.type === "ActionSuggested").length;
    const reroute = stream.filter(
      (e) => e.event.type === "ActionSuggested" && e.event.payload.kind === "reroute",
    ).length;
    const accepted = stream.filter((e) => e.event.type === "SuggestionAccepted").length;
    const rejected = stream.filter((e) => e.event.type === "SuggestionRejected").length;
    // The optimizer-backed reroute kind is genuinely produced (the route-aware
    // suggestions are observably present — NOT a skipped/empty path). Captured
    // post-guard counts (P27-A recapture): suggested 20115, reroute 7378,
    // accepted 20094, rejected 21 (every suggestion consumed: accepted + rejected ==
    // suggested). The reroute count is LOWER than the rule-based 9553 because the
    // optimizer now DECLINES over-capacity reroutes (real blocks from inboundDepthByHub)
    // — this is the route-aware divergence (COORD-06 criterion-1).
    expect(reroute).toBeGreaterThan(1000);
    expect(reroute).toBe(7378);
    expect(suggested).toBeGreaterThan(1000);
    expect(accepted).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(0);
    expect(accepted + rejected).toBe(suggested);
  });

  it("every reroute event names a destination hub on its coordinator channel (the cross-dock relief target)", () => {
    for (const e of simulate(COORDINATOR_OPTIMIZER_ON_OPTS)) {
      if (e.event.type !== "ActionSuggested") continue;
      if (e.event.payload.kind !== "reroute") continue;
      // Reroute is streamed on the suggesting coordinator's channel and names a hub.
      expect(e.streamId).toBe(`coordinator-${e.event.payload.coordinatorId}`);
      expect(typeof e.event.payload.params.toHubId).toBe("string");
    }
  });
});
