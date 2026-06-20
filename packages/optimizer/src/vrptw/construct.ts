import { feasibleArrivals, routeCost, totalDemand } from "./feasibility.js";
import type { Stop, TravelModel } from "./types.js";

/**
 * `@mm/optimizer` — VRPTW CONSTRUCTION via cheapest insertion (OPT-03, Task 1).
 *
 * Builds an initial feasible route for one trailer by repeatedly inserting the
 * still-unplaced stop at the (stop, position) pair that adds the LEAST travel
 * cost while keeping every time window AND the capacity feasible. An insertion
 * that would arrive after a stop's `windowEndMin`, or push total demand over
 * `capacity`, is REJECTED (anti-P2: the hard feasibility gates are checked first
 * and never folded into the travel-cost objective).
 *
 * Determinism (anti-P3): no clock, no RNG. Every comparison breaks ties
 * LEXICOGRAPHICALLY — first by the lower travel-cost delta, then by the inserted
 * stop's `hubId`, then by the earlier insertion index — so identical input
 * always yields an identical sequence.
 *
 * A stop that fits at NO feasible position is left in {@link ConstructionResult.unplaced}
 * and `feasible` becomes `false` (the route cannot service every stop). Callers
 * (the rolling loop / repair) decide whether to split or drop — construction
 * never silently violates a window or capacity.
 */

/** The input to {@link constructRoutes}: one trailer, its capacity, and the stops. */
export interface ConstructInput {
  /** Stops to be routed (order irrelevant — construction re-orders them). */
  readonly stops: readonly Stop[];
  /** Integer freight capacity of the trailer. */
  readonly capacity: number;
  /** Hub the trailer departs from (the route origin for ETAs + cost). */
  readonly startHubId: string;
  /** Pure, deterministic travel oracle. */
  readonly travel: TravelModel;
  /** Minute the trailer leaves `startHubId` (default 0). */
  readonly startMin?: number;
}

/**
 * The construction output: the built `sequence` (in service order), its total
 * travel `cost`, the `unplaced` stops that fit nowhere feasible, and the
 * SEPARATE `feasible` flag (`true` ⟺ `unplaced` is empty — every stop serviced
 * within window + capacity). `feasible` here is window+capacity only; the reused
 * Phase-2 LIFO HARD gate is applied later in `routeTrailers`.
 */
export interface ConstructionResult {
  readonly sequence: readonly Stop[];
  readonly cost: number;
  readonly unplaced: readonly Stop[];
  readonly feasible: boolean;
}

/**
 * Insert `stop` into `sequence` at index `pos` (0 = front), returning a new
 * array (no mutation — construction is pure).
 */
function insertAt(sequence: readonly Stop[], stop: Stop, pos: number): Stop[] {
  return [...sequence.slice(0, pos), stop, ...sequence.slice(pos)];
}

/**
 * The cheapest FEASIBLE position to insert `stop` into `sequence`, or `null` if
 * no position keeps every window feasible. Capacity is checked by the caller
 * (it is position-independent). Ties break by the earlier insertion index, so
 * the result is deterministic.
 */
function cheapestInsertion(
  sequence: readonly Stop[],
  stop: Stop,
  startHubId: string,
  travel: TravelModel,
  startMin: number,
): { readonly pos: number; readonly cost: number } | null {
  let best: { pos: number; cost: number } | null = null;
  const baseCost = routeCost(sequence, startHubId, travel);

  for (let pos = 0; pos <= sequence.length; pos += 1) {
    const candidate = insertAt(sequence, stop, pos);
    // WINDOW HARD CHECK first (anti-P2) — reject before scoring cost.
    if (feasibleArrivals(candidate, startHubId, travel, startMin) === null) continue;
    const delta = routeCost(candidate, startHubId, travel) - baseCost;
    // Lower delta wins; tie → earlier position (strict `<` keeps the first).
    if (best === null || delta < best.cost) best = { pos, cost: delta };
  }

  return best;
}

/**
 * Build a route by cheapest insertion (see the module docstring).
 *
 * Stops are processed in a DETERMINISTIC order — by `hubId` lexicographically —
 * so the greedy choices (and thus the final sequence) are reproducible. Each
 * stop is placed at its cheapest feasible position if doing so keeps total
 * demand ≤ capacity; otherwise it is left unplaced.
 */
export function constructRoutes(input: ConstructInput): ConstructionResult {
  const { stops, capacity, startHubId, travel } = input;
  const startMin = input.startMin ?? 0;

  // Deterministic processing order (anti-P3 / lexicographic tie-break).
  const pending = [...stops].sort((a, b) => (a.hubId < b.hubId ? -1 : a.hubId > b.hubId ? 1 : 0));

  let sequence: readonly Stop[] = [];
  let placedDemand = 0;
  const unplaced: Stop[] = [];

  for (const stop of pending) {
    // CAPACITY HARD CHECK (anti-P2): position-independent, check before cost.
    if (placedDemand + stop.demand > capacity) {
      unplaced.push(stop);
      continue;
    }
    const best = cheapestInsertion(sequence, stop, startHubId, travel, startMin);
    if (best === null) {
      unplaced.push(stop);
      continue;
    }
    sequence = insertAt(sequence, stop, best.pos);
    placedDemand += stop.demand;
  }

  // Demand invariant must hold by construction (defensive, never thrown in tests).
  const finalDemand = totalDemand(sequence);
  const cost = routeCost(sequence, startHubId, travel);

  return {
    sequence,
    cost,
    unplaced,
    feasible: unplaced.length === 0 && finalDemand <= capacity,
  };
}
