import type { LoadBlock, PlannerConfig, RouteStop } from "@mm/domain";
import { type FeasibilityResult, isFeasible, validatePlan } from "@mm/load-planner";

import { objective } from "../objective/objective.js";
import type { ObjectiveWeights, PlanMetrics } from "../objective/types.js";

/**
 * `@mm/optimizer` — `localRepair`: ordered split / reassign / hold / over-carry
 * recovery recommendations for an infeasible/high-cost plan (OPT-07, spec §11.7
 * / §17.4).
 *
 * Given a (possibly infeasible) trailer load, repair GENERATES candidate
 * variants — split a block, reassign a block to another trailer/leg, hold a block
 * at its hub, over-carry a block past its hub — VALIDATES each through the REUSED
 * Phase-2 `validatePlan` HARD gate (LIFO accessibility is NEVER re-implemented
 * here — DRY), SCORES the feasible ones with the §12 `objective`, attaches a
 * §17.4 human-readable rationale, and returns them RANKED best-feasible-first.
 *
 * Feasibility stays a SEPARATE output (anti-P2): the gate decides which variants
 * survive BEFORE the objective ranks them; a low objective never resurrects an
 * infeasible variant. Every surviving {@link Recommendation} carries an
 * explainable rationale (anti-repudiation, threat T-04-11).
 *
 * Pure + deterministic: no clock (`Date.now()`), no RNG (`Math.random()`). Same
 * input ⇒ same ranked recommendations. Ties broken by `(objective, kind,
 * blockId)` lexicographically so the ranking never thrashes (anti-P7).
 */

/**
 * The §17.4 recovery actions repair can recommend. The first four address LIFO /
 * load-layout conflicts; `insertRest` and `relay` (OPT-HOS-03) address an
 * HOS-infeasible leg — the load is fine but the assigned DRIVER cannot legally
 * drive the leg.
 */
export type RepairKind =
  | "split"
  | "reassign"
  | "hold"
  | "overCarry"
  | "insertRest"
  | "relay";

/**
 * OPT-HOS-03 — the HOS-infeasible leg the OPT-HOS-02 hard gate rejected. When
 * present on a {@link RepairScope}, `localRepair` surfaces an `insertRest`
 * (mandatory 10h rest before the leg) and a `relay` (fresh-driver swap at the
 * hub) recommendation, each explainable (driver + leg + why). All fields are pure
 * data read off the gate verdict — no clock, no RNG.
 */
export interface HosInfeasibleLeg {
  /** The assigned driver who cannot legally complete the leg. */
  readonly driverId: string;
  /** Origin hub of the rejected driving leg. */
  readonly legFromHubId: string;
  /** Destination hub of the rejected driving leg. */
  readonly legToHubId: string;
  /** Whole driving minutes the leg requires. */
  readonly legMinutes: number;
  /** The driver's remaining legal drive minutes (HOS-03) — why the leg is illegal. */
  readonly remainingDriveMinutes: number;
}

/** One rear-to-nose load slice (the validator's independent input view). */
export interface RepairSlice {
  readonly depth: number;
  readonly loadBlockIds: readonly string[];
}

/**
 * The input to {@link localRepair}: the plan to repair (its slices + the blocks
 * and route the REUSED validator reads), the planner config (the HARD gate
 * knobs), the §12 objective weights, and the base plan's pure metrics (the
 * non-LIFO §12 terms held constant across variants except the one each repair
 * changes).
 */
