import type { LoadBlock, PlannerConfig, RouteStop } from "@mm/domain";
import { isBlocker } from "./lifo-invariant.js";
import type { FeasibilityResult, Placement, Violation } from "./types.js";
import { buildUnloadOrderMap } from "./unload-order.js";

/**
 * The INDEPENDENT feasibility validator (LOAD-04) — a virtual unload simulation.
 *
 * This is the integrity control of the whole product (threat T-02-10/T-02-11):
 * the SEPARATE code path that checks the planner did not silently lie about LIFO
 * accessibility. It MUST therefore re-derive everything from first principles and
 * NEVER trust the planner's bookkeeping:
 *
 *  - It reads ONLY `plan.slices` (each slice's `depth` + `loadBlockIds`) — it
 *    deliberately IGNORES `plan.placements` (the planner's own placement record).
 *  - It recomputes each block's unloadOrder from the route via
 *    {@link buildUnloadOrderMap} (the same single-sourced bridge the planner
 *    uses) and counts blockers with the ONE canonical {@link isBlocker} predicate.
 *  - It imports from `lifo-invariant` / `types` / `@mm/domain` ONLY — never from
 *    `plan-load`. (An import-shape test in `validator.test.ts` enforces this; the
 *    string "plan-load"/"planLoad" must not appear in this file.)
 *
 * "Virtual unload simulation": conceptually we walk the route stop-by-stop and,
 * at each stop, ask which freight has to come off and how many later-unload
 * blocks sit in front of it (closer to the rear). Concretely that is exactly the
 * blocker count under {@link isBlocker} over the slice-derived placements, so we
 * compute it once per block (order-independent) rather than re-scanning per stop.
 *
 * Feasibility-vs-score separation (P2): the result is a {@link FeasibilityResult}
 * — `{ hardViolations, softViolations }` — and NOTHING else. It carries no
 * rehandle/utilization score. `blockerCount > maxAllowedBlockers ⇒ HARD`;
 * `1..max ⇒ SOFT`; `0 ⇒ no violation`. A plan is feasible ⟺ zero HARD violations,
 * regardless of any (future) score — the hard gate can never be bought out.
 *
 * Pure + deterministic: no clock, no RNG.
 */

/**
 * Re-derive the placed {@link Placement}s purely from the plan's SLICE contents
 * and the route — the validator's independent view of the layout.
 *
 * For each slice we read its `depth` and the `loadBlockIds` physically in it; the
 * block's unloadOrder is the dense rank of its `key.nextUnloadHubId` in the
 * route. A block id present in a slice but absent from `blocks` is skipped (it
 * cannot be reasoned about); a hub not on the route sorts as the latest unload
 * (consistent with the planner's fallback) so it is never treated as rear-bound.
 */
function placementsFromSlices(
  plan: { readonly slices: readonly { readonly depth: number; readonly loadBlockIds: readonly string[] }[] },
  blocks: readonly LoadBlock[],
  orderMap: ReadonlyMap<string, number>,
): Placement[] {
  const hubByBlockId = new Map<string, string>(
    blocks.map((b) => [b.loadBlockId, b.key.nextUnloadHubId]),
  );
  const latest = orderMap.size; // fallback rank for an unknown hub

  const placements: Placement[] = [];
  for (const slice of plan.slices) {
    for (const loadBlockId of slice.loadBlockIds) {
      const hubId = hubByBlockId.get(loadBlockId);
      if (hubId === undefined) continue; // unknown block — cannot derive its order
      const unloadOrder = orderMap.get(hubId) ?? latest;
      placements.push({ loadBlockId, depth: slice.depth, unloadOrder });
    }
  }
  return placements;
}

/**
 * Validate a load plan by an INDEPENDENT virtual unload simulation. See the
 * module docstring for the full contract.
 *
 * @param plan   the plan to validate — ONLY its `slices` are read (placements ignored).
 * @param blocks the blocks referenced by the slices (maps id → next-unload hub).
 * @param route  the trailer's remaining route (drives unload order).
 * @param config planner knobs — `maxAllowedBlockers` is the HARD gate.
 * @returns a {@link FeasibilityResult} (no score).
 */
export function validatePlan(
  plan: {
    readonly slices: readonly { readonly depth: number; readonly loadBlockIds: readonly string[] }[];
  },
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
  config: PlannerConfig,
): FeasibilityResult {
  const orderMap = buildUnloadOrderMap(route);
  const placements = placementsFromSlices(plan, blocks, orderMap);
  const { maxAllowedBlockers } = config;

  const hardViolations: Violation[] = [];
  const softViolations: Violation[] = [];

  for (const target of placements) {
    // Independent recompute: count blockers from the slice-derived placements
    // via the ONE canonical predicate (later-unload freight in front of target).
    let blockerCount = 0;
    for (const other of placements) {
      if (isBlocker(target, other)) {
        blockerCount += 1;
      }
    }

    if (blockerCount === 0) continue; // no accessibility violation

    const severity = blockerCount > maxAllowedBlockers ? "HARD" : "SOFT";
    const violation: Violation = {
      loadBlockId: target.loadBlockId,
      kind: "accessibility",
      blockerCount,
      severity,
      detail:
        severity === "HARD"
          ? `${blockerCount} blockers exceed the max of ${maxAllowedBlockers}`
          : `${blockerCount} blocker${blockerCount === 1 ? "" : "s"} within the max of ${maxAllowedBlockers}`,
    };
    (severity === "HARD" ? hardViolations : softViolations).push(violation);
  }

  return { hardViolations, softViolations };
}

/**
 * The HARD feasibility gate: a plan is feasible ⟺ it has zero HARD violations.
 * SOFT (partial-LIFO, bounded blockers) is tolerated — those carry a rehandle
 * cost (assigned by a later plan) but never break feasibility. This is the gate
 * that a low score can never buy out (P2).
 */
export function isFeasible(result: FeasibilityResult): boolean {
  return result.hardViolations.length === 0;
}
