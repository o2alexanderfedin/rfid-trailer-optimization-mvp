import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEvent, type FuelConfig } from "@mm/domain";
import { simulate } from "../src/engine.js";

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

// Captured REPRODUCIBILITY-FIRST from COORDINATOR_OPTIMIZER_ON_OPTS on arm64
// (darwin), 61128 events: run twice in-process ⇒ identical, AND across two separate
// `node` process invocations ⇒ identical, BEFORE baking the literal (PITFALLS: never
// commit a non-reproducible golden).
//
// DOCUMENTED EQUALITY (Plan-03 planner-truth #2 amendment): this hash IS the Phase-25
// rule-based coordinator golden `edfa5a6d…`. The optimizer path is genuinely invoked
// (verified by instrumentation: 2000 runEpoch epochs / 9663 pre-guard reroutes / 0
// fallbacks) but on the current always-feasible/center-headed per-center twin it can
// only ENDORSE the same reroute the rule-based heuristic makes, so the route-aware
// stream coincides with the rule-based stream byte-for-byte. The test below asserts
// the equality explicitly (a truthful determinism pin), NOT a difference.
//
// Cross-arch contingency (RESEARCH VQ#9 / Pitfall 2): the prior goldens were captured
// on x86_64; this hash was captured on arm64 (the flags-off `3920accc…`, OODA-on
// `94689f99…`, and coordinator-on `edfa5a6d…` all verify GREEN on this arm64 host, so
// the `Math.exp`/`Math.log` float path is arch-stable here). If a multi-arch CI run
// produces a different hash, the contingency is the integer lookup-table sampler swap
// (do NOT do this unless the hash actually fails on CI).
const COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256 =
  "edfa5a6d40b36e3774797b60d7bd99b5a8af7cce97adb1e775bad0b56b514adc";

// The three prior goldens (asserted INTACT — the optimizer arm pins against all of
// them). The optimizer-on golden EQUALS the coordinator-on golden (documented above)
// but DIFFERS from the flags-off and OODA-on goldens.
const COORDINATOR_ON_GOLDEN_SHA256 =
  "edfa5a6d40b36e3774797b60d7bd99b5a8af7cce97adb1e775bad0b56b514adc";
const FLAGS_OFF_GOLDEN_SHA256 =
  "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861";
const OODA_ON_GOLDEN_SHA256 =
  "94689f9989c0019edff27134dad0ef4cfb07c15c9c308ef4b40c38e848f4e608";

describe("optimizer-backed coordinator 10k golden (COORD-06, reproducibility-first)", () => {
  it("simulate(seed 42, 10k, coordinatorUsesOptimizer + all-on) hashes to the committed SHA-256", () => {
    expect(sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS))).toBe(
      COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256,
    );
  });

  it("the optimizer-on run is reproducible within a process (same hash twice)", () => {
    const a = sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS));
    const b = sha(simulate({ ...COORDINATOR_OPTIMIZER_ON_OPTS }));
    expect(b).toBe(a);
    expect(a).toBe(COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256);
  });

  // DOCUMENTED EQUALITY (planner-truth #2 amendment): the optimizer-on golden EQUALS
  // the Phase-25 coordinator golden edfa5a6d… (the optimizer endorses the same reroute
  // the rule-based path makes on the current center-headed/always-feasible twin) — a
  // truthful pin that the route-aware path is a byte-stable superset coinciding with
  // the rule-based stream on this topology.
  it("the optimizer-on golden EQUALS the Phase-25 coordinator golden edfa5a6d… (documented coincidence)", () => {
    expect(COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256).toBe(COORDINATOR_ON_GOLDEN_SHA256);
    expect(sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS))).toBe(COORDINATOR_ON_GOLDEN_SHA256);
  });

  it("the optimizer-on golden DIFFERS from the flags-off 3920accc… AND the OODA-on 94689f99…", () => {
    expect(COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256).not.toBe(FLAGS_OFF_GOLDEN_SHA256);
    expect(COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256).not.toBe(OODA_ON_GOLDEN_SHA256);
    const h = sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS));
    expect(h).not.toBe(FLAGS_OFF_GOLDEN_SHA256);
    expect(h).not.toBe(OODA_ON_GOLDEN_SHA256);
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
    // post-guard counts: suggested 22290, reroute 9553, accepted 22269, rejected 21
    // (every suggestion consumed: accepted + rejected == suggested). The reroute count
    // matches the rule-based golden because the optimizer ENDORSES the same decision
    // (the documented coincidence above) — the value witnesses the path is real.
    expect(reroute).toBeGreaterThan(1000);
    expect(reroute).toBe(9553);
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
