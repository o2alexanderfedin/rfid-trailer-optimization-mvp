import type { FeasibilityResult } from "@mm/load-planner";

/**
 * `@mm/optimizer` — the weighted-objective + feasibility-gate CONTRACTS (OPT-08).
 *
 * Two Phase-4 disciplines are baked into these types, before any selection logic
 * exists:
 *
 *  - **P2 (feasibility folded into score) stays structurally impossible.** The
 *    objective consumes a {@link PlanMetrics} bag of pure cost numbers and emits
 *    ONE `number`. It has NO {@link FeasibilityResult} parameter — there is no
 *    seam through which a HARD violation could be turned into a (discountable)
 *    cost. A {@link Candidate} carries `metrics` and `feasibility` as two SEPARATE
 *    readonly fields; `selectPlan` gates on feasibility FIRST and only then reads
 *    the objective. The hard gate can never be bought out by a low score.
 *
 *  - **P7 (thrash) gets its objective-side defense.** Every metric is a
 *    deterministic number sourced from the flow/VRPTW/`scorePlan` pipeline (no
 *    clock, no RNG), `churnVsPrevious` anchors a candidate to the prior plan, and
 *    `selectPlan` breaks ties by `planId` lexicographically — so the same inputs
 *    always pick the same winner and never oscillate.
 *
 * The rehandle + utilization terms are sourced from the REUSED Phase-2
 * `scorePlan` ({@link import("@mm/load-planner").ScoreResult}); they are NOT
 * recomputed here (DRY / anti-P1).
 */

/**
 * The per-term weights of the §12 weighted objective — the single source of
 * tuning knobs for plan ranking. All non-negative numbers, supplied by config
 * (defaults in `weights.ts`). Each weight multiplies the same-named
 * {@link PlanMetrics} term in {@link objective}.
 */
export interface ObjectiveWeights {
  /** §12 `milesCost` — weight per route mile. */
  readonly miles: number;
  /** §12 `driverTimeCost` — weight per driver minute. */
  readonly driverTime: number;
  /** §12 `fuelCost` — weight per fuel unit. */
  readonly fuel: number;
  /** §12 `dockWaitCost` — weight per dock-wait minute. */
  readonly dockWait: number;
  /** §12 `handlingTouchCost` — weight per handling/touch op. */
  readonly handling: number;
  /** §12 `rehandleCost` — weight on the REUSED `scorePlan.rehandleScore`. */
  readonly rehandle: number;
  /** §12.2 `lateDeliveryPenalty` — weight per SLA-late minute (class-weighted upstream). */
  readonly slaLateness: number;
  /** §12.1 `lowUtilizationPenalty` — weight on the under-utilization band. */
  readonly lowUtil: number;
  /** §12.1 `overUtilizationPenalty` — weight on the over-utilization band. */
  readonly highUtil: number;
  /** §12 `overCarryPenalty` — weight per over-carried freight unit. */
  readonly overCarry: number;
  /** §12 `trailerImbalancePenalty` — weight on cross-trailer imbalance. */
  readonly imbalance: number;
  /** Anti-P7 `planChurnPenalty` — weight on divergence from the previous plan. */
  readonly churn: number;
  /**
   * OPT-HOS-01 (v1.2 Phase 15) — the SOFT driver-rest weight: multiplies the
   * {@link PlanMetrics.restPenalty} term so plans assigning drivers with FEWER
   * remaining legal drive minutes cost more. OPTIONAL + NEUTRAL-by-default: when
   * absent (or 0) the term contributes EXACTLY 0, so the objective is
   * byte-identical to the pre-Phase-15 objective (the glpk oracle + planner-vs-
   * validator regression guards stay green). This phase is SOFT awareness only —
   * the HARD HOS feasibility gate is Phase 16 (OPT-HOS-02).
   */
  readonly restCost?: number;
}

