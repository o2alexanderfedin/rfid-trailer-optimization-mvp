import type { LoadBlock, PlannerConfig, RouteStop } from "@mm/domain";
import { isBlocker } from "./lifo-invariant.js";
import type { LoadPlan, Placement, ScoreResult } from "./types.js";
import { buildUnloadOrderMap } from "./unload-order.js";
import { placementsFromSlices } from "./validator.js";

/**
 * Soft scoring — rehandle cost (LOAD-06) + utilization penalty (LOAD-07).
 *
 * Scoring is the layer that runs ONLY after the hard feasibility gate (the
 * validator) has passed. It is returned as a {@link ScoreResult}
 * (`{ rehandleScore, utilizationScore }`) that is structurally SEPARATE from
 * `FeasibilityResult` (P2 / threat T-02-14): a low score carries no violation
 * fields and so can never silently buy out the hard gate. The API (Plan 06)
 * gates on `isFeasible` BEFORE it reads any score.
 *
 * Anti-P1 (no second blocker predicate, threat T-02-16): the rehandle blocker
 * counts/volumes are recomputed from the SAME slice-derived placements the
 * validator uses ({@link placementsFromSlices}) and the SAME canonical
 * {@link isBlocker} predicate — there is no divergent re-implementation to drift.
 *
 * Pure + deterministic: imports only `@mm/domain` (types) + local pure modules;
 * no clock (`Date.now()`), no RNG (`Math.random()`). Same input ⇒ same score.
 */

/**
 * The per-block rehandle breakdown — the scoring internals the rationale module
 * (LOAD-10) renders into plain English. Computed once, reused by both the score
 * total and the explanation so the two never diverge.
 */
export interface BlockRehandle {
  /** The blocked block. */
  readonly loadBlockId: string;
  /** Ids of the blocks physically in front of it that must be moved (canonical). */
  readonly blockerIds: readonly string[];
  /** How many blockers (= `blockerIds.length`). */
  readonly blockerCount: number;
  /** Σ volume of those blockers (the freight unloaded+reloaded). */
  readonly blockersVolume: number;
  /** Whether the blocked block itself is fragile (drives `fragilePenalty`). */
  readonly fragile: boolean;
  /** This block's contribution to the plan rehandle total (0 when unblocked). */
  readonly cost: number;
}

/** Index blocks by id for O(1) volume/handling lookups during scoring. */
function indexBlocks(blocks: readonly LoadBlock[]): Map<string, LoadBlock> {
  return new Map(blocks.map((b) => [b.loadBlockId, b]));
}

/**
 * The per-block rehandle breakdown for every blocked block in the plan.
 *
 * For each placed target we collect its blockers via the canonical predicate
 * (the freight in front of it that unloads later), then apply the LOCKED §7.5
 * formula. The flat fragile/dock-delay/SLA penalties apply ONLY to a block that
 * is actually blocked (`blockerCount > 0`) — an accessible block incurs no
 * rehandle and so contributes 0. Unblocked blocks are omitted from the result.
 */
export function rehandleBreakdown(
  plan: LoadPlan,
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
  config: PlannerConfig,
): BlockRehandle[] {
  const orderMap = buildUnloadOrderMap(route);
  const placements = placementsFromSlices(plan, blocks, orderMap);
  const byId = indexBlocks(blocks);

  const {
    unloadReloadMin,
    volCost,
    fragilePenalty,
    dockDelayPenalty,
    slaImpactPenalty,
  } = config;

  const breakdown: BlockRehandle[] = [];
  for (const target of placements) {
    // Canonical blocker set (single-source predicate, anti-P1): later-unload
    // freight physically in front of the target.
    const blockers: Placement[] = placements.filter((other) =>
      isBlocker(target, other),
    );
    if (blockers.length === 0) continue; // accessible — no rehandle, contributes 0

    const blockersVolume = blockers.reduce(
      (sum, b) => sum + (byId.get(b.loadBlockId)?.totalVolume ?? 0),
      0,
    );
    const fragile = byId.get(target.loadBlockId)?.key.handlingClass === "fragile";

    const cost =
      blockers.length * unloadReloadMin +
      blockersVolume * volCost +
      (fragile ? fragilePenalty : 0) +
      dockDelayPenalty +
      slaImpactPenalty;

    breakdown.push({
      loadBlockId: target.loadBlockId,
      blockerIds: blockers
        .map((b) => b.loadBlockId)
        .sort((a, b) => (a < b ? -1 : 1)),
      blockerCount: blockers.length,
      blockersVolume,
      fragile,
      cost,
    });
  }
  // Deterministic order (id-stable) for replayable explanations.
  return breakdown.sort((a, b) => (a.loadBlockId < b.loadBlockId ? -1 : 1));
}

/**
 * Rehandle cost (LOAD-06): the plan total `Σ blocks` of the §7.5 per-block
 * formula `blockersCount·unloadReloadMin + blockersVolume·volCost +
 * fragilePenalty + dockDelayPenalty + slaImpactPenalty`. Blocker counts/volumes
 * come from the canonical recompute (anti-P1). An accessible plan scores 0.
 */
export function rehandleScore(
  plan: LoadPlan,
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
  config: PlannerConfig,
): number {
  return rehandleBreakdown(plan, blocks, route, config).reduce(
    (sum, b) => sum + b.cost,
    0,
  );
}

/**
 * Total used vs total capacity volume across all slices ⇒ the utilization
 * fraction `u`. A trailer with zero capacity has undefined utilization, treated
 * as 0 (it can hold nothing, so it is maximally under-utilized).
 */
function utilizationFraction(plan: LoadPlan): number {
  let used = 0;
  let capacity = 0;
  for (const s of plan.slices) {
    used += s.usedVolume;
    capacity += s.capacityVolume;
  }
  return capacity > 0 ? used / capacity : 0;
}

/**
 * Utilization penalty (LOAD-07, spec §12.1): a soft band `[utilLow, utilHigh]`
 * (75–90%) with a QUADRATIC penalty on BOTH sides —
 * `lowUtilPenalty = max(0, utilLow − u)²·wLow`,
 * `highUtilPenalty = max(0, u − utilHigh)²·wHigh` — and exactly 0 inside the
 * band. The total is `lowUtilPenalty + highUtilPenalty`; at most one side is
 * non-zero for any single `u`.
 */
export function utilizationScore(plan: LoadPlan, config: PlannerConfig): number {
  const u = utilizationFraction(plan);
  const { utilLow, utilHigh, wLow, wHigh } = config;

  const below = Math.max(0, utilLow - u);
  const above = Math.max(0, u - utilHigh);
  const lowUtilPenalty = below * below * wLow;
  const highUtilPenalty = above * above * wHigh;
  return lowUtilPenalty + highUtilPenalty;
}

/**
 * Score a plan: the SOFT layer returned ONLY as a {@link ScoreResult}
 * (`{ rehandleScore, utilizationScore }`). It NEVER merges feasibility fields —
 * `FeasibilityResult` is a separate object from a separate call (P2). This is
 * the ONE scoring path both `planLoad` and `baselinePlan` flow through (shared
 * plumbing, P8), so the before/after comparison is apples-to-apples.
 */
export function scorePlan(
  plan: LoadPlan,
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
  config: PlannerConfig,
): ScoreResult {
  return {
    rehandleScore: rehandleScore(plan, blocks, route, config),
    utilizationScore: utilizationScore(plan, config),
  };
}
