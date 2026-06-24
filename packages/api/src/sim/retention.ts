import { sql, type Kysely } from "kysely";
import type { ApiDb } from "../routes/queries.js";

/**
 * Plan 19-08 Task C — BOUNDED PERSISTED RETENTION for the continuous-operation
 * path (CONT-04, expanded to bounded END-TO-END, not just RAM).
 *
 * Over a genuinely indefinite run the Postgres `events` log and the projection
 * tables would grow without bound. This module bounds BOTH — but ONLY on the
 * opt-in continuous path. The finite/test path passes NO retention config, so the
 * full log is retained and replay-from-0 stays byte-identical (a guard test
 * asserts the finite path never reads a pruned log).
 *
 * SAFETY INVARIANT (the watermark rule): we NEVER delete an event at or above the
 * projection watermark (`min(last_seq)` across the catch-up projections). Those
 * rows are not yet materialized into the projections, so deleting them would lose
 * data. Pruning is safe ONLY for rows strictly BELOW `(watermark - margin)`: those
 * are already folded into the projection snapshot and are never replayed at
 * runtime (catch-up resumes from the watermark, not from 0). The Google-consult
 * "watermark + replay-from-0 beats snapshotting" guidance is exactly this design.
 */

/** Tuning knobs for the continuous-path retention sweep. */
export interface RetentionConfig {
  /**
   * Run the retention sweep every N DRAINED ticks. A larger value amortizes the
   * DELETE cost; a smaller value keeps the log tighter. Must be >= 1.
   */
  readonly everyTicks: number;
  /**
   * Keep this many of the most-recent already-projected events BELOW the
   * watermark (a safety cushion so a slightly-lagging reader/debug query still
   * finds recent context). Pruning targets `global_seq <= watermark - margin`.
   * Must be >= 0.
   */
  readonly retentionMargin: number;
  /**
   * Projection age-out horizon in SIM milliseconds. Projection rows whose last
   * activity is older than `simMs - staleHorizonMs` are purged (stale). Pass a
   * generous horizon so only genuinely inactive entities are aged out. Must be
   * > 0 for projection age-out to run (0/absent ⇒ projection age-out is skipped).
   */
  readonly staleHorizonMs: number;
}

/** The catch-up projections whose checkpoints define the safe-prune watermark. */
const CATCHUP_PROJECTIONS = ["audit-timeline", "geo-track"] as const;

/**
 * The projection watermark: the MINIMUM `last_seq` across all catch-up
 * projections (the highest global_seq EVERY projection has already applied).
 * Events at or above this are NOT yet fully projected, so they are never pruned.
 * Returns `0n` when any projection has no checkpoint yet (⇒ nothing is prunable).
 */
export async function projectionWatermark(db: ApiDb): Promise<bigint> {
  const rows = await (db as unknown as Kysely<CheckpointDb>)
    .selectFrom("projection_checkpoints")
    .select(["projection", "last_seq"])
    .where("projection", "in", [...CATCHUP_PROJECTIONS])
    .execute();
  // If any expected projection is missing a checkpoint, treat the watermark as 0
  // (nothing is safely prunable yet — every event may still be needed).
  if (rows.length < CATCHUP_PROJECTIONS.length) return 0n;
  let min: bigint | undefined;
  for (const r of rows) {
    const seq = BigInt(r.last_seq);
    if (min === undefined || seq < min) min = seq;
  }
  return min ?? 0n;
}

/**
 * Prune fully-projected events from the `events` log. Deletes rows with
 * `global_seq <= (watermark - retentionMargin)` — NEVER at or above the
 * watermark. Returns the number of rows deleted (0 when nothing is safely
 * prunable). The continuous driver calls this on the configured cadence.
 */
export async function pruneEventLog(
  db: ApiDb,
  config: RetentionConfig,
): Promise<number> {
  const watermark = await projectionWatermark(db);
  const margin = BigInt(Math.max(0, Math.floor(config.retentionMargin)));
  const cutoff = watermark - margin;
  // Nothing below `watermark - margin` to prune (and we must never touch
  // `>= watermark`): a non-positive cutoff means keep everything for now.
  if (cutoff <= 0n) return 0;
  const result = await (db as unknown as Kysely<EventsDb>)
    .deleteFrom("events")
    // STRICTLY `<= cutoff` and `cutoff < watermark` (margin >= 0), so the watermark
    // row and everything above it is always retained (the safety invariant).
    .where("global_seq", "<=", sql<string>`${cutoff.toString()}`)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}

/**
 * Age out STALE projection rows whose last activity is older than the configured
 * horizon (in SIM time). Bounds the projection tables in a delivery-less Phase-19
 * run. Designed generic so Phase 22's `PackageDelivered` purge composes with it
 * (delivery would set the row inactive; this sweep removes long-inactive rows).
 * Returns the total rows aged out across the targeted tables.
 */
export async function ageStaleProjections(
  db: ApiDb,
  config: RetentionConfig,
  simMs: number,
): Promise<number> {
  const horizonMs = Math.floor(config.staleHorizonMs);
  if (horizonMs <= 0 || !Number.isFinite(simMs)) return 0;
  const cutoffIso = new Date(simMs - horizonMs).toISOString();
  const pdb = db as unknown as Kysely<ProjectionRetentionDb>;
  let total = 0;
  // package_location: a per-package row, keyed by `last_seen_at`.
  const loc = await pdb
    .deleteFrom("package_location")
    .where("last_seen_at", "<", cutoffIso)
    .executeTakeFirst();
  total += Number(loc.numDeletedRows ?? 0n);
  // zone_estimate: per (package, trailer), keyed by `last_observed_at`.
  const zone = await pdb
    .deleteFrom("zone_estimate")
    .where("last_observed_at", "<", cutoffIso)
    .executeTakeFirst();
  total += Number(zone.numDeletedRows ?? 0n);
  return total;
}

// ---------------------------------------------------------------------------
// Minimal Kysely table shapes (this module only needs these columns).
// ---------------------------------------------------------------------------

interface CheckpointDb {
  projection_checkpoints: { projection: string; last_seq: string };
}
interface EventsDb {
  events: { global_seq: string };
}
interface ProjectionRetentionDb {
  package_location: { package_id: string; last_seen_at: string };
  zone_estimate: { package_id: string; trailer_id: string; last_observed_at: string };
}
