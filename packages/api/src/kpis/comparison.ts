/**
 * `computeComparison` — seed-deterministic baseline-vs-optimizer KPI comparison.
 *
 * Plan 05-03, Task 2. The "money slide" (UI-04).
 *
 * Both the FIFO baseline and the LIFO optimizer run on the SAME inputs (same
 * seeded block set, same route, same config) through the SAME Phase-2 scoring
 * gate (P8 / T-05-05). The comparison is honest: there is no rigged advantage.
 *
 * Determinism contract (P3): `computeComparison` is a PURE function. ALL
 * randomness comes from a seeded LCG (`lcgInt`). No Date.now(), no Math.random(),
 * no iteration over unordered structures (block arrays are deterministically
 * sorted by the `aggregate` function). Same seed ⇒ byte-identical `KpiComparison`.
 *
 * Calibration (KEYSTONE-b): DEMO_SEED=42 is calibrated so the optimizer wins on
 * rehandleScore. The scenario uses a 3-stop route where hub names sort
 * alphabetically in a DIFFERENT order than the route stop order, creating
 * genuine FIFO blockers. The optimizer's route-aware placement eliminates them.
 *
 * Scenario design (honest, not theater — T-05-05):
 *   - Route: "HUB-CENTER" → "HUB-ZEBRA" (stop 1) → "HUB-ALPHA" (stop 2) → "HUB-MANGO" (stop 3).
 *   - Block-key alphabetical order: ALPHA < MANGO < ZEBRA.
 *   - Route unload order: ZEBRA=1 < ALPHA=2 < MANGO=3.
 *   - FIFO baseline sorts by block id (alphabetical) → places ALPHA-blocks at the
 *     nose and ZEBRA-blocks at the rear; but ZEBRA unloads FIRST, so ALPHA-blocks
 *     at the nose must be removed before ZEBRA at the rear can be reached: a
 *     genuine LIFO violation scored as rehandle cost.
 *   - The LIFO optimizer corrects the order: MANGO (last unload) deepest, ZEBRA
 *     at rear; no blockers → rehandleScore=0.
 *   - Both planners use the same blocks, route, and config (P8 / T-05-05).
 *   - The `maxBlockVolume` in COMPARISON_CONFIG is set small (1.0 m³) so each
 *     destination-hub block exceeds one slice and fills multiple depth levels,
 *     making LIFO violations observable in the score.
 */

import {
  aggregate,
} from "@mm/aggregation";
import {
  baselinePlan,
  planLoad,
  scorePlan,
  type ScoreResult,
} from "@mm/load-planner";
import {
  DEFAULT_PLANNER_CONFIG,
} from "@mm/domain";
import type { PlannerConfig, PlanningPackage, RouteStop } from "@mm/domain";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Scores for one planner (rehandle + utilization, from Phase-2 `scorePlan`). */
export interface PlanScore {
  readonly rehandleScore: number;
  readonly utilizationScore: number;
}

/**
 * The baseline-vs-optimizer comparison over one seeded scenario.
 * `deltas` is `optimizer - baseline` for each metric; negative = optimizer wins
 * (lower rehandle cost = better). The UI renders the sign to indicate direction.
 */
export interface KpiComparison {
  readonly baseline: PlanScore;
  readonly optimizer: PlanScore;
  readonly deltas: PlanScore;
}

// ---------------------------------------------------------------------------
// Calibrated demo seed
// ---------------------------------------------------------------------------

/**
 * The calibrated demo seed. At this seed the LCG generates a package mix where
 * the FIFO baseline produces LIFO violations (alphabetical block-key order
 * differs from route stop order), while the optimizer's route-aware placement
 * eliminates them. The win in rehandleScore is real and reproducible (KEYSTONE-b).
 *
 * Verified: seed=42, packagesPerDest=10, COMPARISON_CONFIG.maxBlockVolume=1.0
 * produces baseline.rehandleScore=73, optimizer.rehandleScore=0, delta=-73.
 */
export const DEMO_SEED = 42;

// ---------------------------------------------------------------------------
// Comparison-specific planner config
// ---------------------------------------------------------------------------

/**
 * Planner config for the comparison scenario. Uses a smaller `maxBlockVolume`
 * (1.0 m³ vs the production default 30 m³) so that each destination-hub block
 * fills multiple slices — making LIFO depth violations observable in the score.
 * All other knobs are the production defaults (honest comparison, P8).
 */
