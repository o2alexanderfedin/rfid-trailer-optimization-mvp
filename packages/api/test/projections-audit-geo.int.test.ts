import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DomainEvent, LonLat } from "@mm/domain";
import { appendToStream, readAll } from "@mm/event-store";
import {
  type CatchupDb,
  type StoredEventLike,
  rebuildCatchup,
  readAuditTimeline,
  readGeoKeyframes,
  runCatchup,
  serializeCatchup,
} from "@mm/projections";
import {
  eventStoreView,
  startPgFixture,
  type FixtureDb,
  type PgFixture,
} from "./pg-fixture.js";

/**
 * Plan 06 Task 1 — CATCH-UP projections (FND-08 audit timeline + geo-track).
 *
 *  - The audit timeline for a package is its full event history in strict
 *    global_seq order (FND-08).
 *  - The catch-up runner advances `projection_checkpoints.last_seq` and is
 *    idempotent (re-running does not duplicate rows).
 *  - geo-track yields deterministic per-trip keyframes along route geometry.
 *  - Truncate+replay rebuild yields identical audit + geo state.
 *
 * Hosted in `@mm/api` (depends on event-store + projections) so the workspace
 * DAG stays acyclic — projections must not dev-depend on event-store.
 */

const T0 = Date.parse("2026-04-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);

/** A view of the fixture handle as the catch-up runner's `Kysely<CatchupDb>`. */
function catchupView(db: FixtureDb): Kysely<CatchupDb> {
  return db as unknown as Kysely<CatchupDb>;
}

/** Inject `@mm/event-store`'s `readAll` as the catch-up log reader. */
function replayReadAll(
  db: Kysely<CatchupDb>,
  fromGlobalSeq: bigint,
): Promise<readonly StoredEventLike[]> {
  return readAll(eventStoreView(db as unknown as FixtureDb), fromGlobalSeq);
}

// --- Event builders ---------------------------------------------------------
const GEOM_OUT: LonLat[] = [
  [-90, 35],
  [-93, 33.5],
  [-96.8, 32.8],
];
const GEOM_BACK: LonLat[] = [
  [-96.8, 32.8],
  [-93, 33.5],
  [-90, 35],
];

function routeRegistered(from: string, to: string, geometry: LonLat[]): DomainEvent {
  return {
    type: "RouteRegistered",
    schemaVersion: 1,
    payload: { routeId: `route-${from}-${to}`, fromHubId: from, toHubId: to, geometry },
  };
}
function pkgCreated(packageId: string, origin: string, dest: string): DomainEvent {
  return {
    type: "PackageCreated",
    schemaVersion: 1,
    payload: { packageId, originHubId: origin, destHubId: dest, sizeClass: "small", weight: 5 },
  };
}
function scanned(
  packageId: string,
  hubId: string,
  scanType: "inbound" | "outbound" | "load" | "unload",
): DomainEvent {
  return { type: "PackageScanned", schemaVersion: 1, payload: { packageId, hubId, scanType } };
}
function pkgArrived(packageId: string, hubId: string): DomainEvent {
  return { type: "PackageArrivedAtHub", schemaVersion: 1, payload: { packageId, hubId } };
}
function departed(
  trailerId: string,
  from: string,
  to: string,
  tripId: string,
  packageIds: string[],
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId: from, toHubId: to, tripId, packageIds },
  };
}
function trailerArrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return { type: "TrailerArrivedAtHub", schemaVersion: 1, payload: { trailerId, hubId, tripId } };
}

