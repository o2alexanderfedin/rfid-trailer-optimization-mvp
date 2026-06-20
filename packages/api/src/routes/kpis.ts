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
import { DEFAULT_TRAILER_CAPACITY } from "../optimizer/twin-snapshot.js";

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
 * - `utilizationFraction`: REAL volume fill ratio (finding #10) — used volume
 *   (`assignedPackageIds.length`, since each package is a unit-volume block) over
 *   the optimizer's true `DEFAULT_TRAILER_CAPACITY` (50), averaged across
 *   trailers. Reuses the optimizer's capacity constant (DRY) so the KPI matches
 *   its real fill basis, not the old `/30` package-count proxy.
 * - on-time departure/arrival: reported as `null` (F-03) — the MVP persists no
 *   scheduled departure/arrival times, so an honest "no data" is surfaced rather
 *   than a fabricated 100%.
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

  // Real volume fill ratio (finding #10): each assigned package is a unit-volume
  // load block (`TwinBlock.volume === 1`, twin-snapshot.ts), so a trailer's used
  // volume equals its assigned-package count and its capacity is the optimizer's
  // real `DEFAULT_TRAILER_CAPACITY` (50 unit blocks). We reuse that SAME constant
  // (DRY) so the KPI matches the optimizer's true fill basis (`Σ vol / capacity`)
  // instead of the old arbitrary `/30` package-count proxy. Averaged across all
  // trailers and clamped to [0,1].
  let totalUtilization = 0;
  for (const row of trailerRows) {
    const pkgIds = row.assigned_package_ids;
    const usedVolume =
      Array.isArray(pkgIds) ? pkgIds.length
      : typeof pkgIds === "string" ? (JSON.parse(pkgIds) as unknown[]).length
      : 0;
    totalUtilization += Math.min(1, usedVolume / DEFAULT_TRAILER_CAPACITY);
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
    // F-03 (HIGH / UI-03): on-time rates are reported as UNAVAILABLE (`null`),
    // NOT a fabricated 100%. The MVP persists no scheduled/planned departure or
    // arrival times (no domain event carries one — see `trailerDepartedSchema` /
    // `trailerArrivedAtHubSchema`), so there is no ground truth to measure
    // "on-time" against. Passing `null` makes `computeKpis` return `null`, and the
    // UI shows "—" instead of a dishonest "always 100% on-time" metric.
    onTimeDepartureCount: null,
    onTimeArrivalCount: null,
    totalDepartureCount: null,
    totalArrivalCount: null,
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
