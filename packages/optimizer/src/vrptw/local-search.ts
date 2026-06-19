import { feasibleArrivals, routeCost, totalDemand } from "./feasibility.js";
import type { CandidateRoute, Stop, TravelModel } from "./types.js";

/**
 * `@mm/optimizer` — VRPTW LOCAL SEARCH: 2-opt + or-opt (OPT-03, Task 2).
 *
 * Improves a constructed route with two classic neighbourhood moves, accepting a
 * move ONLY when it is BOTH feasible AND strictly cost-reducing, so the search is
 * monotonically non-worsening and never breaks a window or capacity:
 *
 *  - **2-opt** — reverse the sub-segment `[i, j]` of the sequence (uncrosses two
 *    edges).
 *  - **or-opt** — relocate a short chain of 1–3 consecutive stops to a different
 *    position (without reversing it).
 *
 * Acceptance is gated by the SHARED predicates (DRY — the same ones construction
 * uses): a candidate is accepted iff {@link feasibleArrivals} ≠ `null` (every
 * window honoured), demand ≤ capacity, AND its {@link routeCost} is strictly less
 * than the current cost (anti-P2: feasibility is checked FIRST, then the cost
 * objective — never folded together). Because every accepted move strictly
 * lowers an integer objective bounded below by 0, the loop terminates.
 *
 * Determinism (anti-P3): no clock, no RNG. A fixed FIRST-IMPROVEMENT scan order
 * (ascending segment indices, 2-opt before or-opt, chain length 1→3) makes the
 * applied move — and thus the final route — reproducible for identical input.
 */

/** The input to {@link localSearch}: a feasible starting route + its constraints. */
export interface LocalSearchInput {
  /** The current (feasible) stop sequence to improve. */
  readonly sequence: readonly Stop[];
  /** Hub the trailer departs from (origin for ETAs + cost). */
  readonly startHubId: string;
  /** Integer freight capacity (the capacity hard gate). */
  readonly capacity: number;
  /** Pure, deterministic travel oracle. */
  readonly travel: TravelModel;
  /** Minute the trailer leaves `startHubId` (default 0). */
  readonly startMin?: number;
}

/** Reverse `sequence[i..j]` (inclusive) — the 2-opt move. Returns a new array. */
function twoOptReverse(sequence: readonly Stop[], i: number, j: number): Stop[] {
  const middle = sequence.slice(i, j + 1).reverse();
  return [...sequence.slice(0, i), ...middle, ...sequence.slice(j + 1)];
}

/**
 * Relocate the chain `sequence[start..start+len-1]` so it begins at `dest`
 * (index into the sequence WITH the chain removed) — the or-opt move. Returns a
 * new array; the chain order is preserved (not reversed).
 */
function orOptRelocate(sequence: readonly Stop[], start: number, len: number, dest: number): Stop[] {
  const chain = sequence.slice(start, start + len);
  const without = [...sequence.slice(0, start), ...sequence.slice(start + len)];
  return [...without.slice(0, dest), ...chain, ...without.slice(dest)];
}

/**
 * Whether `candidate` is feasible: every window honoured AND demand ≤ capacity.
 * The single acceptance gate both moves share (DRY) — checked BEFORE cost.
 */
function isCandidateFeasible(
  candidate: readonly Stop[],
  startHubId: string,
  capacity: number,
  travel: TravelModel,
  startMin: number,
): boolean {
  if (totalDemand(candidate) > capacity) return false;
  return feasibleArrivals(candidate, startHubId, travel, startMin) !== null;
}

/**
 * Run 2-opt + or-opt to local optimality. See the module docstring for the
 * acceptance rule + termination argument. Returns the improved route with its
 * (never-increased) travel cost.
 */
export function localSearch(input: LocalSearchInput): CandidateRoute {
  const { startHubId, capacity, travel } = input;
  const startMin = input.startMin ?? 0;

  let current = input.sequence.slice();
  let currentCost = routeCost(current, startHubId, travel);
  const n = current.length;

  // First-improvement: rescan from the top after each accepted move; stop when a
  // full sweep finds no strictly-improving feasible move (a local optimum).
  let improvedThisSweep = true;
  while (improvedThisSweep) {
    improvedThisSweep = false;

    // --- 2-opt: reverse every segment [i, j] (deterministic ascending scan) ---
    for (let i = 0; i < n - 1 && !improvedThisSweep; i += 1) {
      for (let j = i + 1; j < n && !improvedThisSweep; j += 1) {
        const candidate = twoOptReverse(current, i, j);
        if (!isCandidateFeasible(candidate, startHubId, capacity, travel, startMin)) continue;
        const cost = routeCost(candidate, startHubId, travel);
        if (cost < currentCost) {
          current = candidate;
          currentCost = cost;
          improvedThisSweep = true;
        }
      }
    }
    if (improvedThisSweep) continue;

    // --- or-opt: relocate chains of length 1..3 to a different position --------
    for (let len = 1; len <= 3 && !improvedThisSweep; len += 1) {
      for (let start = 0; start + len <= n && !improvedThisSweep; start += 1) {
        const removedLen = n - len; // length of the sequence after removing the chain
        for (let dest = 0; dest <= removedLen && !improvedThisSweep; dest += 1) {
          // Skip the no-op relocation (chain put back where it was).
          if (dest === start) continue;
          const candidate = orOptRelocate(current, start, len, dest);
          if (!isCandidateFeasible(candidate, startHubId, capacity, travel, startMin)) continue;
          const cost = routeCost(candidate, startHubId, travel);
          if (cost < currentCost) {
            current = candidate;
            currentCost = cost;
            improvedThisSweep = true;
          }
        }
      }
    }
  }

  return { sequence: current, cost: currentCost };
}
