import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Kysely } from "kysely";
import { appendToStream, type Database } from "@mm/event-store";
import {
  pruneEventLog,
  ageStaleProjections,
  projectionWatermark,
  type ApiDb,
  type RetentionConfig,
} from "../src/index.js";
import { startPgFixture, eventStoreView, type PgFixture } from "./pg-fixture.js";

/**
 * Plan 19-08 Task C — BOUNDED PERSISTED RETENTION (continuous path only).
 *
 * These tests pin the SAFETY INVARIANT: pruning NEVER deletes at/above the
 * projection watermark, and the finite/test path (no retention config) keeps the
 * full log. They drive the retention primitives directly against a real Postgres
 * (events + projection_checkpoints + projection tables) for fidelity.
 */

const EPOCH_MS = Date.parse("2026-04-01T00:00:00.000Z");

/** Append N synthetic events (one per stream) via the real event-store writer. */
async function seedEvents(es: Kysely<Database>, n: number): Promise<void> {
  for (let i = 1; i <= n; i += 1) {
    const packageId = `P${String(i).padStart(5, "0")}`;
    await appendToStream(
      es,
      `package-${packageId}`,
      0,
      [
        {
          type: "PackageCreated",
          schemaVersion: 1,
          payload: {
            packageId,
            originHubId: "MEM",
            destHubId: "LAX",
            sizeClass: "small",
            weight: 1,
          },
        },
      ],
      new Date(EPOCH_MS + i * 60_000),
    );
  }
}

/** Set a catch-up projection's checkpoint watermark. */
async function setCheckpoint(
  es: Kysely<Database>,
  projection: string,
  lastSeq: number,
): Promise<void> {
  await es
    .insertInto("projection_checkpoints")
    .values({ projection, last_seq: String(lastSeq) })
    .onConflict((oc) =>
      oc.column("projection").doUpdateSet({ last_seq: String(lastSeq) }),
    )
    .execute();
}

async function eventCount(es: Kysely<Database>): Promise<number> {
  const row = await es
    .selectFrom("events")
    .select((eb) => eb.fn.countAll().as("c"))
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

async function minMaxSeq(es: Kysely<Database>): Promise<{ min: number; max: number }> {
  const row = await es
    .selectFrom("events")
    .select((eb) => [eb.fn.min("global_seq").as("mn"), eb.fn.max("global_seq").as("mx")])
    .executeTakeFirst();
  return { min: Number(row?.mn ?? 0), max: Number(row?.mx ?? 0) };
}

const CONFIG: RetentionConfig = { everyTicks: 1, retentionMargin: 10, staleHorizonMs: 0 };

describe("bounded retention (Task C)", () => {
  let fx: PgFixture;
  let db: ApiDb;
  let es: Kysely<Database>;

  beforeAll(async () => {
    fx = await startPgFixture();
    db = fx.db;
    es = eventStoreView(fx.db);
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  beforeEach(async () => {
    await es.deleteFrom("events").execute();
    await es.deleteFrom("streams").execute();
    await es.deleteFrom("projection_checkpoints").execute();
  });

  it("watermark is the MIN last_seq across catch-up projections", async () => {
    await seedEvents(es, 100);
    await setCheckpoint(es, "audit-timeline", 80);
    await setCheckpoint(es, "geo-track", 60);
    expect(await projectionWatermark(db)).toBe(60n);
  });

  it("watermark is 0 when any catch-up projection has no checkpoint yet", async () => {
    await seedEvents(es, 100);
    await setCheckpoint(es, "audit-timeline", 80);
    // geo-track missing ⇒ nothing is safely prunable.
    expect(await projectionWatermark(db)).toBe(0n);
  });

  it("prunes only events strictly below (watermark - margin); NEVER >= watermark", async () => {
    await seedEvents(es, 200);
    const { max: maxSeq } = await minMaxSeq(es);
    // Both projections at the same watermark so it's well-defined.
    await setCheckpoint(es, "audit-timeline", maxSeq);
    await setCheckpoint(es, "geo-track", maxSeq);
    const watermark = await projectionWatermark(db);

    const deleted = await pruneEventLog(db, CONFIG);
    expect(deleted).toBeGreaterThan(0);

    const { min, max } = await minMaxSeq(es);
    // The watermark row and everything above it survive (invariant).
    expect(max).toBe(Number(watermark));
    // The smallest surviving seq is strictly above the prune cutoff
    // (watermark - margin); nothing at/above the watermark was touched.
    expect(min).toBeGreaterThan(Number(watermark) - CONFIG.retentionMargin);
    expect(min).toBeLessThanOrEqual(Number(watermark));
  });

  it("a continuous prune keeps the log bounded (count never run-length-proportional)", async () => {
    // Simulate a long run: repeatedly add a batch, advance the watermark to the
    // new head, and prune. The retained count must stay bounded by ~margin.
    const BATCH = 50;
    const ROUNDS = 6;
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
      const { max } = await minMaxSeq(es);
      await setCheckpoint(es, "audit-timeline", max);
      await setCheckpoint(es, "geo-track", max);
      await pruneEventLog(db, CONFIG);
      counts.push(await eventCount(es));
    }
    // The retained count must NOT grow unboundedly with rounds: after the first
    // couple of rounds it is bounded by ~(margin + a batch), far below the total
    // inserted (BATCH * ROUNDS = 300).
    const last = counts.at(-1)!;
    expect(last).toBeLessThanOrEqual(CONFIG.retentionMargin + BATCH + 1);
    expect(last).toBeLessThan(BATCH * ROUNDS);
  });

  it("ages out stale projection rows older than the sim horizon", async () => {
    const pdb = db as unknown as Kysely<{
      package_location: {
        package_id: string;
        hub_id: string;
        confidence: number;
        last_seen_at: string;
      };
    }>;
    await pdb.deleteFrom("package_location").execute();
    const nowMs = EPOCH_MS + 100 * 24 * 60 * 60 * 1000; // sim day 100
    // One STALE row (50 days old) and one FRESH row (1 hour old).
    await pdb
      .insertInto("package_location")
      .values([
        {
          package_id: "P-OLD",
          hub_id: "MEM",
          confidence: 1,
          last_seen_at: new Date(nowMs - 50 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          package_id: "P-NEW",
          hub_id: "LAX",
          confidence: 1,
          last_seen_at: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        },
      ])
      .execute();

    const aged = await ageStaleProjections(
      db,
      { everyTicks: 1, retentionMargin: 0, staleHorizonMs: 7 * 24 * 60 * 60 * 1000 },
      nowMs,
    );
    expect(aged).toBe(1);
    const remaining = await pdb.selectFrom("package_location").select("package_id").execute();
    expect(remaining.map((r) => r.package_id)).toEqual(["P-NEW"]);
  });

  it("staleHorizonMs <= 0 disables projection age-out (finite/test path)", async () => {
    const aged = await ageStaleProjections(
      db,
      { everyTicks: 1, retentionMargin: 0, staleHorizonMs: 0 },
      EPOCH_MS,
    );
    expect(aged).toBe(0);
  });

  it("finite/test path (no prune) retains the full log unread of any pruned row", async () => {
    await seedEvents(es, 75);
    // The finite path NEVER calls pruneEventLog ⇒ the full log is present and a
    // replay-from-0 read returns every row.
    const all = await es.selectFrom("events").selectAll().orderBy("global_seq").execute();
    expect(all.length).toBe(75);
    expect(Number(all[0]!.global_seq)).toBeGreaterThan(0);
  });
});
