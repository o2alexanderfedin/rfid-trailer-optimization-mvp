import type { LoadBlock, PlannerConfig, RouteStop, TrailerSlice } from "@mm/domain";
import type { LoadPlan, Placement } from "./types.js";
import { buildUnloadOrderMap } from "./unload-order.js";

/**
 * The greedy route-aware load planner (LOAD-03) + partial-LIFO (LOAD-05).
 *
 * `planLoad(blocks, route, config)` turns a set of {@link LoadBlock}s and a
 * {@link RouteStop} sequence into a {@link LoadPlan}: an ordered rear→nose
 * {@link TrailerSlice} sequence (depth 0 = rear) plus the {@link Placement} of
 * every block. The placement strategy is the spec's §11.5 greedy:
 *
 *   sort blocks by unloadOrder DESCENDING (latest-unload first) and place from
 *   the nose toward the rear, opening a new (shallower) slice when the current
 *   one runs out of per-slice volume/weight capacity.
 *
 * Because the unloadOrder for each block is the dense rank from
 * {@link buildUnloadOrderMap} (earlier stop ⇒ lower order) and depths are
 * assigned non-increasingly as the order decreases, the result placements
 * satisfy THE canonical invariant by construction:
 *
 *   unloadOrder(A) < unloadOrder(B)  ⟹  depth(A) ≤ depth(B)
 *
 * The invariant is single-sourced in `lifo-invariant.ts`; this module never
 * re-states it — it builds a layout that respects it (the validator independently
 * verifies that, never trusting this bookkeeping).
 *
 * TOTAL-LIFO by construction (LOAD-03/05): `planLoad` lays a STRICTLY accessible
 * trailer — ZERO blockers — for any input where every block fits a slice. Because
 * depth is assigned non-increasingly as `unloadOrder` decreases, no later-unload
 * block is ever placed in front of an earlier-unload one; and blocks of the SAME
 * `unloadOrder` spread across depths are never mutual blockers (strict predicate).
 * So `planLoad`'s own output never NEEDS a rehandle — it does not manufacture a
 * partial-LIFO layout.
 *
 * The SOFT / partial-LIFO violations and their rehandle COST are a TOLERANCE of
 * the independent validator + scorer (`validatePlan` / `scorePlan`), exercised by
 * the LIFO-blind FIFO strawman {@link baselinePlan} — NOT a layout `planLoad`
 * produces. `planLoad` never rejects an input and never emits an out-of-bound
 * blocker when a feasible layout exists; the cost machinery exists only to score
 * plans (like the baseline) that DO bury freight.
 *
 * Pure + deterministic: imports only `@mm/domain` (types) + local pure modules;
 * stable sorts with a `loadBlockId` tie-break; no clock (`Date.now()`), no RNG
 * (`Math.random()`). Same `(blocks, route, config)` ⇒ identical plan.
 */

/** A trailer id derived deterministically from the route (no clock/RNG). */
const PLANNER_TRAILER_ID = "TRAILER-1";

/**
 * Per-slice capacity headroom for the trailer the planner materialises. A slice
 * holds up to `maxBlockVolume` (≈ one trailer-zone capacity, the AGG-03 split
 * threshold) so a single split-sized block always fits in one slice, and weight
 * scales with it. These are sized from the config so the planner stays
 * config-driven (no magic constants beyond the proportional weight factor).
 */
function sliceCapacities(config: PlannerConfig): {
  capacityVolume: number;
  capacityWeight: number;
} {
  return {
    capacityVolume: config.maxBlockVolume,
    // weight capacity tracks volume capacity; a generous proportional factor so
    // weight is rarely the binding constraint for the demo's light freight.
    capacityWeight: config.maxBlockVolume * 100,
  };
}

/** A block paired with its route-derived unload order (the placement sort key). */
interface OrderedBlock {
  readonly block: LoadBlock;
  readonly unloadOrder: number;
}

/**
 * A mutable slice accumulator used while greedily filling the trailer. Converted
 * to an immutable {@link TrailerSlice} once placement completes.
 */
interface SliceBuilder {
  readonly depth: number;
  readonly capacityVolume: number;
  readonly capacityWeight: number;
  usedVolume: number;
  usedWeight: number;
  readonly loadBlockIds: string[];
}

