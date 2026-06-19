import type { DeadlineBucket, SlaClass } from "@mm/domain";

/**
 * AGG / deadline bucketing (tech spec §11.1).
 *
 * {@link deadlineBucket} maps a deadline (ms since a fixed epoch, sourced from
 * event/payload timestamps — NEVER the wall clock) plus the SLA class to a
 * coarse, non-negative INTEGER bucket. Integer bucketing keeps deadlines safe
 * as group/sort keys (PITFALLS P3: no floating-point keys), and a deterministic
 * pure derivation keeps replay byte-identical.
 *
 * The bucket WIDTH is the SLA-class time window: a tighter SLA gets a finer
 * window so urgent deadlines discriminate more (express buckets are ~1h wide),
 * a looser SLA gets a coarser window (economy buckets are a full day wide).
 * Same inputs ⇒ same bucket; a much later deadline ⇒ a strictly larger bucket.
 */

const HOUR_MS = 3_600_000;

/**
 * Per-SLA bucket width in ms. Tighter SLA ⇒ narrower window ⇒ finer buckets.
 * Single-sourced here so the windowing is deterministic and easy to tune.
 */
const SLA_BUCKET_WIDTH_MS: Record<SlaClass, number> = {
  express: 1 * HOUR_MS,
  priority: 4 * HOUR_MS,
  standard: 12 * HOUR_MS,
  economy: 24 * HOUR_MS,
};

/**
 * Coarse, deterministic deadline bucket: `floor(deadlineMs / width(slaClass))`.
 *
 * @param deadlineMs deadline in ms since a fixed epoch (≥ 0, from payload
 *   timestamps — no wall clock).
 * @param slaClass the SLA class whose window sets the bucket width.
 * @returns a non-negative integer bucket.
 */
export function deadlineBucket(
  deadlineMs: number,
  slaClass: SlaClass,
): DeadlineBucket {
  const width = SLA_BUCKET_WIDTH_MS[slaClass];
  return Math.floor(deadlineMs / width);
}