export interface RepairScope {
  /** Stable id of the plan being repaired (provenance for rationale + churn). */
  readonly planId: string;
  /** The (possibly broken) rear-to-nose layout. */
  readonly slices: readonly RepairSlice[];
  /** Blocks referenced by the slices (id → next-unload hub, volume). */
  readonly blocks: readonly LoadBlock[];
  /** The trailer's remaining route (drives the validator's unload order). */
  readonly route: readonly RouteStop[];
  /** Planner knobs — `maxAllowedBlockers` is the HARD gate. */
  readonly config: PlannerConfig;
  /** §12 objective weights for ranking feasible variants. */
  readonly weights: ObjectiveWeights;
  /** Pure metrics of the base plan (each variant adjusts only the term it changes). */
  readonly baseMetrics: PlanMetrics;
  /**
   * OPT-HOS-03 — OPTIONAL: the HOS-infeasible leg the OPT-HOS-02 gate rejected.
   * When present, repair ALSO emits `insertRest` + `relay` recommendations for
   * the over-hours driver (in addition to any LIFO repairs). Absent ⇒ no HOS
   * recommendations (pre-Phase-16 back-compat).
   */
  readonly hosInfeasible?: HosInfeasibleLeg;
}

/**
 * One ranked recovery recommendation: the repair {@link RepairKind}, a
 * human-readable `rationale` (§17.4), the `resultingMetrics` the objective ranks
 * it by, and — kept SEPARATE (anti-P2) — the `feasibility` verdict of the
 * REUSED validator on the repaired layout (always feasible for a returned rec).
 */
export interface Recommendation {
  readonly kind: RepairKind;
  readonly rationale: string;
  readonly resultingMetrics: PlanMetrics;
  readonly feasibility: FeasibilityResult;
}

/** A generated repair variant before the feasibility gate + ranking. */
interface Variant {
  readonly kind: RepairKind;
  readonly blockId: string;
  readonly slices: readonly RepairSlice[];
  readonly blocks: readonly LoadBlock[];
  readonly metrics: PlanMetrics;
  readonly rationale: string;
}

/** Drop a block id from every slice (used by reassign / hold / over-carry). */
function removeBlock(
  slices: readonly RepairSlice[],
  blockId: string,
): RepairSlice[] {
  return slices
    .map((s) => ({
      depth: s.depth,
      loadBlockIds: s.loadBlockIds.filter((id) => id !== blockId),
    }))
    .filter((s) => s.loadBlockIds.length > 0);
}

/**
 * Re-stack the layout in canonical LIFO order: blocks destined for earlier route
 * stops go to lower depths (nearer the rear door). This is the "reorder / split
 * then re-stack" repair — it keeps the block ON the trailer but fixes its depth.
 * Unknown hubs sort last (deepest), matching the validator's fallback.
 */
function restack(
  slices: readonly RepairSlice[],
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
): RepairSlice[] {
  const orderByHub = new Map(route.map((r) => [r.hubId, r.stopIndex]));
  const latest = route.length;
  const hubByBlock = new Map(blocks.map((b) => [b.loadBlockId, b.key.nextUnloadHubId]));

  const ids = slices.flatMap((s) => s.loadBlockIds);
  const ranked = [...ids].sort((a, b) => {
    const oa = orderByHub.get(hubByBlock.get(a) ?? "") ?? latest;
    const ob = orderByHub.get(hubByBlock.get(b) ?? "") ?? latest;
    if (oa !== ob) return oa - ob;
    return a < b ? -1 : a > b ? 1 : 0; // deterministic id tie-break
  });
  // One block per depth, rear (0) → nose, earliest-unload at the rear.
  return ranked.map((loadBlockId, depth) => ({ depth, loadBlockIds: [loadBlockId] }));
}

/** Total volume of a block id (0 if unknown). */
function volumeOf(blocks: readonly LoadBlock[], blockId: string): number {
  return blocks.find((b) => b.loadBlockId === blockId)?.totalVolume ?? 0;
}

/**
 * Generate the candidate repair variants for one offending block. Each variant
 * adjusts ONLY the §12 term its action changes (anti-P2: feasibility is decided
 * later by the gate, never by these cost deltas):
 *
 *  - `reassign` — move the block to another trailer (off this load). Adds an
 *    imbalance cost (work pushed to another trailer) + a churn cost (plan
 *    diverges from the previous).
 *  - `hold` — keep the block at its current hub for a later epoch. Adds an SLA
 *    lateness cost (the block waits) + churn.
 *  - `overCarry` — carry the block past its unload hub. Adds an over-carry cost
 *    (extra units carried) + churn.
 *  - `split` — split + re-stack the layout so the depths obey LIFO. Adds a
 *    handling cost (the extra touch) + a small churn.
 */