function newSlice(
  depth: number,
  capacityVolume: number,
  capacityWeight: number,
): SliceBuilder {
  return {
    depth,
    capacityVolume,
    capacityWeight,
    usedVolume: 0,
    usedWeight: 0,
    loadBlockIds: [],
  };
}

/** Does `block` fit in `slice` within both per-slice capacities? */
function fits(slice: SliceBuilder, block: LoadBlock): boolean {
  return (
    slice.usedVolume + block.totalVolume <= slice.capacityVolume &&
    slice.usedWeight + block.totalWeight <= slice.capacityWeight
  );
}

/**
 * Resolve each block's unload order from the route. A block's unload order is the
 * dense rank of its `key.nextUnloadHubId`; a hub not on the route sorts as the
 * latest (placed deepest) so unknown freight never lands at the rear door.
 */
function resolveOrders(
  blocks: readonly LoadBlock[],
  orderMap: ReadonlyMap<string, number>,
): OrderedBlock[] {
  const fallback = orderMap.size; // strictly greater than any present rank
  return blocks.map((block) => ({
    block,
    unloadOrder: orderMap.get(block.key.nextUnloadHubId) ?? fallback,
  }));
}

/**
 * The greedy planner. See module docstring for the full contract.
 *
 * @param blocks the load blocks to place (any order — sorted internally).
 * @param route  the trailer's remaining route (drives unload order).
 * @param config planner knobs (slice capacity sizing; `maxAllowedBlockers` gate).
 */
export function planLoad(
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
  config: PlannerConfig,
): LoadPlan {
  const orderMap = buildUnloadOrderMap(route);
  const { capacityVolume, capacityWeight } = sliceCapacities(config);

  // Sort by unloadOrder DESCENDING (latest-unload first → placed deepest, toward
  // the nose). Tie-break by loadBlockId ASCENDING for a stable, input-order-
  // independent plan (determinism, PITFALLS P3).
  const ordered = resolveOrders(blocks, orderMap).sort((a, b) => {
    if (a.unloadOrder !== b.unloadOrder) {
      return b.unloadOrder - a.unloadOrder; // descending order key
    }
    return a.block.loadBlockId < b.block.loadBlockId ? -1 : 1;
  });

  // Greedily fill slices from the nose toward the rear. We BUILD slices in
  // placement order (deepest first) then renumber depths so depth 0 = rear.
  const built: SliceBuilder[] = [];
  let current: SliceBuilder | undefined;
  const placementsByBlockId = new Map<string, { sliceIndex: number; unloadOrder: number }>();

  for (const { block, unloadOrder } of ordered) {
    // Open the first slice, or roll to a new (shallower) slice when the block
    // would overflow the current one's capacity. A monotone unloadOrder means a
    // shallower slice always holds an earlier-or-equal-unload block ⇒ invariant.
    if (current === undefined || !fits(current, block)) {
      current = newSlice(built.length, capacityVolume, capacityWeight);
      built.push(current);
    }
    current.usedVolume += block.totalVolume;
    current.usedWeight += block.totalWeight;
    current.loadBlockIds.push(block.loadBlockId);
    placementsByBlockId.set(block.loadBlockId, {
      sliceIndex: built.length - 1,
      unloadOrder,
    });
  }

  // `built[0]` is the DEEPEST (nose) slice; renumber so depth 0 = rear. The
  // last-built slice (nearest the rear) becomes depth 0.
  const sliceCount = built.length;
  const depthOf = (sliceIndex: number): number => sliceCount - 1 - sliceIndex;

  const slices: TrailerSlice[] = built
    .map((s): TrailerSlice => ({
      depth: depthOf(s.depth),
      capacityVolume: s.capacityVolume,
      capacityWeight: s.capacityWeight,
      usedVolume: s.usedVolume,
      usedWeight: s.usedWeight,
      loadBlockIds: [...s.loadBlockIds],
    }))
    // emit slices in ascending-depth order (0 = rear) like `emptyTrailer`.
    .sort((a, b) => a.depth - b.depth);

  const placements: Placement[] = [...placementsByBlockId.entries()]
    .map(([loadBlockId, { sliceIndex, unloadOrder }]): Placement => ({
      loadBlockId,
      depth: depthOf(sliceIndex),
      unloadOrder,
    }))
    // stable, id-ordered placement list (determinism).
    .sort((a, b) => (a.loadBlockId < b.loadBlockId ? -1 : 1));

  return {
    trailerId: PLANNER_TRAILER_ID,
    slices,
    placements,
  };
}
