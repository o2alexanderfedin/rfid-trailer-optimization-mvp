import type { LoadPlan, Placement } from "./types.js";

/**
 * THE canonical LIFO invariant + blocker predicate — the P1 single source.
 *
 * This module is the ONE place that states the route-aware LIFO accessibility
 * rule. The planner, the independent validator, and every test MUST import the
 * predicate from here and NEVER re-state it divergently. A re-stated (and
 * possibly sign-flipped) copy is exactly the failure mode that silently inverts
 * the whole product (PITFALLS P1 / threat T-02-07), so there is deliberately no
 * second definition anywhere.
 *
 * Canonical conventions (locked in 02-CONTEXT.md, single-sourced with
 * `@mm/domain`'s `TrailerSlice.depth` and `RouteStop.stopIndex`):
 *
 *  - `depth`: 0 = rear (the door, easiest access); depth increases toward the
 *    nose. A block at a SMALLER depth is physically IN FRONT OF (closer to the
 *    rear door than) a block at a larger depth.
 *  - `unloadOrder`: the stop index of a block's next-unload hub in the remaining
 *    route. LOWER = unloaded SOONER ⇒ belongs nearer the rear (lower depth).
 *
 * THE INVARIANT:
 *
 *     unloadOrder(A) < unloadOrder(B)  ⟹  depth(A) ≤ depth(B)
 *
 * (earlier unload ⇒ at least as close to the rear). Equivalently: no
 * earlier-unload block may sit deeper than a later-unload block.
 *
 * Pure module: imports only the local type contracts; no `@mm/domain` runtime
 * value, no clock (`Date.now()`), no RNG (`Math.random()`). Deterministic.
 */

/**
 * THE blocker predicate. `other` blocks `target` ⟺ `other` is physically in
 * front of `target` (strictly closer to the rear) AND `other` unloads strictly
 * LATER than `target`.
 *
 *     isBlocker(target, other) ⟺ other.depth < target.depth
 *                                 AND other.unloadOrder > target.unloadOrder
 *
 * Both comparisons are STRICT (`<` and `>`), which pins the boundary cases that
 * the spec (§7.4) and the threat model demand:
 *
 *  - same `unloadOrder` (e.g. two blocks for the same hub) ⇒ NOT a blocker —
 *    they unload together, neither has to be moved for the other;
 *  - same `depth` (same slice / side-by-side) ⇒ NOT a blocker — `other` is not
 *    in front of `target`;
 *  - `other` DEEPER than `target` (toward the nose) ⇒ NOT a blocker — it is
 *    behind the target and comes off after it;
 *  - a block is never its own blocker (both comparisons are strict).
 */
export function isBlocker(target: Placement, other: Placement): boolean {
  return other.depth < target.depth && other.unloadOrder > target.unloadOrder;
}

/**
 * Count how many of `placements` block `target` under {@link isBlocker}. This is
 * the rehandle count the independent validator gates against `maxAllowedBlockers`
 * and the rehandle scorer weights. `target` itself never counts (the predicate
 * is strict in both axes).
 */
export function countBlockers(
  target: Placement,
  placements: readonly Placement[],
): number {
  let count = 0;
  for (const other of placements) {
    if (isBlocker(target, other)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Does the canonical invariant hold across ALL ordered pairs of `placements`?
 *
 *     ∀ A, B:  unloadOrder(A) < unloadOrder(B)  ⟹  depth(A) ≤ depth(B)
 *
 * Returns `false` as soon as a violating pair is found (an earlier-unload block
 * placed strictly deeper than a later-unload block). Vacuously `true` for the
 * empty and singleton plans.
 *
 * Note this is the symmetric, pair-wise statement of the predicate: a violating
 * pair `(A earlier, B later, depth(A) > depth(B))` is exactly a pair where
 * `isBlocker(A, B)` holds (B is in front of A and unloads later). Stating it
 * directly (not via {@link isBlocker}) keeps the invariant readable as the
 * universally-quantified rule it is; the two are provably equivalent.
 */
export function canonicalInvariantHolds(placements: readonly Placement[]): boolean {
  for (let i = 0; i < placements.length; i += 1) {
    const a = placements[i];
    // `noUncheckedIndexedAccess`: indexed reads are `Placement | undefined`.
    if (a === undefined) continue;
    for (let j = 0; j < placements.length; j += 1) {
      if (i === j) continue;
      const b = placements[j];
      if (b === undefined) continue;
      if (a.unloadOrder < b.unloadOrder && a.depth > b.depth) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Convenience wrapper: does a whole {@link LoadPlan} satisfy the canonical
 * invariant over its placements? The planner and tests use this as the one-call
 * LIFO check.
 */
export function lifoOk(plan: LoadPlan): boolean {
  return canonicalInvariantHolds(plan.placements);
}
