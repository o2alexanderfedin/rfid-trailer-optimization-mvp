import type {
  HandlingClass,
  LoadBlock,
  PlannerConfig,
  PlanningPackage,
} from "@mm/domain";
import { buildLoadBlock } from "./block.js";

/**
 * AGG-03 / splitBlock.
 *
 * A block is INFEASIBLE if either:
 *  1. its aggregate volume exceeds `config.maxBlockVolume` (over a trailer-zone
 *     capacity), or
 *  2. it mixes incompatible handling — a `fragile` package must not share a
 *     block with a `heavy` one (the fragile-⊄-heavy rule; heavy belongs on the
 *     floor, fragile must not be crushed).
 *
 * `splitBlock` partitions an infeasible block into FEASIBLE sub-blocks,
 * deterministically and stably, preserving the key and recomputing aggregates.
 * A block already feasible returns `[block]` unchanged, and re-running split on
 * its own output is idempotent (each sub-block is feasible ⇒ returns itself).
 *
 * Pure: no wall clock, no RNG; order is fixed by sorted packageId.
 *
 * @param block the block to check/split.
 * @param packages the block's member packages (the per-package data split needs
 *   to recompute aggregates and inspect handling classes).
 * @param config split thresholds (`maxBlockVolume`).
 */
export function splitBlock(
  block: LoadBlock,
  packages: readonly PlanningPackage[],
  config: PlannerConfig,
): LoadBlock[] {
  // Restrict to this block's members and sort by packageId for stable output.
  const ids = new Set(block.packageIds);
  const members = packages
    .filter((p) => ids.has(p.packageId))
    .sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0));

  // 1) Handling-incompatibility split (only when fragile AND heavy coexist).
  const handlingGroups = partitionByHandlingIncompatibility(members);
  if (handlingGroups.length > 1) {
    return handlingGroups.flatMap((g, i) =>
      splitBlock(buildLoadBlock(block.key, g, `#h${String(i)}`), g, config),
    );
  }

  // 2) Volume split.
  if (block.totalVolume > config.maxBlockVolume) {
    const bins = greedyVolumeBins(members, config.maxBlockVolume);
    return bins.map((g, i) => buildLoadBlock(block.key, g, `#v${String(i)}`));
  }

  // Already feasible.
  return [block];
}

/**
 * Split members into handling-compatible groups ONLY when both `fragile` and
 * `heavy` are present. The minimal deterministic rule that guarantees no
 * sub-block mixes fragile with heavy: group strictly by handling class (each
 * class its own group, in a fixed class order). When the pair is absent the
 * members stay together (single group) — so feasible blocks never split.
 */
function partitionByHandlingIncompatibility(
  members: readonly PlanningPackage[],
): PlanningPackage[][] {
  const classes = new Set(members.map((p) => p.handlingClass));
  if (!(classes.has("fragile") && classes.has("heavy"))) {
    return [members.slice()];
  }
  // Fixed class order keeps the partition deterministic and stable.
  const order: HandlingClass[] = ["standard", "fragile", "heavy"];
  return order
    .map((c) => members.filter((p) => p.handlingClass === c))
    .filter((g) => g.length > 0);
}

/**
 * Greedy first-fit-decreasing-free bin packing keyed on the already-sorted
 * (by packageId) member order: walk members in order, appending to the current
 * bin until adding the next would exceed `maxBlockVolume`, then open a new bin.
 * Deterministic and stable; each bin's volume ≤ maxBlockVolume provided every
 * single package fits (domain guarantees `volume > 0`, and a single package
 * over the cap becomes its own bin — see note).
 */
function greedyVolumeBins(
  members: readonly PlanningPackage[],
  maxBlockVolume: number,
): PlanningPackage[][] {
  const bins: PlanningPackage[][] = [];
  let current: PlanningPackage[] = [];
  let currentVolume = 0;
  for (const p of members) {
    if (current.length > 0 && currentVolume + p.volume > maxBlockVolume) {
      bins.push(current);
      current = [];
      currentVolume = 0;
    }
    current.push(p);
    currentVolume += p.volume;
  }
  if (current.length > 0) bins.push(current);
  return bins;
}
