import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import { appendToStream, appendWithRetry, readAll } from "@mm/event-store";
import {
  applyInline,
  DEFAULT_DETECTION_CONFIG,
  makeProjectionReads,
  projectionView,
  type ProjectionDb,
  readExceptionKpi,
  readOpenExceptions,
  runDetection,
} from "@mm/projections";
import { simulate, type SimulatedEvent } from "@mm/simulation";
import type { Kysely } from "kysely";
import {
  eventStoreView,
  type FixtureDb,
  startPgFixture,
  type PgFixture,
} from "./pg-fixture.js";

/**
 * Plan 03-06 (SNS-04/05) — the detector END-TO-END against a REAL Postgres
 * (Testcontainers) driven ONCE by a SEEDED noisy sim (with probabilistic RFID,
 * incl. seeded read DROPS). This is the anti-P6 keystone proven through the full
 * stack: PLANNED (trailer-state assignment + dest hub) vs OBSERVED (fused zone
 * estimates) ⇒ exception events via `appendWithRetry` (OCC-guarded) ⇒ the inline
 * exceptions feed + false-positive KPI.
 *
 * One sim is driven in `beforeAll` (mirroring the other API int suites, so the
 * shared global hub/route streams are seeded exactly once); each test asserts a
 * facet of that run:
 *  (a) a DELIBERATE wrong-trailer RFID observation ⇒ exactly one persisted
 *      WrongTrailerDetected (severity + recommendedAction + confidence < 1.0);
 *  (b) the anti-P6 keystone: a package with NO reads in the lossy run produces
 *      NO exception and is NEVER marked missing — and detection over the whole
 *      run never floods (feed ≤ observation count);
 *  (c) re-running detection is idempotent (no double-count) + the FP-rate KPI is
 *      a real ratio in [0,1].
 */

const SEED = 4242;
const DURATION = 20;

/**
 * A detection config calibrated to the FUSION ENGINE's actual output range. The
 * anti-P5b fusion (likelihood cap 0.85 + 2% entropy floor + Markov prior)
 * SATURATES the argmax zone mass near ~0.40 — it can never approach 1.0. So a
 * realistic `confidenceThreshold` sits just above the ~0.33 uniform floor: a
 * confident estimate clears it, near-uniform noise does not. This documents that
 * the Plan-04 DEFAULT (0.6) is unreachable by this engine — detection must be
 * calibrated to the observed-confidence distribution (carried to Plan 07).
 */
const REALISTIC_CONFIG = {
  confidenceThreshold: 0.34,
  highConfidenceThreshold: 0.395,
  severityFor: DEFAULT_DETECTION_CONFIG.severityFor,
} as const;

/**
 * Drive the seeded stream into the store + inline projections. The stream is
 * SHORT (DURATION ticks), so we append it grouped per stream (OCC, in version
 * order) then apply every event ONCE through `applyInline` (the SAME path the
 * production driver uses) — a single O(n) pass that keeps the suite fast even
 * under parallel-container contention.
 */
async function drive(db: FixtureDb, stream: readonly SimulatedEvent[]): Promise<void> {
  const es = eventStoreView(db);
  const perStream = new Map<string, SimulatedEvent[]>();
  for (const e of stream) {
    const buf = perStream.get(e.streamId) ?? [];
    buf.push(e);
    perStream.set(e.streamId, buf);
  }
  for (const [streamId, items] of perStream) {
    await appendToStream(
      es,
      streamId,
      0,
      items.map((i) => i.event),
      new Date(items[0]!.occurredAt),
    );
  }
  // Apply every event in ONE transaction to minimize round-trips (the applies
  // are read-your-writes within the txn — identical result, far fewer commits).
  const all = await readAll(es, 0n);
  await db.transaction().execute(async (trx) => {
    const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
    for (const ev of all) await applyInline(proj, ev);
  });
}

/** Apply only events at/after `fromSeq` (e.g. freshly-appended exceptions). */
async function applyFrom(db: FixtureDb, fromSeq: bigint): Promise<void> {
  const all = await readAll(eventStoreView(db), fromSeq);
  if (all.length === 0) return;
  await db.transaction().execute(async (trx) => {
    const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
    for (const ev of all) await applyInline(proj, ev);
  });
}

/** Build the PLANNED dest-hub index from the seeded PackageCreated events. */
function destHubIndex(stream: readonly SimulatedEvent[]): Map<string, string> {
  const dest = new Map<string, string>();
  for (const e of stream) {
    if (e.event.type === "PackageCreated") {
      dest.set(e.event.payload.packageId, e.event.payload.destHubId);
    }
  }
  return dest;
}

