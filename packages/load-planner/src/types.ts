import type { TrailerSlice } from "@mm/domain";

/**
 * `@mm/load-planner` — shared type contracts (the interface-first foundation).
 *
 * Two disciplines are baked into the type system here, before any planner or
 * scoring logic exists:
 *
 *  - **P1 (inverted LIFO) vocabulary is single-sourced.** A {@link Placement}
 *    carries exactly the two axes the canonical invariant relates — `depth`
 *    (0 = rear, increasing toward the nose) and `unloadOrder` (lower = unloaded
 *    sooner). The invariant `unloadOrder(A) < unloadOrder(B) ⟹ depth(A) ≤
 *    depth(B)` is stated in ONE module (`lifo-invariant.ts`) over this shape and
 *    never re-stated divergently.
 *
 *  - **P2 (feasibility folded into score) is structurally impossible.**
 *    {@link FeasibilityResult} (`{ hardViolations, softViolations }`) and
 *    {@link ScoreResult} (`{ rehandleScore, utilizationScore }`) are DISTINCT,
 *    non-overlapping types. There is no single object that carries both, so the
 *    hard feasibility gate can never be silently bought out by a low score
 *    (T-02-08).
 *
 * This module is pure: it imports only `@mm/domain` and has no runtime values
 * (types only) — no clock, no RNG.
 */

/**
 * A single placed load block, reduced to the two axes the canonical LIFO
 * invariant relates.
 *
 *  - `depth`: the trailer slice depth the block sits at. **0 = rear** (the door,
 *    easiest access); depth increases toward the nose. Single-sourced with
 *    {@link TrailerSlice.depth}.
 *  - `unloadOrder`: the block's position in the remaining route — the
 *    `stopIndex` of its next-unload hub. **Lower = unloaded sooner** ⇒ belongs
 *    nearer the rear.
 */
export interface Placement {
  readonly loadBlockId: string;
  readonly depth: number;
  readonly unloadOrder: number;
}

/**
 * A complete load plan for one trailer: its rear-to-nose {@link TrailerSlice}
 * sequence (depth 0 = rear) and the {@link Placement} of every block. The
 * canonical invariant and the independent validator both read `placements`;
 * the validator additionally re-derives from `slices` (never trusting the
 * planner's bookkeeping).
 */
export interface LoadPlan {
  readonly trailerId: string;
  readonly slices: readonly TrailerSlice[];
  readonly placements: readonly Placement[];
}

/** The kind of feasibility violation. Only accessibility (LIFO) exists in Phase 2. */
export type ViolationKind = "accessibility";

/**
 * The severity of a violation. `HARD` ⇒ the plan is infeasible (the gate
 * rejects it); `SOFT` ⇒ tolerated partial-LIFO, carried as a rehandle cost.
 * This is the HARD/SOFT distinction, NOT a score.
 */
export type ViolationSeverity = "HARD" | "SOFT";

/**
 * One accessibility violation against a placed block: how many later-unload
 * blocks sit in front of it (closer to the rear), and whether that count
 * crosses the `maxAllowedBlockers` hard gate.
 */
export interface Violation {
  readonly loadBlockId: string;
  readonly kind: ViolationKind;
  readonly blockerCount: number;
  readonly severity: ViolationSeverity;
  readonly detail: string;
}

/**
 * The feasibility output of validation (the HARD gate). Kept structurally
 * SEPARATE from {@link ScoreResult} so feasibility can never be folded into the
 * optimization score (P2). A plan is feasible ⟺ `hardViolations` is empty.
 */
export interface FeasibilityResult {
  readonly hardViolations: readonly Violation[];
  readonly softViolations: readonly Violation[];
}

/**
 * The soft scoring output (computed only AFTER the feasibility gate passes).
 * Kept structurally SEPARATE from {@link FeasibilityResult} (P2). Carries no
 * violation fields — a low score can never short-circuit the hard gate.
 */
export interface ScoreResult {
  readonly rehandleScore: number;
  readonly utilizationScore: number;
}
