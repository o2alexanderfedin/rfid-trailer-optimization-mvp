import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEvent, type FuelConfig } from "@mm/domain";
import {
  FUEL_RNG_SALT,
  HOS_RNG_SALT,
  INDUCTION_RNG_SALT,
  OUTBOUND_RNG_SALT,
  OVER_CARRY_RNG_SALT,
  RFID_RNG_SALT,
  TIMING_RNG_SALT,
  simulate,
} from "../src/engine.js";
import { OODA_RNG_SALT } from "../src/ooda/index.js";
import { COORDINATOR_RNG_SALT } from "../src/coordinator/index.js";
import {
  FLAGS_OFF_GOLDEN_SHA256,
  OODA_ON_GOLDEN_SHA256,
  COORDINATOR_ON_GOLDEN_SHA256,
} from "./goldens.js";

/**
 * Phase-25 COORD-04 + DET-03 — THE COORDINATOR DETERMINISM GOLDENS (the milestone
 * keystone gate). Three first-class witnesses, mirroring ooda-determinism.unit.test.ts:
 *
 *   1. SALT-COLLISION: COORDINATOR_RNG_SALT is pairwise-distinct from the 8 prior
 *      salts (7 engine + OODA) — Set size 9 — so the per-center coordinator substream
 *      never aliases another substream's draws (Pitfall 3).
 *   2. COORDINATOR-ON GOLDEN: simulate({ seed 42, 10k, coordinatorsEnabled + the
 *      natural all-on demo stack }) hashes to a NEW committed SHA-256, captured
 *      reproducibility-first (run twice in-process ⇒ equal, AND across two separate
 *      test-process invocations ⇒ equal, BEFORE baking the literal) and != the
 *      flags-off golden 3920accc… (the coordinator model changed the decisions).
 *   3. The coordinator-on stream carries NON-TRIVIAL counts of all three suggestion
 *      event types (ActionSuggested + SuggestionAccepted + SuggestionRejected) and
 *      every emitted event passes the domain validateEvent boundary — the model
 *      genuinely exercises the advise/accept/reject handshake under the guards.
 */

const sha = (s: ReturnType<typeof simulate>): string =>
  createHash("sha256").update(JSON.stringify(s)).digest("hex");

// ===========================================================================
// 1. SALT-COLLISION — COORDINATOR_RNG_SALT pairwise-distinct (Set size 9)
// ===========================================================================
describe("COORDINATOR_RNG_SALT salt-collision golden (COORD-04)", () => {
  it("COORDINATOR_RNG_SALT is pairwise-distinct from the eight prior salts (Set size 9)", () => {
    const salts = [
      RFID_RNG_SALT,
      OVER_CARRY_RNG_SALT,
      TIMING_RNG_SALT,
      HOS_RNG_SALT,
      FUEL_RNG_SALT,
      INDUCTION_RNG_SALT,
      OUTBOUND_RNG_SALT,
      OODA_RNG_SALT,
      COORDINATOR_RNG_SALT,
    ].map((s) => s >>> 0);
    // Seven engine substream salts + OODA_RNG_SALT + COORDINATOR_RNG_SALT = nine
    // pairwise-distinct values — the ninth substream salt is collision-free.
    expect(new Set(salts).size).toBe(salts.length);
    expect(salts.length).toBe(9);
  });
});

// ===========================================================================
// 2+3. COORDINATOR-ON GOLDEN — captured reproducibility-first, committed, != 3920accc…
// ===========================================================================

const FUEL_ON: FuelConfig = {
  enabled: true,
  refuelThresholdMiles: 1200,
  milesPerGallon: 6.5,
  tankCapacityGallons: 150,
  refuelTimeMinutes: 30,
};

/**
 * The coordinator-on golden configuration: seed 42 / 10k ticks (mirroring the
 * flags-off DET-02 and OODA-on goldens' seed+duration) with `coordinatorsEnabled`
 * layered onto the EXACT OODA-on golden flag set (hos + fuel + induction +
 * consolidation + oodaAgentsEnabled). One coordinator per center (the single legacy
 * center when `continentalTopology` is off, per 25-02 — a coordinator ALWAYS exists)
 * advises real OODA agents (trucks + hubs).
 *
 * CONFIG CHOICE (documented next to the literal): the LEGACY single-center star is
 * used, NOT `continentalTopology`. The continental multi-center topology spreads
 * freight thin across the backbone (25-02 finding) and produces ZERO rejects — it
 * does not exercise the advise/accept/REJECT handshake. The legacy all-on stack
 * genuinely fires all three suggestion event types (the must-have: non-trivial
 * ActionSuggested + SuggestionAccepted + SuggestionRejected), so it is the config
 * the coordinator model actually exercises. The guards' damped output is baked in.
 */
const COORDINATOR_ON_OPTS = {
  seed: 42,
  durationTicks: 10000,
  coordinatorsEnabled: true,
  oodaAgentsEnabled: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

// See goldens.ts for COORDINATOR_ON_GOLDEN_SHA256, FLAGS_OFF_GOLDEN_SHA256, and
// OODA_ON_GOLDEN_SHA256 — captured reproducibility-first, 61128 events (COORDINATOR_ON)
// on arm64 darwin. Cross-arch provenance and LUT contingency are documented there.

describe("coordinator-on 10k golden (COORD-04, reproducibility-first)", () => {
  it("simulate(seed 42, 10k, coordinatorsEnabled + all-on) hashes to the committed SHA-256", () => {
    expect(sha(simulate(COORDINATOR_ON_OPTS))).toBe(COORDINATOR_ON_GOLDEN_SHA256);
  });

  it("the coordinator-on run is reproducible within a process (same hash twice)", () => {
    const a = sha(simulate(COORDINATOR_ON_OPTS));
    const b = sha(simulate({ ...COORDINATOR_ON_OPTS }));
    expect(b).toBe(a);
    expect(a).toBe(COORDINATOR_ON_GOLDEN_SHA256);
  });

  it("the coordinator-on golden DIFFERS from the flags-off 3920accc… AND the OODA-on 94689f99…", () => {
    expect(COORDINATOR_ON_GOLDEN_SHA256).not.toBe(FLAGS_OFF_GOLDEN_SHA256);
    expect(COORDINATOR_ON_GOLDEN_SHA256).not.toBe(OODA_ON_GOLDEN_SHA256);
    const h = sha(simulate(COORDINATOR_ON_OPTS));
    expect(h).not.toBe(FLAGS_OFF_GOLDEN_SHA256);
    expect(h).not.toBe(OODA_ON_GOLDEN_SHA256);
  });

  it("every emitted coordinator-on event passes the domain validateEvent boundary", () => {
    for (const item of simulate(COORDINATOR_ON_OPTS)) {
      expect(() => validateEvent(item.event)).not.toThrow();
    }
  });

  it("the coordinator-on stream carries non-trivial ActionSuggested + Accepted + Rejected counts", () => {
    const stream = simulate(COORDINATOR_ON_OPTS);
    const suggested = stream.filter((e) => e.event.type === "ActionSuggested").length;
    const accepted = stream.filter((e) => e.event.type === "SuggestionAccepted").length;
    const rejected = stream.filter((e) => e.event.type === "SuggestionRejected").length;
    // The model genuinely exercises the advise/accept/reject handshake (all three
    // present, non-trivial). Captured counts: suggested 22290, accepted 22269,
    // rejected 21 — every suggestion is consumed (accepted + rejected == suggested).
    expect(suggested).toBeGreaterThan(1000);
    expect(accepted).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(0);
    expect(accepted + rejected).toBe(suggested);
  });
});