describe("runDetection end-to-end over a seeded noisy sim (SNS-04/05)", () => {
  let fx: PgFixture;
  let stream: readonly SimulatedEvent[];
  let destHub: Map<string, string>;

  beforeAll(async () => {
    fx = await startPgFixture();
    stream = simulate({ seed: SEED, durationTicks: DURATION, rfid: {} });
    destHub = destHubIndex(stream);
    await drive(fx.db, stream);
  }, 300_000);

  afterAll(async () => {
    await fx?.stop();
  });

  /** A `DetectorReads` bound to the live fixture + real OCC append. */
  function liveReads(): ReturnType<typeof makeProjectionReads> {
    const es = eventStoreView(fx.db);
    return makeProjectionReads(projectionView(fx.db), {
      readDestHub: (id) => destHub.get(id),
      append: (streamId, build, occurredAt) =>
        appendWithRetry(es, streamId, build, occurredAt),
    });
  }

  it("(a) a deliberate wrong-trailer observation yields exactly one persisted WrongTrailerDetected", async () => {
    // Pick a package the plan loaded onto a trailer, and observe it (via its
    // registered tag) in a DIFFERENT trailer at high confidence — a deliberate
    // above-threshold disagreement.
    const trailers = await fx.db.selectFrom("trailer_state").selectAll().execute();
    const loaded = trailers.find((t) => t.assigned_package_ids.length > 0);
    expect(loaded).toBeDefined();
    const pkg = loaded!.assigned_package_ids[0]!;
    const wrongTrailer = "WRONG-TRL-A";

    const created = stream.find(
      (e) => e.event.type === "PackageCreated" && e.event.payload.packageId === pkg,
    );
    const tagId =
      created?.event.type === "PackageCreated" ? created.event.payload.rfidTagId : undefined;
    expect(tagId).toBeDefined();

    const es = eventStoreView(fx.db);
    const wrongReads: DomainEvent[] = Array.from({ length: 6 }, () => ({
      type: "RfidObserved",
      schemaVersion: 1,
      payload: {
        tagId: tagId!,
        readerId: "READER-WRONG",
        antennaId: "ANT-1",
        rssi: -45,
        trailerId: wrongTrailer,
        hubId: "MEM",
        confidence: 0.95,
      },
    }));
    const headBefore = (await readAll(es, 0n)).at(-1)!.globalSeq;
    await appendToStream(
      es,
      "rfid-WRONG-A",
      0,
      wrongReads,
      new Date(Date.parse(stream[0]!.occurredAt) + 1000),
    );
    await applyFrom(fx.db, headBefore);

    const head = (await readAll(es, 0n)).at(-1)!.globalSeq;
    const appended = await runDetection(liveReads(), { config: REALISTIC_CONFIG });
    expect(appended.some((e) => e.type === "WrongTrailerDetected")).toBe(true);
    await applyFrom(fx.db, head);

    const open = await readOpenExceptions(projectionView(fx.db));
    const mine = open.filter(
      (e) => e.packageId === pkg && e.kind === "wrong-trailer" && e.trailerId === wrongTrailer,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.severity).toBeTruthy();
    expect(mine[0]?.recommendedAction).toBeTruthy();
    expect(mine[0]?.confidence).toBeLessThan(1.0); // anti-P5b inherited
  });

  it("(b) anti-P6: a planned-but-NEVER-observed package is never flagged (absence ⇒ never missing)", async () => {
    // Inject a GHOST package: planned onto a trailer (a deliberate departure
    // carrying it) and destined for a hub THAT THEN DEPARTS — yet it receives NO
    // RFID read at all. Under anti-P6 it must NEVER appear in the feed: detection
    // is observation-driven, so absence can never manufacture a "missing" /
    // wrong-trailer exception.
    const es = eventStoreView(fx.db);
    const ghost = "GHOST-PKG-B";
    const ghostHub = "ATL";
    const ghostTrailer = "GHOST-TRL-B";
    destHub.set(ghost, ghostHub);

    const depart: DomainEvent = {
      type: "TrailerDeparted",
      schemaVersion: 1,
      payload: {
        trailerId: ghostTrailer,
        tripId: "GHOST-TRIP-B",
        fromHubId: ghostHub,
        toHubId: "LAX",
        packageIds: [ghost],
      },
    };
    const head = (await readAll(es, 0n)).at(-1)!.globalSeq;
    await appendToStream(
      es,
      `trailer-${ghostTrailer}`,
      0,
      [depart],
      new Date(Date.parse(stream[0]!.occurredAt) + 2000),
    );
    await applyFrom(fx.db, head);

    // Sanity: the ghost is genuinely planned + in-transit (its hub gates), but
    // has NO observation at all.
    const observed = await fx.db
      .selectFrom("zone_estimate")
      .select("package_id")
      .where("package_id", "=", ghost)
      .execute();
    expect(observed).toHaveLength(0);

    const head2 = (await readAll(es, 0n)).at(-1)!.globalSeq;
    await runDetection(liveReads(), { config: REALISTIC_CONFIG });
    await applyFrom(fx.db, head2);

    const open = await readOpenExceptions(projectionView(fx.db));
    // The ghost NEVER appears — absence produced no exception of any kind.
    expect(open.some((e) => e.packageId === ghost)).toBe(false);

    // And the structural keystone: EVERY open exception has a backing
    // observation (no exception can exist without a positive read).
    const observedKeys = new Set(
      (
        await fx.db.selectFrom("zone_estimate").select(["package_id", "trailer_id"]).execute()
      ).map((r) => `${r.package_id}|${r.trailer_id}`),
    );
    for (const e of open) {
      expect(observedKeys.has(`${e.packageId}|${e.trailerId}`)).toBe(true);
    }
  });

  it("(c) re-running detection is idempotent (no double-count) + the FP-rate KPI is a real ratio", async () => {
    const before = await readOpenExceptions(projectionView(fx.db));

    let head = (await readAll(eventStoreView(fx.db), 0n)).at(-1)!.globalSeq;
    for (let i = 0; i < 3; i += 1) {
      await runDetection(liveReads(), { config: REALISTIC_CONFIG });
      await applyFrom(fx.db, head);
      head = (await readAll(eventStoreView(fx.db), 0n)).at(-1)!.globalSeq;
    }

    const open = await readOpenExceptions(projectionView(fx.db));
    const kpi = await readExceptionKpi(projectionView(fx.db));
    // Idempotent: re-running added no NEW exceptions (the dedupe holds).
    expect(open.length).toBe(before.length);
    expect(kpi.totalExceptions).toBe(open.length);
    // FP-rate is a genuine ratio in [0,1] (low / total).
    expect(kpi.falsePositiveRate).toBeGreaterThanOrEqual(0);
    expect(kpi.falsePositiveRate).toBeLessThanOrEqual(1);
  });
});
