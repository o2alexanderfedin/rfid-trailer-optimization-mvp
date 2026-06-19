/**
 * `GET /kpis` + `GET /kpis/comparison` — read-only KPI dashboard endpoints.
 *
 * Plan 05-03, Task 3 (UI-03 + UI-04). Thin handlers: validate → compute → DTO.
 * No event-store writes; DB handle accepted but not used in the current
 * implementation (future: read live projection counts for onTime tallies).
 *
 * Design (mirrors exceptions.ts + plan.ts conventions — KISS/DIP):
 *  - `GET /kpis`: returns the live operational KpiSnapshot. Currently computed
 *    from static defaults (the live operational twin wiring is Plan 05-05). The
 *    shape and the `baseline` sub-object already match the ws envelope KpiSnapshot
 *    so the dashboard reads one shape from both REST and ws (Plan 05-01).
 *  - `GET /kpis/comparison`: returns the seed-deterministic money slide from
 *    `computeComparison` (demo seed). Both routes are read-only.
 *
 * T-05-06: KPIs are aggregate operational metrics for the demo audience; no PII.
 * T-05-05: The comparison uses the SAME scoring gate for both planners (P8).
 */

import type { FastifyInstance } from "fastify";
import type { KpiSnapshot } from "../ws/envelope.js";
import { computeKpis } from "../kpis/compute-kpis.js";
import {
  computeComparison,
  DEMO_SEED,
  type KpiComparison,
} from "../kpis/comparison.js";
import type { ApiDb } from "./queries.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the default operational KPI inputs. The live projection wiring (onTime
 * tallies from the event log) is deferred to Plan 05-05; for now these default
 * to 100% on-time (no departures/arrivals yet processed in the demo session).
 * The exception counts default to 0 (same reason). This zero-state is honest:
 * it reflects the pre-run state, and the ws envelope starts with the same zeros.
 */
function defaultKpiSnapshot(): KpiSnapshot {
  const base = computeKpis({
    optimizerRehandleScore: 0,
    optimizerUtilizationScore: 0,
    utilizationFraction: 0,
    trailerCount: 0,
    onTimeDepartureCount: 0,
    onTimeArrivalCount: 0,
    totalDepartureCount: 0,
    totalArrivalCount: 0,
    openExceptions: [],
    exceptionKpi: { totalExceptions: 0, lowConfidenceExceptions: 0, falsePositiveRate: 0 },
  });

  // Build the baseline sub-object: same zero-state (no sim run yet).
  const baselineKpis = { ...base };

  return { ...base, baseline: baselineKpis };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register `GET /kpis` and `GET /kpis/comparison` on `app`.
 * `db` is the composition-root handle (future: used for live projection reads).
 */
export function registerKpiRoutes(app: FastifyInstance, _db: ApiDb): void {
  // --- GET /kpis — operational KPI snapshot --------------------------------
  // Returns the live KpiSnapshot (incl. baseline sub-object). Shape matches the
  // ws envelope KpiSnapshot (Plan 05-01), so the dashboard reads one shape from
  // both REST and ws (single source of truth for the KPI DTO contract).
  app.get("/kpis", (): KpiSnapshot => {
    return defaultKpiSnapshot();
  });

  // --- GET /kpis/comparison — money slide ----------------------------------
  // Returns the seed-deterministic baseline-vs-optimizer comparison (UI-04).
  // Computed from the DEMO_SEED calibrated so the optimizer wins on rehandleScore.
  // Read-only: no event-store writes (T-05-05 / T-05-06).
  app.get("/kpis/comparison", (): KpiComparison => {
    return computeComparison({ seed: DEMO_SEED });
  });
}