describe("CATCH-UP projections: audit timeline (FND-08) + geo-track", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  let n = 0;
  beforeEach(() => {
    n += 1;
  });

  /** Seed a self-contained scenario (unique ids per test) and return its ids. */
  async function seedScenario(): Promise<{
    pkg: string;
    trailer: string;
    trip: string;
    mem: string;
    dfw: string;
  }> {
    const tag = `S${n}`;
    const mem = `${tag}-MEM`;
    const dfw = `${tag}-DFW`;
    const pkg = `${tag}-P1`;
    const trailer = `${tag}-T1`;
    const trip = `${tag}-TRIP1`;
    const es = eventStoreView(fx.db);

    // Routes (geometry for geo-track), then a package lifecycle + a trailer trip.
    await appendToStream(es, `route-${mem}-${dfw}`, 0, [routeRegistered(mem, dfw, GEOM_OUT)], at(0));
    await appendToStream(es, `route-${dfw}-${mem}`, 0, [routeRegistered(dfw, mem, GEOM_BACK)], at(0));
    await appendToStream(
      es,
      `package-${pkg}`,
      0,
      [pkgCreated(pkg, mem, dfw), scanned(pkg, mem, "inbound"), scanned(pkg, mem, "load")],
      at(1_000),
    );
    await appendToStream(
      es,
      `trailer-${trailer}`,
      0,
      [departed(trailer, mem, dfw, trip, [pkg]), trailerArrived(trailer, dfw, trip)],
      at(2_000),
    );
    await appendToStream(
      es,
      `package-${pkg}`,
      3,
      [scanned(pkg, dfw, "unload"), pkgArrived(pkg, dfw)],
      at(3_000),
    );
    return { pkg, trailer, trip, mem, dfw };
  }

  it("builds a package's full ordered audit timeline (FND-08)", async () => {
    const { pkg, mem, dfw } = await seedScenario();
    const db = catchupView(fx.db);

    await runCatchup(db, replayReadAll);
    const timeline = await readAuditTimeline(db, pkg);

    // Exactly the five package-naming events, in order, no gaps/reorder.
    expect(timeline.map((e) => e.eventType)).toEqual([
      "PackageCreated",
      "PackageScanned",
      "PackageScanned",
      "PackageScanned",
      "PackageArrivedAtHub",
    ]);
    // Strictly increasing global_seq (the total order).
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i]!.globalSeq > timeline[i - 1]!.globalSeq).toBe(true);
    }
    // Each entry carries eventType + occurredAt + relevant fields.
    expect(timeline[0]!.hubId).toBe(mem); // PackageCreated -> originHub
    expect(timeline[1]!.scanType).toBe("inbound");
    expect(timeline[2]!.scanType).toBe("load");
    expect(timeline[3]!.scanType).toBe("unload");
    expect(timeline[3]!.hubId).toBe(dfw);
    expect(timeline[4]!.eventType).toBe("PackageArrivedAtHub");
    expect(timeline[4]!.hubId).toBe(dfw);
    expect(timeline.every((e) => typeof e.occurredAt === "string" && e.occurredAt.length > 0)).toBe(
      true,
    );
  });

  it("advances the checkpoint and is idempotent (no duplicate rows on re-run)", async () => {
    const { pkg } = await seedScenario();
    const db = catchupView(fx.db);

    const first = await runCatchup(db, replayReadAll);
    expect(first.auditTimeline).toBeGreaterThan(0);
    const head = (await readAll(eventStoreView(fx.db), 0n)).at(-1)!.globalSeq;

    async function lastSeq(projection: string): Promise<bigint> {
      const row = await fx.db
        .selectFrom("projection_checkpoints")
        .select("last_seq")
        .where("projection", "=", projection)
        .executeTakeFirst();
      return row === undefined ? 0n : BigInt(row.last_seq);
    }
    expect(await lastSeq("audit-timeline")).toBe(head);
    expect(await lastSeq("geo-track")).toBe(head);

    const timelineOnce = await readAuditTimeline(db, pkg);
    const keyframesOnce = await readGeoKeyframes(db);

    // Re-running is a bounded no-op: zero new audit events, identical rows.
    const second = await runCatchup(db, replayReadAll);
    expect(second.auditTimeline).toBe(0);
    expect(await readAuditTimeline(db, pkg)).toEqual(timelineOnce);
    expect(await readGeoKeyframes(db)).toEqual(keyframesOnce);
  });

  it("yields deterministic per-trip geo keyframes along route geometry", async () => {
    const { trailer, trip, mem, dfw } = await seedScenario();
    const db = catchupView(fx.db);
    await runCatchup(db, replayReadAll);

    const mine = (await readGeoKeyframes(db)).filter(
      (k) => k.trailerId === trailer && k.tripId === trip,
    );
    expect(mine.map((k) => k.kind)).toEqual(["arrive", "depart"]); // sorted by kind

    const depart = mine.find((k) => k.kind === "depart")!;
    const arrive = mine.find((k) => k.kind === "arrive")!;
    // depart sits at the ORIGIN (first vertex of MEM->DFW geometry).
    expect([depart.lon, depart.lat]).toEqual(GEOM_OUT[0]);
    // arrive sits at the DESTINATION (last vertex of a leg into DFW).
    expect([arrive.lon, arrive.lat]).toEqual(GEOM_OUT[GEOM_OUT.length - 1]);
    expect(depart.lat).toBeGreaterThan(arrive.lat); // MEM is north of DFW here
    void mem;
    void dfw;
  });

  it("M-4: a hub with 2+ inbound legs resolves the arrival keyframe by the trip's ACTUAL leg", async () => {
    // Topology: TWO inbound legs into a shared hub ZZZ with DISTINCT terminal
    // vertices. The trailer travels the BBB->ZZZ leg (the lexicographically
    // LARGER key); the old code would have mis-resolved to AAA->ZZZ.
    const tag = `M4-${n}`;
    const aaa = `${tag}-AAA`;
    const bbb = `${tag}-BBB`;
    const zzz = `${tag}-ZZZ`;
    const trailer = `${tag}-T1`;
    const trip = `${tag}-TRIP1`;
    const es = eventStoreView(fx.db);

    const legA: LonLat[] = [
      [-100, 40],
      [-95, 38], // AAA->ZZZ terminal vertex
    ];
    const legB: LonLat[] = [
      [-80, 30],
      [-85, 32], // BBB->ZZZ terminal vertex (different)
    ];
    await appendToStream(es, `route-${aaa}-${zzz}`, 0, [routeRegistered(aaa, zzz, legA)], at(0));
    await appendToStream(es, `route-${bbb}-${zzz}`, 0, [routeRegistered(bbb, zzz, legB)], at(0));

    const db = catchupView(fx.db);
    // First catch-up pass: ONLY the departure on BBB->ZZZ (arrival not yet in log).
    await appendToStream(es, `trailer-${trailer}`, 0, [departed(trailer, bbb, zzz, trip, [])], at(1_000));
    await runCatchup(db, replayReadAll);

    // Second pass: the arrival lands in a SEPARATE catch-up pass — its leg must be
    // resolved from the PERSISTED in-flight index, not re-derived in-memory.
    await appendToStream(es, `trailer-${trailer}`, 1, [trailerArrived(trailer, zzz, trip)], at(2_000));
    await runCatchup(db, replayReadAll);

    const mine = (await readGeoKeyframes(db)).filter(
      (k) => k.trailerId === trailer && k.tripId === trip,
    );
    const arrive = mine.find((k) => k.kind === "arrive")!;
    // Lands on the BBB->ZZZ terminal vertex, NOT the AAA->ZZZ one.
    expect([arrive.lon, arrive.lat]).toEqual(legB[legB.length - 1]);
    expect([arrive.lon, arrive.lat]).not.toEqual(legA[legA.length - 1]);

    // Determinism: a full rebuild reproduces byte-identical state even though the
    // in-flight resolution crossed two incremental passes.
    const live = await serializeCatchup(db);
    await rebuildCatchup(db, replayReadAll);
    expect(await serializeCatchup(db)).toBe(live);
  });

  it("rebuild (truncate + replay from 0) yields identical audit + geo state", async () => {
    await seedScenario();
    const db = catchupView(fx.db);

    await runCatchup(db, replayReadAll);
    const live = await serializeCatchup(db);

    await rebuildCatchup(db, replayReadAll);
    const rebuilt = await serializeCatchup(db);

    expect(rebuilt).toBe(live);

    // A second rebuild is identical to the first (replay is deterministic).
    await rebuildCatchup(db, replayReadAll);
    expect(await serializeCatchup(db)).toBe(live);
  });
});
