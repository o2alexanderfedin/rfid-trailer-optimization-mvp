import type { LoadBlock, PlannerConfig, RouteStop } from "@mm/domain";
import {
  type BlockRehandle,
  rehandleBreakdown,
  rehandleScore,
  utilizationScore,
} from "./scoring.js";
import { type Zone, zoneForDepth } from "./trailer.js";
import type { LoadPlan, Placement } from "./types.js";
import { isFeasible, validatePlan } from "./validator.js";

/**
 * Explainability (LOAD-10) — plain-English rationale built from scoring internals.
 *
 * `placementRationale` turns the SAME rehandle breakdown the scorer computes
 * ({@link rehandleBreakdown}) into a human sentence per placement: an accessible
 * block reads as "unloads first; no rehandle", a partial-LIFO block reads as
 * "N blocker(s); +M-min rehandle accepted". `planExplanation` aggregates those
 * with the feasibility verdict and the rehandle/utilization figures. Because the
 * rationale reuses the scorer's numbers (never re-deriving them), the words can
 * never disagree with the score.
 *
 * Pure + deterministic: imports only `@mm/domain` (types) + local pure modules;
 * no clock, no RNG. Same input ⇒ identical text.
 */

/**
 * Human zone label for a placement, derived from the block's ACTUAL physical
 * slice (L6). The zone must match where the block really sits — the slice in
 * `plan.slices` whose `loadBlockIds` contains it — NOT a caller-supplied
 * `placement.depth` that could have drifted out of sync with the layout. We
 * re-derive from `plan.slices` (the same single source `instructions.ts` and the
 * validator read), falling back to `placement.depth` only if the block is absent
 * from every slice (defensive — a valid plan always lists it).
 */
function zoneLabel(plan: LoadPlan, placement: Placement): Zone {
  const sliceCount = plan.slices.length;
  if (sliceCount <= 0) return "nose"; // empty trailer — defensive
  const owning = plan.slices.find((s) =>
    s.loadBlockIds.includes(placement.loadBlockId),
  );
  const depth = owning?.depth ?? placement.depth;
  // Clamp an out-of-range depth to the deepest valid slice rather than guessing.
  const safeDepth = depth >= sliceCount ? sliceCount - 1 : depth;
  return zoneForDepth(safeDepth, sliceCount);
}

/**
 * Render ONE placement's rationale from the plan's rehandle breakdown.
 *
 * The breakdown is the canonical scoring internal: if the placement is in it the
 * block is blocked (partial-LIFO accepted at a cost); if absent it is accessible.
 * The minutes figure is `blockerCount · unloadReloadMin` — the same product the
 * rehandle score weights, so the sentence and the number agree.
 */
export function placementRationale(
  placement: Placement,
  plan: LoadPlan,
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
  config: PlannerConfig,
): string {
  const breakdown = rehandleBreakdown(plan, blocks, route, config);
  return rationaleFromBreakdown(placement, plan, breakdown, config);
}

/** Shared renderer so per-placement and plan-level use ONE phrasing. */
function rationaleFromBreakdown(
  placement: Placement,
  plan: LoadPlan,
  breakdown: readonly BlockRehandle[],
  config: PlannerConfig,
): string {
  const zone = zoneLabel(plan, placement);
  const id = placement.loadBlockId;
  const entry = breakdown.find((b) => b.loadBlockId === id);

  if (entry === undefined) {
    // Accessible: no later-unload freight in front of it ⇒ no rehandle.
    return `${id} placed ${zone}: accessible — unloads in order, no rehandle.`;
  }

  const minutes = entry.blockerCount * config.unloadReloadMin;
  const blockerWord = entry.blockerCount === 1 ? "blocker" : "blockers";
  const fragileNote = entry.fragile ? " (fragile — extra care)" : "";
  return (
    `${id} placed ${zone}: ${entry.blockerCount} ${blockerWord}, ` +
    `+${minutes}-min rehandle accepted${fragileNote}.`
  );
}

/**
 * The full plan explanation (LOAD-10): the feasibility verdict, the rehandle and
 * utilization figures, then every placement's rationale — one human-readable
 * block. Feasibility comes from the INDEPENDENT validator (the hard gate); the
 * figures come from the scorer. The two stay separate (P2): the verdict is never
 * derived from the score.
 */
export function planExplanation(
  plan: LoadPlan,
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
  config: PlannerConfig,
): string {
  const feasibility = validatePlan(plan, blocks, route, config);
  const feasible = isFeasible(feasibility);
  const rehandle = rehandleScore(plan, blocks, route, config);
  const util = utilizationScore(plan, config);
  const breakdown = rehandleBreakdown(plan, blocks, route, config);

  const verdict = feasible
    ? `Plan ${plan.trailerId} is FEASIBLE`
    : `Plan ${plan.trailerId} is INFEASIBLE (${feasibility.hardViolations.length} hard violation(s))`;
  const softCount = feasibility.softViolations.length;
  const softNote =
    softCount > 0 ? ` with ${softCount} tolerated partial-LIFO block(s)` : "";

  const header =
    `${verdict}${softNote}. ` +
    `Rehandle cost ${rehandle}; utilization penalty ${util}.`;

  // Per-placement lines, ordered by depth ascending (rear → nose) then id, for a
  // stable, readable narration.
  const lines = [...plan.placements]
    .sort((a, b) =>
      a.depth - b.depth || (a.loadBlockId < b.loadBlockId ? -1 : 1),
    )
    .map((p) => rationaleFromBreakdown(p, plan, breakdown, config));

  return [header, ...lines].join("\n");
}
