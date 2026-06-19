import type { LoadBlock, PlannerConfig, RouteStop, TrailerSlice } from "@mm/domain";
import type { LoadPlan, Placement } from "./types.js";
import { buildUnloadOrderMap } from "./unload-order.js";

/**
 * The naive FIFO baseline planner (LOAD-09) — the deliberate strawman.
 *
 * `baselinePlan(blocks, route, config)` places blocks in ARRIVAL / FIFO order
 * (a stable `loadBlockId` key — NEVER `unloadOrder`) from the nose toward the
 * rear, rolling to a new slice when the current one runs out of capacity. It is
 * intentionally LIFO-BLIND: it does not order by the route at all. That is the
 * point — it is the "before" the optimizer beats.
 *
 * Crucially it produces the SAME {@link LoadPlan} shape as `planLoad` and carries
 * the TRUE route-derived `unloadOrder` on every placement, so it flows through
 * the SAME `validatePlan` + `scorePlan` plumbing (P8). The baseline differs only
 * in WHERE it puts blocks, never in how blockers/scores are computed — so the
 * before/after comparison is honest (no rigged advantage).
 *
 * It deliberately does NOT import the optimizer (`plan-load`) or the scorer: it
 * just builds a plain plan; the caller scores it through the one shared path.
 *
 * Pure + deterministic: imports only `@mm/domain` (types) + local pure modules;
 * no clock (`Date.now()`), no RNG (`Math.random()`). Same input ⇒ same plan.
 */

/** A trailer id derived deterministically (no clock/RNG), distinct from the optimizer's. */
const BASELINE_TRAILER_ID = "TRAILER-BASELINE-1";

/** Per-slice capacity, sized from the config (mirrors `plan-load.ts` so the two are comparable). */
function sliceCapacities(config: PlannerConfig): {
  capacityVolume: number;
  capacityWeight: number;
} {
  return {
    capacityVolume: config.maxBlockVolume,
    capacityWeight: config.maxBlockVolume * 100,
  };
}

/** A mutable slice accumulator, converted to an immutable {@link TrailerSlice} at the end. */
interface SliceBuilder {
  readonly capacityVolume: number;
  readonly capacityWeight: number;
  usedVolume: number;
  usedWeight: number;
  readonly loadBlockIds: string[];
}

function newSlice(capacityVolume: number, capacityWeight: number): SliceBuilder {
  return {
    capacityVolume,
    capacityWeight,
    usedVolume: 0,
    usedWeight: 0,
    loadBlockIds: [],
  };
}

function fits(slice: SliceBuilder, block: LoadBlock): boolean {
  return (
    slice.usedVolume + block.totalVolume <= slice.capacityVolume &&
    slice.usedWeight + block.totalWeight <= slice.capacityWeight
  );
}

/**
 * Build the naive plan. See the module docstring for the full contract.
 *
 * @param blocks the load blocks to place (FIFO-ordered internally by id).
 * @param route  the trailer's remaining route (drives the TRUE unloadOrder only).
 * @param config planner knobs (slice capacity sizing).
 */
export function baselinePlan(
  blocks: readonly LoadBlock[],
  route: readonly RouteStop[],
  config: PlannerConfig,
): LoadPlan {
  const orderMap = buildUnloadOrderMap(route);
  const fallbackOrder = orderMap.size; // unknown hub sorts as the latest unload
  const { capacityVolume, capacityWeight } = sliceCapacities(config);

  // FIFO / arrival order: stable `loadBlockId` ascending. NOT unloadOrder — the
  // baseline is deliberately LIFO-blind.
  const fifo = [...blocks].sort((a, b) =>
    a.loadBlockId < b.loadBlockId ? -1 : a.loadBlockId > b.loadBlockId ? 1 : 0,
  );

  // Fill slices from the nose toward the rear: the FIRST-arriving block is loaded
  // first ⇒ deepest (nose). `built[0]` is the deepest slice.
  const built: SliceBuilder[] = [];
  let current: SliceBuilder | undefined;
  const sliceIndexByBlockId = new Map<string, number>();

  for (const block of fifo) {
    if (current === undefined || !fits(current, block)) {
      current = newSlice(capacityVolume, capacityWeight);
      built.push(current);
    }
    current.usedVolume += block.totalVolume;
    current.usedWeight += block.totalWeight;
    current.loadBlockIds.push(block.loadBlockId);
    sliceIndexByBlockId.set(block.loadBlockId, built.length - 1);
  }

  // `built[0]` is the deepest (nose); renumber so depth 0 = rear (single-sourced
  // depth convention — last-built slice, nearest the rear, becomes depth 0).
  const sliceCount = built.length;
  const depthOf = (sliceIndex: number): number => sliceCount - 1 - sliceIndex;

  const slices: TrailerSlice[] = built
    .map((s, sliceIndex): TrailerSlice => ({
      depth: depthOf(sliceIndex),
      capacityVolume: s.capacityVolume,
      capacityWeight: s.capacityWeight,
      usedVolume: s.usedVolume,
      usedWeight: s.usedWeight,
      loadBlockIds: [...s.loadBlockIds],
    }))
    .sort((a, b) => a.depth - b.depth); // ascending depth (0 = rear) like emptyTrailer

  const unloadOrderOf = (block: LoadBlock): number =>
    orderMap.get(block.key.nextUnloadHubId) ?? fallbackOrder;
  const blockById = new Map(blocks.map((b) => [b.loadBlockId, b]));

  const placements: Placement[] = [...sliceIndexByBlockId.entries()]
    .map(([loadBlockId, sliceIndex]): Placement => {
      const block = blockById.get(loadBlockId);
      return {
        loadBlockId,
        depth: depthOf(sliceIndex),
        // the TRUE route-derived unload order (so the validator/scorer see real
        // blockers when FIFO buries early freight) — NOT the FIFO position.
        unloadOrder: block === undefined ? fallbackOrder : unloadOrderOf(block),
      };
    })
    .sort((a, b) => (a.loadBlockId < b.loadBlockId ? -1 : 1));

  return {
    trailerId: BASELINE_TRAILER_ID,
    slices,
    placements,
  };
}
