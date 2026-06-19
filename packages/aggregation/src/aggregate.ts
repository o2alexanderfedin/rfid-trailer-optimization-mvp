import type {
  BlockKey,
  LoadBlock,
  PlannerConfig,
  PlanningPackage,
} from "@mm/domain";
import { buildLoadBlock, keyId } from "./block.js";
import { deadlineBucket } from "./deadline-bucket.js";
import { splitBlock } from "./split.js";

/**
 * AGG-01 / AGG-02 / AGG-04 — the aggregation entry point.
 *
 * `aggregate`:
 *  1. derives each package's 7-part {@link BlockKey} — crucially RE-DERIVING
 *     `deadlineBucket` from `(deadline, slaClass)` so the bucket is single-sourced
 *     by {@link deadlineBucket}, never trusting any precomputed input field;
 *  2. groups packages by that key (AGG-01);
 *  3. builds a {@link LoadBlock} per group with summed volume/weight, package
 *     count, and an AGG-04 priority (AGG-02 / AGG-04);
 *  4. splits every block so the result is all-feasible (AGG-03);
 *  5. returns the blocks in a STABLE canonical order (sorted by the key string),
 *     never input- or Map-iteration-order dependent.
 *
 * Pure + deterministic: imports only `@mm/domain` (+ sibling pure modules), no
 * wall clock, no RNG — same input ⇒ same output (PITFALLS P3).
 */
export function aggregate(
  packages: readonly PlanningPackage[],
  config: PlannerConfig,
): LoadBlock[] {
  // 1+2) Group by the derived 7-part key. A plain object keyed by the canonical
  // key string gives deterministic grouping; final order comes from a sort, so
  // insertion order never affects the output.
  const groups = new Map<string, { key: BlockKey; members: PlanningPackage[] }>();
  for (const p of packages) {
    const key = deriveKey(p);
    const id = keyId(key);
    const existing = groups.get(id);
    if (existing) {
      existing.members.push(p);
    } else {
      groups.set(id, { key, members: [p] });
    }
  }

  // 3+4) Build a block per group, then split into feasible sub-blocks.
  const feasible: LoadBlock[] = [];
  for (const { key, members } of groups.values()) {
    const block = buildLoadBlock(key, members);
    feasible.push(...splitBlock(block, members, config));
  }

  // 5) Stable canonical order: sort by loadBlockId (which encodes the key + the
  // split suffix), so identical inputs always yield identical ordering.
  return feasible.sort((a, b) =>
    a.loadBlockId < b.loadBlockId ? -1 : a.loadBlockId > b.loadBlockId ? 1 : 0,
  );
}

/**
 * Derive the 7-part block key for a package. `deadlineBucket` is RECOMPUTED from
 * the package's deadline + SLA class — the package's own `deadlineBucket` field
 * is ignored so the bucket has exactly one source of truth.
 */
function deriveKey(p: PlanningPackage): BlockKey {
  return {
    currentHubId: p.currentHubId,
    nextUnloadHubId: p.nextUnloadHubId,
    finalDestHubId: p.finalDestHubId,
    slaClass: p.slaClass,
    deadlineBucket: deadlineBucket(p.deadline, p.slaClass),
    handlingClass: p.handlingClass,
    sizeWeightClass: p.sizeWeightClass,
  };
}