function variantsForBlock(scope: RepairScope, blockId: string): Variant[] {
  const { slices, blocks, route, baseMetrics } = scope;
  const vol = volumeOf(blocks, blockId);

  const withoutBlock = removeBlock(slices, blockId);
  const blocksWithoutBlock = blocks.filter((b) => b.loadBlockId !== blockId);

  return [
    {
      kind: "reassign",
      blockId,
      slices: withoutBlock,
      blocks: blocksWithoutBlock,
      metrics: {
        ...baseMetrics,
        imbalance: baseMetrics.imbalance + 1,
        churnVsPrevious: baseMetrics.churnVsPrevious + 1,
      },
      rationale: `Reassign block ${blockId} to another trailer/leg so it no longer blocks earlier-unload freight on plan ${scope.planId}.`,
    },
    {
      kind: "hold",
      blockId,
      slices: withoutBlock,
      blocks: blocksWithoutBlock,
      metrics: {
        ...baseMetrics,
        slaLatenessMin: baseMetrics.slaLatenessMin + 1,
        churnVsPrevious: baseMetrics.churnVsPrevious + 1,
      },
      rationale: `Hold block ${blockId} at its current hub for a later epoch, clearing the accessibility conflict on plan ${scope.planId}.`,
    },
    {
      kind: "overCarry",
      blockId,
      slices: withoutBlock,
      blocks: blocksWithoutBlock,
      metrics: {
        ...baseMetrics,
        overCarryUnits: baseMetrics.overCarryUnits + vol,
        churnVsPrevious: baseMetrics.churnVsPrevious + 1,
      },
      rationale: `Over-carry block ${blockId} past its unload hub to a later hub, removing it from this trailer's LIFO conflict on plan ${scope.planId}.`,
    },
    {
      kind: "split",
      blockId,
      slices: restack(slices, blocks, route),
      blocks,
      metrics: {
        ...baseMetrics,
        handlingOps: baseMetrics.handlingOps + 1,
        churnVsPrevious: baseMetrics.churnVsPrevious + 1,
      },
      rationale: `Split and re-stack block ${blockId} into canonical LIFO depth order so earlier-unload freight sits nearer the rear on plan ${scope.planId}.`,
    },
  ];
}

/**
 * OPT-HOS-03 — the HOS recovery variants for an over-hours driver. The load
 * layout is UNCHANGED (the load itself is LIFO-feasible; only the driver's hours
 * fail), so both variants reuse the scope's slices/blocks verbatim and therefore
 * PASS the REUSED Phase-2 gate. Each rationale names the driver, the leg, and the
 * legal/required minutes (explainable, anti-repudiation T-04-11):
 *
 *  - `insertRest` — insert the mandatory 10h off-duty rest before the leg so the
 *    SAME driver completes it legally (rest-as-time; cheaper churn, higher SLA
 *    lateness because the freight waits out the rest).
 *  - `relay` — swap the trip to a FRESH driver in the hub's pool (Amazon-Relay
 *    style), keeping the equipment moving (higher imbalance — work handed off —
 *    but no SLA delay).
 *
 * Pure + deterministic: a function of `hosInfeasible` + base metrics only.
 */
