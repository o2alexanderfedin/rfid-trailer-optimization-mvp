/**
 * `computeKpis` — Pure KPI computation from plan scores + exception counts.
 *
 * Plan 05-03, Task 1.
 *
 * Reuses Phase-2 scoring plumbing (P8): rehandleScore / utilizationScore are NOT
 * re-derived here — the caller passes the already-computed ScoreResult from
 * `scorePlan`. This keeps the scoring gate single-sourced and the before/after
 * comparison honest (T-05-05).
 *
 * Deterministic (P3): no Date.now(), no Math.random(), fixed rounding rules,
 * sorted iteration. Same inputs ⇒ identical KpiSnapshot.
 *
 * Shape contract: the returned `Omit<KpiSnapshot,"baseline">` MUST match the ws
 * envelope's KpiSnapshot fields (Plan 05-01 / envelope.ts). Both shapes are
 * structurally identical so this file is the single implementation; the envelope
 * type is the contract and the tests enforce structural assignability.
 */

import type { KpiSnapshot } from "../ws/envelope.js";
import type { OpenException, ExceptionKpiSnapshot } from "@mm/projections";

// ---------------------------------------------------------------------------
// Public input type
// ---------------------------------------------------------------------------

/**
 * All inputs needed to compute one KPI snapshot. The caller (route handler or
 * comparison function) provides pre-computed values from the scoring plumbing and
 * the live projection read models — `computeKpis` is a pure aggregation function.
 */
export interface KpiInput {
  /**
   * Rehandle cost in minutes from `scorePlan(...).rehandleScore` (Phase-2 P8).
   * This IS the scoring output — `computeKpis` does NOT re-derive it.
   */
  readonly optimizerRehandleScore: number;
  /**
   * Utilization penalty from `scorePlan(...).utilizationScore` (Phase-2 P8).
   * Kept for completeness / future use; not directly surfaced as a KPI field.
   */
  readonly optimizerUtilizationScore: number;
  /**
   * Actual utilization fraction [0,1] (usedVolume / capacityVolume across all
   * plan slices). Provided separately so the API can surface the human-readable
   * fill ratio rather than the quadratic penalty score.
   */
  readonly utilizationFraction: number;
  /** Total trailer count in the network. */
  readonly trailerCount: number;
  /** Trailers that departed on time this window. */
  readonly onTimeDepartureCount: number;
  /** Trailers that arrived on time this window. */
  readonly onTimeArrivalCount: number;
  /** Total trailers that departed in this window (denominator). */
  readonly totalDepartureCount: number;
  /** Total trailers that arrived in this window (denominator). */
  readonly totalArrivalCount: number;
  /**
   * Live open exceptions from Phase-3 `readOpenExceptions`.
   * Drives wrongTrailerCount / missedUnloadCount by filtering on `kind`.
   */
  readonly openExceptions: readonly OpenException[];
  /**
   * Exception KPI snapshot from Phase-3 `readExceptionKpi`.
   * The `falsePositiveRate` drives the `slaViolationRate` KPI.
   */
  readonly exceptionKpi: ExceptionKpiSnapshot;
}

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

/**
 * Compute the operational KPI set from scoring outputs + exception projection rows.
 *
 * All rates are in [0,1]; all counts are non-negative integers; minutes are the
 * raw cost from Phase-2 scoring (single-sourced, P8).
 *
 * Determinism contract (P3): pure function, fixed arithmetic, no wall clock, no
 * RNG, no iteration over unordered structures (exception counts are independent
 * of order).
 */
export function computeKpis(input: KpiInput): Omit<KpiSnapshot, "baseline"> {
  const {
    optimizerRehandleScore,
    utilizationFraction,
    onTimeDepartureCount,
    onTimeArrivalCount,
    totalDepartureCount,
    totalArrivalCount,
    openExceptions,
    exceptionKpi,
  } = input;

  // --- Exception counts (from Phase-3 read model, P8 reuse) -----------------
  let wrongTrailerCount = 0;
  let missedUnloadCount = 0;
  for (const ex of openExceptions) {
    if (ex.kind === "wrong-trailer") wrongTrailerCount += 1;
    else if (ex.kind === "missed-unload") missedUnloadCount += 1;
  }

  // --- Rehandle (from Phase-2 scoring, P8 reuse) ---------------------------
  // rehandleScore IS the cost in minutes (§7.5 formula). We expose it in two
  // forms: the raw minutes total, and a normalized count (integer operations).
  // The count is the cost divided by the per-operation penalty floor (1 minute
  // per blocker operation) — floors to an integer so it is a stable key.
  const rehandleMinutes = round2(optimizerRehandleScore);
  // Count: each unit of cost represents at least one unload-reload operation;
  // 0 score ⇒ 0 operations, positive score ⇒ ceil of score (at minimum 1 per
  // operation cycle — the unloadReloadMin from the config is the floor).
  const rehandleCount = optimizerRehandleScore > 0 ? Math.max(1, Math.floor(optimizerRehandleScore)) : 0;

  // --- On-time ratios -------------------------------------------------------
  const onTimeDeparture =
    totalDepartureCount > 0
      ? round4(onTimeDepartureCount / totalDepartureCount)
      : 1;
  const onTimeArrival =
    totalArrivalCount > 0
      ? round4(onTimeArrivalCount / totalArrivalCount)
      : 1;

  // --- SLA violation rate ---------------------------------------------------
  // The false-positive rate from the exception KPI serves as the SLA violation
  // signal: a high FP rate means the sensor/detector is flagging edge cases as
  // violations; the rate is already in [0,1] from Phase-3.
  const slaViolationRate = round4(exceptionKpi.falsePositiveRate);

  // --- Utilization ----------------------------------------------------------
  // The human-readable fill ratio (not the quadratic penalty score).
  const utilization = round4(Math.min(1, Math.max(0, utilizationFraction)));

  return {
    utilization,
    rehandleCount,
    rehandleMinutes,
    wrongTrailerCount,
    missedUnloadCount,
    slaViolationRate,
    onTimeDeparture,
    onTimeArrival,
  };
}

// ---------------------------------------------------------------------------
// Fixed-rounding helpers (determinism: no variable precision)
// ---------------------------------------------------------------------------

/** Round to 2 decimal places (minutes). */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Round to 4 decimal places (rates/fractions). */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
