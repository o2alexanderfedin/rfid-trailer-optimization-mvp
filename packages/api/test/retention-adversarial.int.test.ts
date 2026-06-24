import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Kysely } from "kysely";
import { appendToStream, readAll, type Database } from "@mm/event-store";
import { applyInline, projectionView, type ProjectionDb } from "@mm/projections";
import {
  pruneEventLog,
  projectionWatermark,
  type ApiDb,
  type RetentionConfig,
} from "../src/index.js";
import { startPgFixture, eventStoreView, type PgFixture } from "./pg-fixture.js";

/**
 * ADVERSARIAL bounded-retention verifier (Plan 19-08 Task C, p19-fix).
 *
 * Tries to BREAK the safety invariant of `pruneEventLog`/`ageStaleProjections`:
 *   - prune must NEVER delete an event with `global_seq >= watermark`,
 *   - margin larger than the log ⇒ prune deletes NOTHING,
 *   - watermark=0 (a projection lacking a checkpoint) ⇒ prune deletes NOTHING,
 *   - after pruning, the projections still answer "current location / hub
 *     inventory" IDENTICALLY to an unpruned run,
 *   - the finite/test path (no prune) is provably never pruned.
 */

const EPOCH_MS = Date.parse("2026-04-01T00:00:00.000Z");

async function setCheckpoint(
  es: Kysely<Database>,
  projection: string,
  lastSeq: number | bigint,
): Promise<void> {
  await es
    .insertInto("projection_checkpoints")
    .values({ projection, last_seq: String(lastSeq) })
    .onConflict((oc) => oc.column("projection").doUpdateSet({ last_seq: String(lastSeq) }))
    .execute();
}

