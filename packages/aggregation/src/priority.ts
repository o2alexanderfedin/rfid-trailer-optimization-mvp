import { type SlaClass, SLA_CLASS_WEIGHT } from "@mm/domain";

/**
 * AGG-04 / block priority.
 *
 * Priority is LEXICOGRAPHIC: SLA-class weight DESCENDING first, then earliest
 * deadline ASCENDING. The two axes are folded into ONE comparable number so the
 * aggregator can store `block.priority` and any consumer can sort by it:
 *
 *   priority = SLA_CLASS_WEIGHT[slaClass] - deadlineFraction
 *
 * where `deadlineFraction ∈ [0, 1)` is a strictly-increasing bounded map of the
 * deadline. Because the SLA weights are integers spaced by ≥ 1 and the deadline
 * term is strictly < 1, a higher SLA weight ALWAYS outranks any deadline — SLA
 * dominance can never be bought out by a sooner deadline (the lexicographic
 * guarantee AGG-04 requires). Within an equal SLA class, a smaller (earlier)
 * deadline subtracts less ⇒ a higher priority.
 *
 * Pure + deterministic: no wall clock, no RNG; same inputs ⇒ same number.
 */

/**
 * The minimal structural input priority needs. `LoadBlock` (domain) carries no
 * deadline, so the aggregator passes the block's SLA class plus its
 * representative (earliest) deadline — the two AGG-04 axes, nothing more.
 */
export interface PrioritizableBlock {
  readonly slaClass: SlaClass;
  /** Representative (earliest) deadline of the block, ms since a fixed epoch. */
  readonly deadline: number;
}

/**
 * Scale (ms) for the bounded deadline term. `d / (d + SCALE)` maps any
 * non-negative deadline into `[0, 1)` while staying strictly increasing in `d`,
 * so the term never reaches 1 and never crosses an integer SLA-weight boundary.
 */
const DEADLINE_SCALE_MS = 1_000_000_000;

/**
 * AGG-04 lexicographic priority as a single comparable number (higher = served
 * sooner). SLA weight dominates; earlier deadline is the within-class tiebreak.
 */
export function blockPriority(block: PrioritizableBlock): number {
  const slaWeight = SLA_CLASS_WEIGHT[block.slaClass];
  // Clamp to ≥ 0 defensively; deadlines are non-negative by the domain schema.
  const d = block.deadline > 0 ? block.deadline : 0;
  const deadlineFraction = d / (d + DEADLINE_SCALE_MS); // ∈ [0, 1)
  return slaWeight - deadlineFraction;
}
