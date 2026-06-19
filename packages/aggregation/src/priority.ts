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
 * where `deadlineFraction ∈ [0, 1)` is a strictly-increasing, LINEAR map of the
 * deadline over a fixed horizon (`d / HORIZON`, capped just below 1). Linear (not
 * the old asymptotic `d / (d + scale)`) so precision is uniform across the whole
 * range — close far-future deadlines stay distinguishable instead of collapsing
 * to a tie (L3). Because the SLA weights are integers spaced by ≥ 1 and the
 * deadline term is strictly < 1, a higher SLA weight ALWAYS outranks any deadline
 * — SLA dominance can never be bought out by a sooner deadline (the lexicographic
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
 * The deadline horizon (ms since the fixed epoch) the bounded deadline term
 * normalizes against — `Date.UTC(3000, 0, 1)`, comfortably beyond any realistic
 * MVP deadline. A LINEAR map `d / HORIZON` (rather than the asymptotic
 * `d / (d + scale)`) keeps the term's precision UNIFORM across the whole range:
 * the old fold crowded large deadlines toward 1, so sub-millisecond differences
 * at realistic far-future deadlines (~year 2040+) collapsed to a tie (L3). The
 * linear map distinguishes deadlines down to ~0.01 ms anywhere in the horizon.
 */
const DEADLINE_HORIZON_MS = Date.UTC(3000, 0, 1);

/**
 * Keep the deadline term STRICTLY below 1 (so it can never reach an integer
 * SLA-weight boundary): the largest representable double < 1. A deadline at the
 * full horizon maps to this, never to exactly 1.
 */
const MAX_FRACTION = 1 - Number.EPSILON;

/**
 * AGG-04 lexicographic priority as a single comparable number (higher = served
 * sooner). SLA weight dominates; earlier deadline is the within-class tiebreak.
 */
export function blockPriority(block: PrioritizableBlock): number {
  const slaWeight = SLA_CLASS_WEIGHT[block.slaClass];
  // Clamp to ≥ 0 defensively; deadlines are non-negative by the domain schema.
  const d = block.deadline > 0 ? block.deadline : 0;
  // Linear normalization into [0, 1): uniform precision, so two close deadlines
  // stay distinguishable. Deadlines past the horizon clamp to MAX_FRACTION
  // (documented edge — they all rank equal-latest, never crossing the SLA tier).
  const deadlineFraction = Math.min(d / DEADLINE_HORIZON_MS, 1) * MAX_FRACTION;
  return slaWeight - deadlineFraction;
}
