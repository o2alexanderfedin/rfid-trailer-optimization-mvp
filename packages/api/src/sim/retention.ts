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
 * SAFETY INVARIANT (the watermark rule): we NEVER delete an event whose
 * `global_seq` is STRICTLY ABOVE the projection watermark (`min(last_seq)` across
 * the catch-up projections) — those rows are not yet materialized, so deleting
 * them would lose data. We prune `global_seq <= (watermark - margin)`. With the
 * default `margin > 0` this leaves a cushion of already-projected rows below the
 * watermark; with `margin == 0` the `== watermark` row itself is pruned, which is
 * STILL SAFE: catch-up's `readAll(from)` is EXCLUSIVE (`global_seq > from`) and the
 * checkpoint stores the last APPLIED seq, so an `== watermark` row has already been
 * folded into the projection snapshot and is never re-read at runtime (catch-up
 * resumes from the watermark, not from 0). The Google-consult "watermark +
 * replay-from-0 beats snapshotting" guidance is exactly this design.
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
  // A non-positive cutoff means there is nothing safely prunable yet — keep all.
  if (cutoff <= 0n) return 0;
  const result = await (db as unknown as Kysely<EventsDb>)
    .deleteFrom("events")
    // Prune `global_seq <= cutoff` where `cutoff = watermark - margin <= watermark`.
    // The TRUE invariant: NOTHING with `global_seq > watermark` is ever pruned — so
    // no un-applied event is ever lost. With `margin = 0` the cutoff EQUALS the
    // watermark and the watermark row itself is pruned, which is SAFE: catch-up's
    // `readAll(from)` is EXCLUSIVE (`global_seq > from`) and the checkpoint stores
    // the last APPLIED seq, so the `== watermark` row is already materialized and
    // is never re-read at runtime.
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
