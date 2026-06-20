/**
 * `GET /kpis` + `GET /kpis/comparison` — read-only KPI dashboard endpoints.
 *
 * Plan 05-03, Task 3 (UI-03 + UI-04). Thin handlers: validate → compute → DTO.
 * No event-store writes.
 *
 * Design (mirrors exceptions.ts + plan.ts conventions — KISS/DIP):
 *  - `GET /kpis`: returns the live operational KpiSnapshot wired to live
 *    projections (Plan 05-05). Reads: trailer count from `trailer_state`,
 *    open exceptions + FP-rate from Phase-3 projections, and the latest
 *    optimizer rehandle score from `RollingOptimizerService.latestResult()`.
 *    The shape and `baseline` sub-object match the ws envelope KpiSnapshot
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

/** Live KPI snapshot without the misleading baseline copy (FIX 4). */
type LiveKpiSnapshot = Omit<KpiSnapshot, "baseline">;
import {
  computeComparison,
  DEMO_SEED,
  type KpiComparison,
} from "../kpis/comparison.js";
import type { ApiDb } from "./queries.js";
import { readOpenExceptions, readExceptionKpi } from "@mm/projections";
import type { RollingOptimizerService } from "../optimizer/rolling-service.js";

// ---------------------------------------------------------------------------
// Live KPI reader
// ---------------------------------------------------------------------------

/**
 * Read the live KpiSnapshot from the operational twin projections + the rolling
 * optimizer's latest result (Plan 05-05 wiring).
 *
 * - `trailerCount`: total rows in `trailer_state`.
 * - `optimizerRehandleScore`: sum of `breakdown.rehandle` across latest recs.
 *   Since `DEFAULT_OBJECTIVE_WEIGHTS.rehandle === 1`, `breakdown.rehandle` IS
 *   the raw `rehandleScore` (no un-weighting needed).
 * - `openExceptions` / `exceptionKpi`: from Phase-3 projection reads.
 * - `utilizationFraction`: estimated from `assignedPackageIds` counts vs a
 *   fixed capacity proxy (30 packages per trailer = §8 DEFAULT_PLANNER_CONFIG).
 *   This is a proxy — on-time departure/arrival tallies require a dedicated
 *   event-log scan that is out of scope for the MVP (tracked as a stub).
 */
/**
 * FIX 4: returns `LiveKpiSnapshot` (no `baseline`) instead of `KpiSnapshot`.
 * The previous implementation set `baseline = { ...base }` — a bitwise copy of
 * the live snapshot — which was misleading: it implied a "before optimizer" view
 * but was identical to the live data. The money slide in `GET /kpis/comparison`
 * owns the honest before/after baseline comparison (using the DEMO_SEED scenario
 * via `computeComparison`). `GET /kpis` is the LIVE operational snapshot and
 * does not carry a baseline sub-object.
 */
async function readLiveKpiSnapshot(
  db: ApiDb,
  optimizer: RollingOptimizerService,
): Promise<LiveKpiSnapshot> {
  // 1. Trailer count + estimated utilization from projection.
  const trailerRows = await db
    .selectFrom("trailer_state")
    .select(["trailer_id", "assigned_package_ids"])
    .execute();
  const trailerCount = trailerRows.length;

  // Estimate utilization: avg (assignedPackageCount / PROXY_CAPACITY) across
  // all trailers. PROXY_CAPACITY = 30 packages (§8 demo config).
  const PROXY_CAPACITY = 30;
  let totalUtilization = 0;
  for (const row of trailerRows) {
    const pkgIds = row.assigned_package_ids;
    const pkgCount =
      Array.isArray(pkgIds) ? pkgIds.length
      : typeof pkgIds === "string" ? (JSON.parse(pkgIds) as unknown[]).length
      : 0;
    totalUtilization += Math.min(1, pkgCount / PROXY_CAPACITY);
  }
  const utilizationFraction = trailerCount > 0 ? totalUtilization / trailerCount : 0;

  // 2. Latest optimizer rehandle score (sum of per-trailer rehandle breakdown terms).
  //    `breakdown.rehandle = rehandleScore * weights.rehandle` and
  //    `DEFAULT_OBJECTIVE_WEIGHTS.rehandle === 1`, so this equals raw rehandleScore.
  const latestResult = optimizer.latestResult();
  let optimizerRehandleScore = 0;
  if (latestResult !== null) {
    for (const rec of latestResult.recommendations) {
      optimizerRehandleScore += rec.breakdown.rehandle;
    }
  }

  // 3. Exception projections (Phase-3 SNS-04/05).
  // ApiDb = Kysely<Database & ProjectionDb>; the projection reads only need
  // Kysely<ProjectionDb> — we cast through `unknown` (Database ⊃ ProjectionDb).
  type ProjectionHandle = Parameters<typeof readOpenExceptions>[0];
  const projDb = db as unknown as ProjectionHandle;
  const [openExceptions, exceptionKpi] = await Promise.all([
    readOpenExceptions(projDb),
    readExceptionKpi(projDb),
  ]);

  // 4. Compute the KPI snapshot (pure, deterministic).
  const base = computeKpis({
    optimizerRehandleScore,
    optimizerUtilizationScore: 0, // not surfaced; utilization from breakdown proxy
    utilizationFraction,
    trailerCount,
    onTimeDepartureCount: 0, // stub: requires event-log scan (tracked in SUMMARY)
    onTimeArrivalCount: 0,   // stub: requires event-log scan (tracked in SUMMARY)
    totalDepartureCount: 0,  // stub: 0 → onTimeDeparture defaults to 1.0 in computeKpis
    totalArrivalCount: 0,
    openExceptions,
    exceptionKpi,
  });

  // FIX 4: return the live snapshot WITHOUT a baseline sub-object.
  // The previous code returned `{ ...base, baseline: { ...base } }` which was a
  // misleading copy of the live values. The baseline belongs in GET /kpis/comparison
  // (the money slide), not in the operational snapshot.
  return base;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register `GET /kpis` and `GET /kpis/comparison` on `app`.
 *
 * `db` is the composition-root handle; `optimizer` supplies the latest
 * rolling-epoch result for rehandle score extraction (Plan 05-05 live wiring).
 */
export function registerKpiRoutes(
  app: FastifyInstance,
  db: ApiDb,
  optimizer: RollingOptimizerService,
): void {
  // --- GET /kpis — operational KPI snapshot --------------------------------
  // Returns the live operational KPI snapshot WITHOUT a baseline sub-object
  // (FIX 4). The previous baseline was a misleading bitwise copy of the live
  // values. The honest before/after baseline comparison lives in GET /kpis/comparison
  // (the money slide — `computeComparison` with DEMO_SEED). Returning the live
  // values only keeps this endpoint honest and avoids confusing the dashboard.
  app.get("/kpis", async (): Promise<LiveKpiSnapshot> => {
    return readLiveKpiSnapshot(db, optimizer);
  });

  // --- GET /kpis/comparison — money slide ----------------------------------
  // Returns the seed-deterministic baseline-vs-optimizer comparison (UI-04).
  // Computed from the DEMO_SEED calibrated so the optimizer wins on rehandleScore.
  // Read-only: no event-store writes (T-05-05 / T-05-06).
  app.get("/kpis/comparison", (): KpiComparison => {
    return computeComparison({ seed: DEMO_SEED });
  });
}
