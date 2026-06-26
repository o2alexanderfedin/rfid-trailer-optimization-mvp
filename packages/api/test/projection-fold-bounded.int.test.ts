import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import type { DomainEvent } from "@mm/domain";
import { appendToStream, readAll } from "@mm/event-store";
import { applyInline, projectionView } from "@mm/projections";
import { eventStoreView, startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * v2.1-sim-perf REGRESSION GUARD — per-event `applyInline` cost stays BOUNDED as
 * accumulated projection state grows.
 *
 * ROOT CAUSE (fixed): each operational applier used to LOAD the entire projection
 * table (`selectAll()`), fold, and RE-WRITE every row — per event. So per-event
 * cost was O(total rows) and the run was O(events²): the live paced demo's tick
 * rate decayed to a near-halt ("time appears stopped") as state accumulated. The
 * appliers now read/write ONLY the row(s) the event's payload keys — O(affected
 * keys per event), independent of run length.
 *
 * TEST 1 (deterministic, the decisive signal): seed `package_location` to a LARGE
 * size, apply ONE more `PackageScanned` (a DIFFERENT package), and assert the N
 * pre-existing rows were NOT WRITTEN. We compare each row's Postgres `xmin` system
 * column (the inserting/updating transaction id): an `ON CONFLICT DO UPDATE` writes
 * a NEW tuple version even when the values are identical, so `xmin` changes iff the
 * row was re-written. The broken load-all/write-all applier re-upserted every row
 * each event (every `xmin` changes); the keyed fix touches only the one affected
 * key (the other N rows keep their `xmin`). Row VALUES alone can't witness this —
 * the no-op upsert re-writes identical data — so `xmin` is the precise probe.
 * (`package_location` rows are bulk-seeded directly so the test isolates the SINGLE
 * folded event's write footprint, not the slow per-event seed.)
 *
 * TEST 2 (corroborating wall-clock, generous threshold): per-event `applyInline`
 * time atop ~LARGE state ≈ per-event time atop ~SMALL state. The O(state) bug made
 * `large` many-fold `small`; the keyed fix keeps it flat.
 *
 * Determinism keystone is untouched: this is a projection-LAYER perf fix; the
 * seed-42 `simulate()` golden is unaffected (covered by the unit determinism suite).
 */

const T0 = Date.parse("2026-07-01T00:00:00.000Z");

function scanned(packageId: string, hubId: string): DomainEvent {
  return {
    type: "PackageScanned",
    schemaVersion: 1,
    payload: { packageId, hubId, scanType: "inbound" },
  };
}

describe("applyInline per-event cost is bounded by affected keys, not total state", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);
  afterAll(async () => {
    await fx?.stop();
  });

  let run = 0;
  let foldCursor = 0n;
  beforeEach(() => {
    run += 1;
  });

  /** Append one single-event stream and fold ONLY the new event (incremental cursor). */
  async function appendAndFold(streamId: string, ev: DomainEvent, atMs: number): Promise<void> {
    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);
    await appendToStream(es, streamId, 0, [ev], new Date(atMs));
    const fresh = await readAll(es, foldCursor);
    for (const stored of fresh) await applyInline(proj, stored);
    if (fresh.length > 0) foldCursor = fresh[fresh.length - 1]!.globalSeq;
  }

  /** Bulk-seed N pre-existing package_location rows directly (O(1) round-trips). */
  async function bulkSeedPackageLocation(tag: string, n: number, hub: string, seenAt: string): Promise<void> {
    const proj = projectionView(fx.db);
    const values = Array.from({ length: n }, (_, i) => ({
      package_id: `PKG-${tag}-${i}`,
      hub_id: hub,
      confidence: 1,
      last_seen_at: seenAt,
    }));
    await proj.insertInto("package_location").values(values).execute();
  }

  /** Map of package_id -> xmin (the row's last-writing txid) for a tag's rows. */
  async function xminByPackage(tag: string): Promise<Map<string, string>> {
    const rows = await sql<{ package_id: string; xmin: string }>`
      SELECT package_id, xmin::text AS xmin
      FROM package_location
      WHERE package_id LIKE ${`PKG-${tag}-%`}
    `.execute(fx.db);
    return new Map(rows.rows.map((r) => [r.package_id, r.xmin]));
  }

  it("a fresh event does NOT re-write the other (growing) package_location rows", async () => {
    const tag = `B${run}`;
    const N = 400;
    await bulkSeedPackageLocation(tag, N, `HUB-${tag}-A`, new Date(T0).toISOString());

    // Capture each pre-existing row's xmin (its last-writing txid) BEFORE the probe.
    const before = await xminByPackage(tag);
    expect(before.size).toBe(N);

    // Apply ONE scan for a BRAND-NEW package via the REAL applyInline production fold.
    const probeAt = T0 + 10_000_000;
    await appendAndFold(`package-${tag}-NEW`, scanned(`PKG-${tag}-NEW`, `HUB-${tag}-B`), probeAt);

    // The fix's signature: the N pre-existing rows were NOT re-written, so their
    // `xmin` is unchanged. The broken applier re-upserted every row (each `xmin`
    // would advance to the fold's txid). `xmin` (not row values) is the probe,
    // because a no-op `ON CONFLICT DO UPDATE` writes identical values yet a new tuple.
    const after = await xminByPackage(tag);
    let rewrittenOthers = 0;
    for (const [pkg, xmin] of before) {
      if (pkg === `PKG-${tag}-NEW`) continue;
      if (after.get(pkg) !== xmin) rewrittenOthers += 1;
    }
    expect(rewrittenOthers).toBe(0); // none of the N other rows were re-written
    expect(after.has(`PKG-${tag}-NEW`)).toBe(true); // the affected key WAS written
  }, 60_000);

  it("per-event fold time at LARGE state ≈ per-event time at SMALL state (no O(state) decay)", async () => {
    const tag = `T${run}`;

    async function medianPerEventMs(prefix: string, count: number): Promise<number> {
      const samples: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const t0 = performance.now();
        await appendAndFold(`package-${prefix}-${i}`, scanned(`PKG-${prefix}-${i}`, `HUB-${tag}`), T0 + i);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)]!;
    }

    // SMALL state: per-event cost over the first handful of folded events.
    const small = await medianPerEventMs(`${tag}-S`, 8);

    // Grow `package_location` substantially by bulk-seed (the cheap way to reach a
    // LARGE table size that the broken applier would re-read+re-write per event).
    await bulkSeedPackageLocation(`${tag}-BULK`, 600, `HUB-${tag}`, new Date(T0).toISOString());

    // LARGE state: per-event cost again, now atop ~600+ accumulated rows.
    const large = await medianPerEventMs(`${tag}-L`, 8);

    // With the O(state) bug, `large` would be many-fold `small` (the broken code
    // re-reads+re-writes all ~600 rows per event). The keyed fix keeps it flat;
    // a generous 8× absorbs DB/disk jitter while still catching an O(state) regression.
    expect(large).toBeLessThan(Math.max(small * 8, small + 250));
  }, 60_000);
});
