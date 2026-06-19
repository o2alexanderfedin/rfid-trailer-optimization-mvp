import type { BlockKey, LoadBlock, PlanningPackage } from "@mm/domain";
import { blockPriority } from "./priority.js";

/**
 * Shared block-construction helpers (DRY) used by both `aggregate` and
 * `splitBlock`. Everything here is PURE and deterministic — `LoadBlock`
 * aggregates are always recomputed from the member packages so a block can
 * never carry an inconsistent total/count past this boundary.
 */

/** Field order is fixed so the canonical tuple is stable and replay-safe. */
const KEY_FIELDS = [
  "currentHubId",
  "nextUnloadHubId",
  "finalDestHubId",
  "slaClass",
  "deadlineBucket",
  "handlingClass",
  "sizeWeightClass",
] as const;

/**
 * A canonical, COLLISION-SAFE string for a {@link BlockKey}. Used as both the
 * deterministic `loadBlockId` and the stable group/sort key.
 *
 * The hub-id fields are arbitrary `z.string().min(1)` values, so they may
 * contain ANY character — a plain delimiter join would let distinct keys alias
 * whenever a field embeds the delimiter (e.g. `"A|B" + "C"` vs `"A" + "B|C"`,
 * L4). We instead JSON-encode the ordered field tuple: every string field is
 * quoted and escaped, so field boundaries are unambiguous and two keys share an
 * id IFF every field is equal. The field ORDER is fixed ({@link KEY_FIELDS}), so
 * the encoding is deterministic and replay-safe (PITFALLS P3).
 */
export function keyId(key: BlockKey): string {
  return JSON.stringify(KEY_FIELDS.map((f) => key[f]));
}

/**
 * Build a `LoadBlock` for one group of packages sharing `key`. Aggregates are
 * summed from members; `packageIds` are sorted for stable output; priority is
 * AGG-04 (SLA weight desc, then the block's EARLIEST member deadline asc).
 *
 * @param key the shared 7-part block key.
 * @param packages the block's member packages (non-empty).
 * @param idSuffix optional suffix to keep split sub-block ids unique.
 */
export function buildLoadBlock(
  key: BlockKey,
  packages: readonly PlanningPackage[],
  idSuffix = "",
): LoadBlock {
  const packageIds = packages.map((p) => p.packageId).sort();
  const totalVolume = packages.reduce((s, p) => s + p.volume, 0);
  const totalWeight = packages.reduce((s, p) => s + p.weight, 0);
  const earliestDeadline = packages.reduce(
    (min, p) => (p.deadline < min ? p.deadline : min),
    packages[0]!.deadline,
  );
  return {
    loadBlockId: `LB-${keyId(key)}${idSuffix}`,
    key,
    packageIds,
    packageCount: packageIds.length,
    totalVolume,
    totalWeight,
    priority: blockPriority({ slaClass: key.slaClass, deadline: earliestDeadline }),
  };
}
