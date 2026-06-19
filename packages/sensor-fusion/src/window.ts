import type { RfidObserved } from "@mm/domain";
import type { FusionConfig, ReaderType } from "./config.js";

/**
 * A single raw RFID read fed to the fusion engine.
 *
 * It carries the zone-relevant fields of `@mm/domain`'s {@link RfidObserved}
 * payload (`tagId`, `readerId`, `antennaId`, `rssi`, `trailerId`, `hubId`), plus
 * the metadata the PURE engine needs but the domain envelope keeps at the
 * persistence boundary: an EXPLICIT `observedAt` (ISO-8601 — the engine reads no
 * wall clock), a `dwellWindowId` (the caller's 2–3s aggregation bucket), and the
 * `readerType` reliability class. `perReadConfidence` mirrors the event's
 * bounded `confidence` and is reserved for callers that pre-fuse upstream.
 *
 * Pairing the payload with caller-supplied time/window keeps the module pure and
 * fully deterministic: same reads ⇒ same observations (anti-repudiation, T-03-06).
 */
export interface RfidRead {
  readonly tagId: RfidObserved["payload"]["tagId"];
  readonly readerId: RfidObserved["payload"]["readerId"];
  readonly antennaId: RfidObserved["payload"]["antennaId"];
  readonly rssi: RfidObserved["payload"]["rssi"];
  readonly trailerId: RfidObserved["payload"]["trailerId"];
  readonly hubId: RfidObserved["payload"]["hubId"];
  /** The reader/antenna reliability class (selects its likelihood weight). */
  readonly readerType: ReaderType;
  /** The caller's dwell-window bucket id (the 2–3s aggregation window). */
  readonly dwellWindowId: string;
  /** EXPLICIT observation time (ISO-8601). The engine never reads a clock. */
  readonly observedAt: string;
  /** The read's own bounded confidence (mirrors `RfidObserved.confidence`). */
  readonly perReadConfidence: number;
}

/**
 * ONE aggregated observation per `(tagId, readerId, dwellWindowId)` group — the
 * anti-P5b collapse. A burst of N dependent reads becomes a SINGLE evidence
 * packet, not N independent Bayesian updates.
 *
 *  - `aggregatedRssi` — the 90th-PERCENTILE of the group's RSSI (NOT the mean;
 *    multipath drops skew the mean, per the AI Mode consult).
 *  - `readCount` — the read-rate density: how many raw reads collapsed here. The
 *    fusion step factors this as a SATURATING weight (high RSSI w/ 1 read <
 *    moderate RSSI w/ 40 reads), but the per-window likelihood stays bounded by
 *    `maxLikelihood` regardless of `readCount`.
 *  - `lastObservedAt` — the max `observedAt` in the group (the freshness clock).
 */
export interface WindowedObservation {
  readonly tagId: string;
  readonly readerId: string;
  readonly dwellWindowId: string;
  readonly antennaId: string;
  readonly trailerId: string;
  readonly hubId: string;
  readonly readerType: ReaderType;
  readonly aggregatedRssi: number;
  readonly readCount: number;
  readonly lastObservedAt: string;
}

/**
 * Collapse raw reads into one {@link WindowedObservation} per
 * `(tagId, readerId, dwellWindowId)` (anti-P5b). Aggregates RSSI by the
 * 90th-percentile, counts the reads (density), and emits the groups in a
 * DETERMINISTIC, key-sorted order (no `Map`-iteration-order dependence).
 *
 * Pure: no clock, no RNG; same reads ⇒ same observations.
 */
export function windowObservations(
  reads: readonly RfidRead[],
  config: FusionConfig,
): readonly WindowedObservation[] {
  const groups = new Map<string, RfidRead[]>();
  for (const r of reads) {
    const key = groupKey(r.tagId, r.readerId, r.dwellWindowId);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [r]);
    } else {
      bucket.push(r);
    }
  }

  const observations: WindowedObservation[] = [];
  // Deterministic emission: sort group keys lexicographically.
  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const bucket = groups.get(key);
    if (bucket === undefined || bucket.length === 0) continue;
    const head = bucket[0];
    if (head === undefined) continue;

    const rssis = bucket.map((r) => r.rssi);
    const lastObservedAt = bucket.reduce(
      (max, r) => (r.observedAt > max ? r.observedAt : max),
      head.observedAt,
    );

    observations.push({
      tagId: head.tagId,
      readerId: head.readerId,
      dwellWindowId: head.dwellWindowId,
      antennaId: head.antennaId,
      trailerId: head.trailerId,
      hubId: head.hubId,
      readerType: head.readerType,
      aggregatedRssi: percentile(rssis, config.aggregationPercentile),
      readCount: bucket.length,
      lastObservedAt,
    });
  }

  return observations;
}

/**
 * Build the stable composite grouping key. The three id parts are joined with the
 * ASCII Unit Separator (U+001F) — a control char that cannot appear in any tag /
 * reader / dwell id — so distinct tuples never collide via delimiter-less concat
 * (e.g. tag "AB"+reader "C" vs tag "A"+reader "BC").
 */
const KEY_SEP = "";
function groupKey(tagId: string, readerId: string, dwellWindowId: string): string {
  return `${tagId}${KEY_SEP}${readerId}${KEY_SEP}${dwellWindowId}`;
}

/**
 * The `p`-th percentile (0–100) of `values` via linear interpolation between
 * the two nearest ranks on the SORTED ascending sample. Robust to multipath
 * drops: the 90th percentile keeps the strong reads and discards the deep
 * low-RSSI tail. Guards every index for `noUncheckedIndexedAccess`.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    const only = sorted[0];
    return only ?? Number.NaN;
  }
  const clampedP = p < 0 ? 0 : p > 100 ? 100 : p;
  const rank = (clampedP / 100) * (sorted.length - 1);
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sorted[lowIndex];
  const high = sorted[highIndex];
  if (low === undefined) return Number.NaN;
  if (high === undefined) return low;
  if (lowIndex === highIndex) return low;
  const weight = rank - lowIndex;
  return low + (high - low) * weight;
}
