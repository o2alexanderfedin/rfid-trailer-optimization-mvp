import type { TrailerSlice } from "@mm/domain";

/**
 * The trailer rear-to-nose slice model (LOAD-01) and its zone labels.
 *
 * Canonical convention (single-sourced with `lifo-invariant.ts` and
 * `@mm/domain`'s `TrailerSlice.depth`): **depth 0 = rear** (the door, easiest
 * access); depth increases toward the nose. `emptyTrailer` materialises the
 * ordered, empty slice sequence the planner places blocks into; `zoneForDepth`
 * derives the human nose/middle/rear label used by the dock-worker loading
 * instructions (LOAD-08).
 *
 * Pure module: imports only the `@mm/domain` type (no runtime value), no clock,
 * no RNG. Deterministic.
 */

/** A human-readable trailer zone label, rear (door) → nose (deepest). */
export type Zone = "rear" | "middle" | "nose";

/** Guard: a value must be a non-negative integer. */
function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/** Guard: a value must be a strictly-positive finite number. */
function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive number, got ${value}`);
  }
}

/**
 * Build an empty trailer (LOAD-01): an ordered `TrailerSlice[]` of length
 * `sliceCount`, with `depth` running `0 .. sliceCount-1` (0 = rear), each slice
 * carrying the given capacities, zero used volume/weight, and its own empty
 * `loadBlockIds` array. Slices are returned in ascending-depth order.
 *
 * @param trailerId        non-empty trailer identifier (validated; carried by the caller's plan).
 * @param sliceCount       number of depth segments (non-negative integer).
 * @param capacityVolume   per-slice volume capacity, m³ (positive).
 * @param capacityWeight   per-slice weight capacity, kg (positive).
 */
export function emptyTrailer(
  trailerId: string,
  sliceCount: number,
  capacityVolume: number,
  capacityWeight: number,
): TrailerSlice[] {
  if (trailerId.length === 0) {
    throw new RangeError("trailerId must be a non-empty string");
  }
  assertNonNegativeInt(sliceCount, "sliceCount");
  assertPositive(capacityVolume, "capacityVolume");
  assertPositive(capacityWeight, "capacityWeight");

  const slices: TrailerSlice[] = [];
  for (let depth = 0; depth < sliceCount; depth += 1) {
    slices.push({
      depth,
      capacityVolume,
      capacityWeight,
      usedVolume: 0,
      usedWeight: 0,
      loadBlockIds: [], // fresh array per slice — no shared mutable state
    });
  }
  return slices;
}

/**
 * Derive the {@link Zone} label for a slice at `depth` in a trailer of
 * `sliceCount` slices, by depth thirds: `floor(depth * 3 / sliceCount)` maps
 * the lowest third to `rear`, the middle third to `middle`, the highest third
 * to `nose`. Deterministic for any `sliceCount` (divisible by 3 or not) and
 * monotone in depth (the zone never moves back toward the rear as depth grows).
 *
 * @throws RangeError if `depth`/`sliceCount` are not non-negative integers, if
 *   `sliceCount` is 0, or if `depth >= sliceCount`.
 */
export function zoneForDepth(depth: number, sliceCount: number): Zone {
  assertNonNegativeInt(depth, "depth");
  assertNonNegativeInt(sliceCount, "sliceCount");
  if (sliceCount === 0) {
    throw new RangeError("sliceCount must be at least 1");
  }
  if (depth >= sliceCount) {
    throw new RangeError(
      `depth ${depth} is out of range for a ${sliceCount}-slice trailer`,
    );
  }
  // Integer-only arithmetic: floor((depth*3)/sliceCount) ∈ {0,1,2}.
  const third = Math.floor((depth * 3) / sliceCount);
  if (third <= 0) return "rear";
  if (third >= 2) return "nose";
  return "middle";
}