function hosVariants(scope: RepairScope): Variant[] {
  const hos = scope.hosInfeasible;
  if (hos === undefined) return [];
  // A stable synthetic block id for the gate/rationale provenance (the over-hours
  // driver, not a load block). Keeps the layout view identical to the base.
  const blockId = `hos:${hos.driverId}`;
  const why =
    `driver ${hos.driverId} has ${hos.remainingDriveMinutes} legal drive minutes left ` +
    `but leg ${hos.legFromHubId}→${hos.legToHubId} needs ${hos.legMinutes} (HOS-infeasible)`;
  return [
    {
      kind: "insertRest",
      blockId,
      slices: scope.slices,
      blocks: scope.blocks,
      metrics: {
        ...scope.baseMetrics,
        // The freight waits out the mandatory rest ⇒ SLA lateness; minimal churn.
        slaLatenessMin: scope.baseMetrics.slaLatenessMin + 1,
        churnVsPrevious: scope.baseMetrics.churnVsPrevious + 1,
      },
      rationale:
        `Insert a mandatory rest stop before leg ${hos.legFromHubId}→${hos.legToHubId} so ` +
        `driver ${hos.driverId} can legally complete it (${why}).`,
    },
    {
      kind: "relay",
      blockId,
      slices: scope.slices,
      blocks: scope.blocks,
      metrics: {
        ...scope.baseMetrics,
        // Work is handed to a fresh driver ⇒ imbalance; minimal churn, no SLA hit.
        imbalance: scope.baseMetrics.imbalance + 1,
        churnVsPrevious: scope.baseMetrics.churnVsPrevious + 1,
      },
      rationale:
        `Relay leg ${hos.legFromHubId}→${hos.legToHubId} to a fresh driver at ${hos.legFromHubId}, ` +
        `swapping out driver ${hos.driverId} to rest (${why}).`,
    },
  ];
}

/** All offending block ids: those that are blocked under the current layout. */
function offendingBlockIds(scope: RepairScope): readonly string[] {
  const verdict = validatePlan(
    { slices: scope.slices },
    scope.blocks,
    scope.route,
    scope.config,
  );
  const violated = [...verdict.hardViolations, ...verdict.softViolations].map(
    (v) => v.loadBlockId,
  );
  // The blocked block is the target; the repair targets the freight IN FRONT of
  // it. Repairing any block in the layout can clear a conflict, so consider every
  // block present (deterministic, id-sorted) — but prioritise the ones flagged.
  const all = scope.slices.flatMap((s) => s.loadBlockIds);
  const unique = Array.from(new Set([...violated, ...all]));
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Produce ranked feasible recovery recommendations for the plan in `scope`.
 *
 * 1. Identify the offending blocks (via the REUSED validator).
 * 2. Generate split / reassign / hold / over-carry variants for each.
 * 3. GATE each variant through the REUSED `validatePlan` — keep only feasible
 *    ones (anti-P2: feasibility decides survival before the objective ranks).
 * 4. Rank the survivors by the §12 `objective` (ties: kind, then blockId) and
 *    return them best-feasible-first, each with its §17.4 rationale.
 *
 * Returns `[]` only if NO repair makes the plan feasible.
 */
export function localRepair(scope: RepairScope): readonly Recommendation[] {
  const { config, route, weights } = scope;

  const variants: Variant[] = [];
  // OPT-HOS-03 — HOS recovery variants FIRST (the load layout is unchanged), so a
  // LIFO-feasible load whose only problem is the driver's hours still yields a
  // recovery path. Layout (LIFO) repairs follow only when the layout is broken.
  variants.push(...hosVariants(scope));
  if (scope.hosInfeasible === undefined || !isFeasible(validatePlan({ slices: scope.slices }, scope.blocks, route, config))) {
    for (const blockId of offendingBlockIds(scope)) {
      variants.push(...variantsForBlock(scope, blockId));
    }
  }

  const feasible: { readonly rec: Recommendation; readonly cost: number }[] = [];
  for (const v of variants) {
    const verdict = validatePlan({ slices: v.slices }, v.blocks, route, config);
    if (!isFeasible(verdict)) continue; // hard gate FIRST — drop infeasible variants
    feasible.push({
      rec: {
        kind: v.kind,
        rationale: v.rationale,
        resultingMetrics: v.metrics,
        feasibility: verdict,
      },
      cost: objective(v.metrics, weights),
    });
  }

  // Rank best-feasible-first by objective; deterministic tie-breaks (anti-P7).
  feasible.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.rec.kind !== b.rec.kind) return a.rec.kind < b.rec.kind ? -1 : 1;
    return a.rec.rationale < b.rec.rationale ? -1 : a.rec.rationale > b.rec.rationale ? 1 : 0;
  });

  return feasible.map((f) => f.rec);
}