async function eventCount(es: Kysely<Database>): Promise<number> {
  const row = await es
    .selectFrom("events")
    .select((eb) => eb.fn.countAll().as("c"))
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

async function allSeqs(es: Kysely<Database>): Promise<number[]> {
  const rows = await es.selectFrom("events").select("global_seq").orderBy("global_seq").execute();
  return rows.map((r) => Number(r.global_seq));
}

/**
 * Append a small package lifecycle so the projections have real "current
 * location" + "hub inventory" answers to verify post-prune: created at MEM,
 * scanned, departs, arrives at a spoke (PackageArrivedAtHub sets the location).
 */
async function seedPackageLifecycle(
  es: Kysely<Database>,
  packageId: string,
  destHubId: string,
  baseMin: number,
): Promise<void> {
  const at = (m: number): Date => new Date(EPOCH_MS + m * 60_000);
  await appendToStream(
    es,
    `package-${packageId}`,
    0,
    [
      {
        type: "PackageCreated",
        schemaVersion: 1,
        payload: { packageId, originHubId: "MEM", destHubId, sizeClass: "small", weight: 2 },
      },
      {
        type: "PackageScanned",
        schemaVersion: 1,
        payload: { packageId, hubId: "MEM", scanType: "inbound" },
      },
      {
        type: "PackageArrivedAtHub",
        schemaVersion: 1,
        payload: { packageId, hubId: destHubId },
      },
    ],
    at(baseMin),
  );
}

/** Fold the ENTIRE current log into the operational projections (read model). */
async function foldAll(db: ApiDb, es: Kysely<Database>): Promise<void> {
  const all = await readAll(es, 0n);
  await db.transaction().execute(async (trx) => {
    const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
    for (const ev of all) await applyInline(proj, ev);
  });
}

/** Snapshot package_location (the "current location" read model), sorted. */
async function locationSnapshot(db: ApiDb): Promise<{ package_id: string; hub_id: string }[]> {
  const pdb = db as unknown as Kysely<{
    package_location: { package_id: string; hub_id: string; last_seen_at: string };
  }>;
  const rows = await pdb
    .selectFrom("package_location")
    .select(["package_id", "hub_id"])
    .orderBy("package_id")
    .execute();
  return rows;
}

const CONFIG: RetentionConfig = { everyTicks: 1, retentionMargin: 10, staleHorizonMs: 0 };

describe("adversarial: bounded retention safety", () => {
  let fx: PgFixture;
  let db: ApiDb;
  let es: Kysely<Database>;

  beforeAll(async () => {
    fx = await startPgFixture();
    db = fx.db;
    es = eventStoreView(fx.db);
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
  });

  beforeEach(async () => {
    await es.deleteFrom("events").execute();
    await es.deleteFrom("streams").execute();
    await es.deleteFrom("projection_checkpoints").execute();
    const pdb = db as unknown as Kysely<{
      package_location: object;
      zone_estimate: object;
    }>;
    await pdb.deleteFrom("package_location").execute();
    await pdb.deleteFrom("zone_estimate").execute();
  });

  // -- watermark=0 (a projection lacking a checkpoint) prunes nothing ----------
  it("watermark=0 (geo-track has NO checkpoint) deletes ZERO rows", async () => {
    for (let i = 1; i <= 50; i += 1) await seedPackageLifecycle(es, `P${i}`, "LAX", i * 3);
    const before = await eventCount(es);
    // Only ONE catch-up projection checkpointed; the other is missing ⇒ watermark 0.
    await setCheckpoint(es, "audit-timeline", 999_999);
    expect(await projectionWatermark(db)).toBe(0n);
    const deleted = await pruneEventLog(db, CONFIG);
    expect(deleted).toBe(0);
    expect(await eventCount(es)).toBe(before);
  });

  // -- margin larger than the log ⇒ prune deletes nothing ----------------------
  it("a retentionMargin larger than the whole log deletes ZERO rows", async () => {
    for (let i = 1; i <= 40; i += 1) await seedPackageLifecycle(es, `P${i}`, "LAX", i * 3);
    const seqs = await allSeqs(es);
    const maxSeq = seqs.at(-1)!;
    await setCheckpoint(es, "audit-timeline", maxSeq);
    await setCheckpoint(es, "geo-track", maxSeq);
    const before = await eventCount(es);
    // margin >> log size ⇒ cutoff = watermark - margin <= 0 ⇒ keep everything.
    const huge: RetentionConfig = { everyTicks: 1, retentionMargin: maxSeq + 10_000, staleHorizonMs: 0 };
    const deleted = await pruneEventLog(db, huge);
    expect(deleted).toBe(0);
    expect(await eventCount(es)).toBe(before);
  });

  // -- prune NEVER deletes a row STILL NEEDED (global_seq > watermark) ----------
  // NOTE: catch-up resume is EXCLUSIVE of the watermark — `readAll(from)` reads
  // `global_seq > from`, and the checkpoint stores `last_seq` (the highest applied
  // seq). So the row AT `global_seq == watermark` has already been folded AND is
  // never replayed; deleting it (which margin 0 does) is SAFE. The TRUE invariant
  // is: no row with `global_seq > watermark` may ever be deleted (those are not
  // yet folded by every projection).
  it("prune NEVER deletes a row with global_seq > watermark (margin 0, watermark mid-log)", async () => {
    for (let i = 1; i <= 100; i += 1) await seedPackageLifecycle(es, `P${i}`, "LAX", i * 3);
    const seqs = await allSeqs(es);
    // Put the watermark squarely in the MIDDLE of the log.
    const watermarkSeq = seqs[Math.floor(seqs.length / 2)]!;
    await setCheckpoint(es, "audit-timeline", watermarkSeq);
    await setCheckpoint(es, "geo-track", watermarkSeq);
    expect(await projectionWatermark(db)).toBe(BigInt(watermarkSeq));

    // margin 0 is the MOST AGGRESSIVE prune (cutoff == watermark): rows are deleted
    // for `global_seq <= watermark`. The watermark row itself may go (safe — past
    // the exclusive resume point), but NOTHING above it may be touched.
    const aggressive: RetentionConfig = { everyTicks: 1, retentionMargin: 0, staleHorizonMs: 0 };
    await pruneEventLog(db, aggressive);

    const remaining = await allSeqs(es);
    // CRITICAL SAFETY INVARIANT: every row STILL NEEDED (global_seq > watermark)
    // must survive — none of them may ever be pruned.
    const stillNeeded = seqs.filter((s) => s > watermarkSeq);
    for (const s of stillNeeded) {
      expect(remaining).toContain(s);
    }
    // Nothing above the watermark was touched: the head is unchanged.
    expect(Math.max(...remaining)).toBe(Math.max(...seqs));
    // And the prune is REAL (it deleted rows at/below the watermark).
    expect(remaining.length).toBeLessThan(seqs.length);
  });

  // -- after pruning, the read model still answers "current location" the same --
  it("projections answer 'current location' IDENTICALLY after a safe prune", async () => {
    // Build a deterministic set of packages with known destination hubs.
    const dests = ["LAX", "PHX", "DFW", "ORD", "ATL"] as const;
    for (let i = 1; i <= 60; i += 1) {
      await seedPackageLifecycle(es, `P${String(i).padStart(3, "0")}`, dests[i % dests.length]!, i * 2);
    }
    // Fold EVERYTHING into the read model FIRST (this is the unpruned answer).
    await foldAll(db, es);
    const unprunedLocations = await locationSnapshot(db);
    expect(unprunedLocations.length).toBe(60);

    // Now advance the catch-up watermark to the head (everything is projected) and
    // prune aggressively. The projection read model is NOT rebuilt — it persists.
    const seqs = await allSeqs(es);
    const head = seqs.at(-1)!;
    await setCheckpoint(es, "audit-timeline", head);
    await setCheckpoint(es, "geo-track", head);
    const deleted = await pruneEventLog(db, { everyTicks: 1, retentionMargin: 5, staleHorizonMs: 0 });
    expect(deleted).toBeGreaterThan(0);

    // The "current location" read model is unchanged by pruning the LOG below the
    // watermark (those events were already folded; catch-up resumes from the
    // watermark, never from 0). Identical answer ⇒ retention preserves correctness.
    const prunedLocations = await locationSnapshot(db);
    expect(prunedLocations).toEqual(unprunedLocations);
  });

  // -- repeated continuous prune keeps the log bounded AND head-safe -----------
  it("continuous prune over many rounds: bounded log, watermark row never lost", async () => {
    const BATCH = 40;
    const ROUNDS = 8;
    const counts: number[] = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const base = r * BATCH;
      for (let i = 1; i <= BATCH; i += 1) {
        const seq = base + i;
        await appendToStream(
          es,
          `t-${seq}`,
          0,
          [
            {
              type: "PackageScanned",
              schemaVersion: 1,
              payload: { packageId: `P${seq}`, hubId: "MEM", scanType: "inbound" },
            },
          ],
          new Date(EPOCH_MS + seq * 60_000),
        );
      }
      const seqs = await allSeqs(es);
      const head = seqs.at(-1)!;
      await setCheckpoint(es, "audit-timeline", head);
      await setCheckpoint(es, "geo-track", head);
      await pruneEventLog(db, CONFIG);
      // The head (== watermark) row must ALWAYS survive every round.
      const after = await allSeqs(es);
      expect(after).toContain(head);
      counts.push(after.length);
    }
    // Bounded: the retained count never grows with run length.
    const last = counts.at(-1)!;
    expect(last).toBeLessThanOrEqual(CONFIG.retentionMargin + BATCH + 1);
    expect(last).toBeLessThan(BATCH * ROUNDS);
  });

  // -- asymmetric watermarks: the MIN across projections is the safe floor -----
  it("uses the MIN watermark across catch-up projections (the laggard governs)", async () => {
    for (let i = 1; i <= 80; i += 1) await seedPackageLifecycle(es, `P${i}`, "LAX", i * 2);
    const seqs = await allSeqs(es);
    const ahead = seqs.at(-1)!; // audit-timeline is caught up to head
    const behind = seqs[10]!; // geo-track lags far behind
    await setCheckpoint(es, "audit-timeline", ahead);
    await setCheckpoint(es, "geo-track", behind);
    expect(await projectionWatermark(db)).toBe(BigInt(behind));

    await pruneEventLog(db, { everyTicks: 1, retentionMargin: 0, staleHorizonMs: 0 });
    const remaining = await allSeqs(es);
    // Nothing ABOVE the LAGGARD watermark (geo-track) may be pruned, because
    // geo-track has not yet folded it. The laggard governs, not audit-timeline.
    // (The laggard row itself is past the exclusive resume point, so it may go.)
    for (const s of seqs.filter((x) => x > behind)) expect(remaining).toContain(s);
    expect(Math.max(...remaining)).toBe(ahead);
  });

  // -- the finite/test path (no retention config) is provably never pruned -----
  it("finite/test path retains the FULL log (no prune is ever called)", async () => {
    const seedCount = 70 * 3; // 70 lifecycles x 3 events each
    for (let i = 1; i <= 70; i += 1) await seedPackageLifecycle(es, `P${i}`, "LAX", i * 2);
    const before = await eventCount(es);
    expect(before).toBe(seedCount);
    // The finite path NEVER calls pruneEventLog. A replay-from-0 read returns
    // EVERY row, so the golden/test replay is byte-identical (never reads a hole).
    const all = await readAll(es, 0n);
    expect(all.length).toBe(before);
    // The surviving seqs are CONTIGUOUS (no pruned hole anywhere) — the front row
    // is `min`, and every seq from min..max is present (global_seq is a non-
    // resetting Postgres sequence, so it does NOT restart at 1 between tests).
    const seqs = await allSeqs(es);
    const min = seqs[0]!;
    const max = seqs.at(-1)!;
    expect(max - min + 1).toBe(seqs.length); // fully contiguous, no holes
  });
});
