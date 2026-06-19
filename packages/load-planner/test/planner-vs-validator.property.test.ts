import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNER_CONFIG,
  type BlockKey,
  type LoadBlock,
  type PlannerConfig,
  type RouteStop,
} from "@mm/domain";
import { canonicalInvariantHolds, countBlockers } from "../src/lifo-invariant.js";
import { planLoad } from "../src/plan-load.js";
import { isFeasible, validatePlan } from "../src/validator.js";

/**
 * KEYSTONE property test (T-02-13) — planner ↔ validator agreement under fuzz.
 *
 * Over a fixed set of ENUMERATED seeds (a seeded LCG — NO live RNG, no wall-clock
 * seed, so failures reproduce exactly), generate random `(blocks, route,
 * capacities)` and assert, for EVERY generated input:
 *
 *  1. the planner's output satisfies THE canonical invariant
 *     (`canonicalInvariantHolds(planLoad(...).placements)`),
 *  2. the INDEPENDENT validator agrees with the planner on feasibility — it
 *     reports ZERO HARD violations for the planner's own output (the planner and
 *     validator never disagree: no plan the planner emits is judged HARD-infeasible),
 *  3. the validator agrees on the invariant too — a plan that the canonical
 *     invariant accepts has zero blockers, hence zero violations of either severity.
 *
 * This is the anti-P1 cross-check: an independent code path confirms the planner
 * did not silently invert LIFO, on hundreds of randomized cases.
 */

/**
 * A deterministic 32-bit LCG (Numerical Recipes constants). Pure, replay-safe —
 * no `Math.random()`, no clock. Seeded per case from an enumerated seed list.
 */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // state = (1664525 * state + 1013904223) mod 2^32
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000; // in [0, 1)
  };
}

/** A small integer in [min, max] from the LCG. */
function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function keyFor(nextUnloadHubId: string): BlockKey {
  return {
    currentHubId: "H0",
    nextUnloadHubId,
    finalDestHubId: "HZ",
    slaClass: "standard",
    deadlineBucket: 0,
    handlingClass: "standard",
    sizeWeightClass: "small",
  };
}

interface GeneratedCase {
  readonly blocks: LoadBlock[];
  readonly route: RouteStop[];
  readonly config: PlannerConfig;
}

/**
 * Generate a random feasible-shape case from a seed: a 2..6-hub route, and
 * 1..12 blocks each assigned to a random hub on the route with random
 * volume/weight, plus a randomized (but valid) slice-capacity config.
 */
function generateCase(seed: number): GeneratedCase {
  const rng = makeLcg(seed);

  const hubCount = intBetween(rng, 2, 6);
  const route: RouteStop[] = [];
  for (let i = 0; i < hubCount; i += 1) {
    route.push({ hubId: `H${i + 1}`, stopIndex: i });
  }

  const blockCount = intBetween(rng, 1, 12);
  const blocks: LoadBlock[] = [];
  for (let i = 0; i < blockCount; i += 1) {
    const hub = `H${intBetween(rng, 1, hubCount)}`;
    // volume up to ~half a slice so single-slice fits are common but multi-block
    // slices and capacity rollovers both occur across the seed space.
    const volume = intBetween(rng, 1, 15);
    const weight = intBetween(rng, 1, 50);
    blocks.push({
      loadBlockId: `LB-${seed}-${i}`,
      key: keyFor(hub),
      packageIds: [`LB-${seed}-${i}-p0`],
      packageCount: 1,
      totalVolume: volume,
      totalWeight: weight,
      priority: 0,
    });
  }

  // randomize the binding slice capacity but keep it ≥ the largest block so every
  // block always fits in some slice (a valid trailer; never an impossible plan).
  const maxBlockVolume = Math.max(
    15,
    intBetween(rng, 15, 30),
    ...blocks.map((b) => b.totalVolume),
  );
  const config: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, maxBlockVolume };

  return { blocks, route, config };
}

/** Enumerated, fixed seeds — reproducible (no live RNG / clock seeding). */
const SEEDS: number[] = Array.from({ length: 200 }, (_, i) => i * 2654435761 + 1);

describe("KEYSTONE property — planLoad satisfies the invariant AND the validator agrees", () => {
  it("holds the canonical invariant + planner/validator feasibility agreement across all seeds", () => {
    for (const seed of SEEDS) {
      const { blocks, route, config } = generateCase(seed);
      const plan = planLoad(blocks, route, config);

      // (1) planner output satisfies the canonical invariant.
      expect(
        canonicalInvariantHolds(plan.placements),
        `seed ${seed}: planLoad output violated the canonical invariant`,
      ).toBe(true);

      // (2) independent validator agrees: zero HARD violations on the planner's
      //     own output — planner and validator never disagree on feasibility.
      const result = validatePlan(plan, blocks, route, config);
      expect(
        result.hardViolations,
        `seed ${seed}: validator judged the planner's own plan HARD-infeasible`,
      ).toHaveLength(0);
      expect(isFeasible(result)).toBe(true);

      // (3) a canonical-invariant-satisfying plan has zero blockers ⇒ zero SOFT
      //     violations too (the two paths fully agree).
      const totalBlockers = plan.placements.reduce(
        (n, p) => n + countBlockers(p, plan.placements),
        0,
      );
      expect(
        totalBlockers,
        `seed ${seed}: invariant-satisfying plan still had blockers`,
      ).toBe(0);
      expect(result.softViolations).toHaveLength(0);
    }
  });

  it("is reproducible: the same seed yields the identical plan + verdict", () => {
    const seed = SEEDS[7]!;
    const a = generateCase(seed);
    const b = generateCase(seed);
    expect(b).toEqual(a);
    const planA = planLoad(a.blocks, a.route, a.config);
    const planB = planLoad(b.blocks, b.route, b.config);
    expect(planB).toEqual(planA);
    expect(validatePlan(planB, b.blocks, b.route, b.config)).toEqual(
      validatePlan(planA, a.blocks, a.route, a.config),
    );
  });
});