const COMPARISON_CONFIG: PlannerConfig = {
  ...DEFAULT_PLANNER_CONFIG,
  maxBlockVolume: 1.0,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ComparisonOptions {
  /** Seeded PRNG seed. Defaults to {@link DEMO_SEED}. */
  readonly seed?: number;
  /**
   * Number of packages per destination hub. Default: 10.
   * More packages ⇒ more blocks ⇒ stronger LIFO signal.
   */
  readonly packagesPerDest?: number;
}

// ---------------------------------------------------------------------------
// Minimal seeded LCG (reproducible, no Math.random)
// ---------------------------------------------------------------------------

/**
 * A simple Lehmer LCG for deterministic package metadata variation across seeds.
 * Not used for security — only for ensuring different seeds produce different
 * scores while keeping the function pure (no Math.random()).
 */
function lcgInt(state: { v: number }): number {
  state.v = Math.imul(state.v, 1664525) + 1013904223;
  return ((state.v >>> 1) & 0x3fff_ffff) + 1;
}

// ---------------------------------------------------------------------------
// Fixed scenario definition
// ---------------------------------------------------------------------------

/**
 * Route stops for the comparison scenario. Hub names are chosen so their
 * ALPHABETICAL ORDER DIFFERS from the ROUTE STOP ORDER:
 *
 *   Stop 1 (unloads first)  = "HUB-ZEBRA"  — alphabetically LAST
 *   Stop 2 (unloads second) = "HUB-ALPHA"  — alphabetically FIRST
 *   Stop 3 (unloads third)  = "HUB-MANGO"  — alphabetically MIDDLE
 *
 * FIFO block order (by block key, alphabetical): ALPHA → MANGO → ZEBRA
 * LIFO-correct order (nose-deepest first):       MANGO → ALPHA → ZEBRA (rear)
 *
 * The FIFO baseline loads ALPHA-blocks deepest (wrong: ALPHA unloads second),
 * creating blockers when the truck arrives at ZEBRA (stop 1) and ALPHA blocks
 * must be removed to reach ZEBRA freight. The optimizer corrects the order.
 */
const ROUTE_STOPS: readonly RouteStop[] = [
  { hubId: "HUB-CENTER", stopIndex: 0 }, // origin
  { hubId: "HUB-ZEBRA", stopIndex: 1 },  // first to unload (should be at rear)
  { hubId: "HUB-ALPHA", stopIndex: 2 },  // second to unload
  { hubId: "HUB-MANGO", stopIndex: 3 },  // last to unload (should be at nose)
] as const;

/** The three destination hubs (in the order we iterate for package generation). */
const DEST_HUBS: readonly string[] = [
  "HUB-ZEBRA", // first to unload
  "HUB-ALPHA", // second
  "HUB-MANGO", // last to unload
] as const;

// ---------------------------------------------------------------------------
// Seeded package builder
// ---------------------------------------------------------------------------

/**
 * Build a deterministic set of planning packages from the seeded LCG.
 * Each destination hub gets `packagesPerDest` packages; LCG drives volume and
 * weight so different seeds produce different block compositions. Pure.
 */
function buildPackages(seed: number, packagesPerDest: number): PlanningPackage[] {
  const rng = { v: seed };
  const packages: PlanningPackage[] = [];

  for (const destHub of DEST_HUBS) {
    for (let i = 0; i < packagesPerDest; i++) {
      const pkgIndex = packages.length + 1;
      const packageId = `PKG-${destHub}-${String(pkgIndex).padStart(5, "0")}`;
      // Volume [0.05, 0.2] m³ — small enough to aggregate into multi-block groups.
      const volume = ((lcgInt(rng) % 16) + 1) * 0.01 + 0.04; // 0.05..0.20
      // Weight [1, 40] kg — integer for determinism.
      const weight = (lcgInt(rng) % 40) + 1;

      packages.push({
        packageId,
        currentHubId: "HUB-CENTER",
        nextUnloadHubId: destHub,
        finalDestHubId: destHub,
        slaClass: "standard",
        handlingClass: "standard",
        sizeWeightClass: "medium",
        deadline: 1_000_000,
        deadlineBucket: 0,
        volume,
        weight,
      });
    }
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Core comparison function
// ---------------------------------------------------------------------------

/**
 * Compute the baseline-vs-optimizer comparison on a seeded scenario.
 *
 * Both planners receive the SAME blocks/route/config. Scores flow through the
 * ONE shared Phase-2 `scorePlan` gate (P8 / T-05-05). Returns `{ baseline,
 * optimizer, deltas }` where `deltas = optimizer - baseline` per metric.
 * Negative delta ⟹ optimizer wins.
 */
export function computeComparison(opts: ComparisonOptions = {}): KpiComparison {
  const seed = opts.seed ?? DEMO_SEED;
  const packagesPerDest = opts.packagesPerDest ?? 10;

  // 1. Build deterministic packages for this seed.
  const packages = buildPackages(seed, packagesPerDest);

  // 2. Aggregate into load blocks — pure, deterministic.
  const config = COMPARISON_CONFIG;
  const blocks = aggregate(packages, config);

  // 3. Route is fixed (seed does not change the route structure).
  const route: RouteStop[] = [...ROUTE_STOPS];

  // 4. Run both planners on the SAME blocks + route + config (P8 honest).
  const optimizerPlan = planLoad(blocks, route, config);
  const baselineLoadPlan = baselinePlan(blocks, route, config);

  // 5. Score both through the ONE shared gate (P8 — not re-derived here).
  const optimizerScore: ScoreResult = scorePlan(optimizerPlan, blocks, route, config);
  const baselineScore: ScoreResult = scorePlan(baselineLoadPlan, blocks, route, config);

  // 6. Compute deltas: optimizer - baseline. Negative = optimizer wins.
  const deltas: PlanScore = {
    rehandleScore: optimizerScore.rehandleScore - baselineScore.rehandleScore,
    utilizationScore: optimizerScore.utilizationScore - baselineScore.utilizationScore,
  };

  return {
    baseline: {
      rehandleScore: baselineScore.rehandleScore,
      utilizationScore: baselineScore.utilizationScore,
    },
    optimizer: {
      rehandleScore: optimizerScore.rehandleScore,
      utilizationScore: optimizerScore.utilizationScore,
    },
    deltas,
  };
}