/**
 * The pure cost metrics of one candidate plan — the numbers the §12 objective
 * weighs. Every field is a non-negative deterministic number sourced from the
 * flow / VRPTW solve or the REUSED `scorePlan` (NEVER the clock / RNG).
 *
 * This bag carries NO feasibility fields (P2): a {@link FeasibilityResult} lives
 * separately on the {@link Candidate}, never inside the metrics the objective
 * sees.
 */
export interface PlanMetrics {
  /** Total route miles. */
  readonly miles: number;
  /** Total driver time, minutes. */
  readonly driverTimeMin: number;
  /** Total fuel consumed, fuel units. */
  readonly fuelUnits: number;
  /** Total dock-wait, minutes. */
  readonly dockWaitMin: number;
  /** Count of handling/touch operations. */
  readonly handlingOps: number;
  /** REUSED `scorePlan.rehandleScore` — NOT recomputed here (DRY). */
  readonly rehandleScore: number;
  /** Total SLA-late minutes (already SLA-class-weighted upstream). */
  readonly slaLatenessMin: number;
  /** Trailer utilization fraction in `[0, 1]` (drives both util bands). */
  readonly utilization: number;
  /** Freight units carried past their intended unload hub (over-carry). */
  readonly overCarryUnits: number;
  /** Cross-trailer load imbalance (e.g. range/σ of utilizations), ≥ 0. */
  readonly imbalance: number;
  /** Divergence from the previous plan (anti-P7 anchor), ≥ 0. */
  readonly churnVsPrevious: number;
  /**
   * OPT-HOS-01 (v1.2 Phase 15) — the SOFT driver-rest penalty: a non-negative
   * integer that RISES as the assigned driver has FEWER remaining legal drive
   * minutes (e.g. `max(0, maxDriveMin − remainingLegalDriveMinutes)`), so a
   * low-on-hours driver is soft-penalized. Sourced deterministically from the
   * Phase-13 `driver_status` projection via the twin (NEVER the clock / RNG).
   * OPTIONAL + NEUTRAL-by-default: absent ⇒ treated as 0, weighted by the
   * (also-defaulting-to-0) {@link ObjectiveWeights.restCost}, so the term is a
   * no-op until the weight is raised — prior plans reproduce byte-identically.
   */
  readonly restPenalty?: number;
}

/**
 * A candidate plan presented to selection: an opaque `planId`, its pure
 * {@link PlanMetrics}, and — kept structurally SEPARATE (P2) — its
 * {@link FeasibilityResult} from the REUSED Phase-2 `validatePlan`. `selectPlan`
 * reads `feasibility` FIRST (the hard gate) and only then the objective over
 * `metrics`; the two are never collapsed into a single value.
 */
export interface Candidate {
  /** Stable id — also the deterministic tie-break key (anti-P7). */
  readonly planId: string;
  /** The pure cost metrics the objective weighs. */
  readonly metrics: PlanMetrics;
  /** The SEPARATE feasibility verdict (Phase-2 `validatePlan` HARD gate). */
  readonly feasibility: FeasibilityResult;
}

/**
 * The per-term contribution breakdown of the objective — the explainability
 * view (each weighted term, plus the `total`). Produced by `objectiveBreakdown`
 * and summed into the single `objective` number, so the two never diverge.
 */
export interface ObjectiveBreakdown {
  readonly miles: number;
  readonly driverTime: number;
  readonly fuel: number;
  readonly dockWait: number;
  readonly handling: number;
  readonly rehandle: number;
  readonly slaLateness: number;
  readonly lowUtil: number;
  readonly highUtil: number;
  readonly overCarry: number;
  readonly imbalance: number;
  readonly churn: number;
  /**
   * OPT-HOS-01 — the weighted SOFT driver-rest contribution (`restPenalty ×
   * restCost`). Always present; exactly 0 in the neutral default case so the
   * breakdown is additive (and the pre-Phase-15 `total` is unchanged when the
   * weight is 0).
   */
  readonly rest: number;
  /** Σ of every weighted term — equals `objective(metrics, weights)`. */
  readonly total: number;
}
