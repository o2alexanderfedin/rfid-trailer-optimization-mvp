import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import { appendToStream, readAll } from "@mm/event-store";
import {
  applyInline,
  projectionView,
  type ProjectionDb,
  rebuildProjections,
  type ReplayEvent,
} from "@mm/projections";
import type { Kysely } from "kysely";
import {
  eventStoreView,
  type FixtureDb,
  startPgFixture,
  type PgFixture,
} from "./pg-fixture.js";

/**
 * Plan 03-05 (SNS-02) inline tag-registry + zone-estimate read models, against a
 * REAL Postgres (Testcontainers). Proves: (a) read-your-writes — a PackageCreated
 * + RfidObserved fold to a persisted, attributable zone estimate; (b) idempotent
 * re-apply is a strict no-op (P5a); (c) an unmapped tag yields NO estimate
 * (T-03-13); (d) the persisted confidence is < 1.0 (anti-P5b); (e) truncate +
 * replay rebuilds these tables byte-identically (FND-04).
 *
 * Hosted in `@mm/api` (depends on event-store + projections) so the workspace
 * DAG stays acyclic.
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);

function pkgCreated(packageId: string, rfidTagId?: string): DomainEvent {
  return {
    type: "PackageCreated",
    schemaVersion: 1,
    payload: {
      packageId,
      originHubId: "MEM",
      destHubId: "LAX",
      sizeClass: "medium",
      weight: 10,
      ...(rfidTagId === undefined ? {} : { rfidTagId }),
    },
  };
}

function rfid(tagId: string, trailerId: string): DomainEvent {
  return {
    type: "RfidObserved",
    schemaVersion: 1,
    payload: {
      tagId,
      readerId: "READER-1",
      antennaId: "ANT-1",
      rssi: -50,
      trailerId,
      hubId: "MEM",
      confidence: 0.8,
    },
  };
}

function replayReadAll(
  db: Kysely<ProjectionDb>,
  fromGlobalSeq: bigint,
): Promise<readonly ReplayEvent[]> {
  return readAll(eventStoreView(db as unknown as FixtureDb), fromGlobalSeq);
}

describe("inline tag-registry + zone-estimate (SNS-02)", () => {
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

  it("registers a tag and folds RfidObserved into a persisted zone estimate (read-your-writes)", async () => {
    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);
    const pkg = `PKG-Z-${n}`;
    const tag = `TAG-Z-${n}`;
    const trailer = `TRL-Z-${n}`;
    const stream = `package-${pkg}`;

    await appendToStream(es, stream, 0, [pkgCreated(pkg, tag), rfid(tag, trailer)], at(0));
    const all = await readAll(es, 0n);
    const mine = all.filter((e) => e.streamId === stream);
    for (const ev of mine) await applyInline(proj, ev);

    const reg = await fx.db
      .selectFrom("tag_registry")
      .selectAll()
      .where("tag_id", "=", tag)
      .executeTakeFirst();
    expect(reg?.package_id).toBe(pkg);

    const est = await fx.db
      .selectFrom("zone_estimate")
      .selectAll()
      .where("package_id", "=", pkg)
      .where("trailer_id", "=", trailer)
      .executeTakeFirst();
    expect(est).toBeDefined();
    expect(Number(est!.confidence)).toBeLessThan(1.0); // anti-P5b
    expect(["rear", "middle", "nose"]).toContain(est!.estimated_zone);
  });

  it("re-applying the same events is a strict no-op (P5a idempotency)", async () => {
    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);
    const pkg = `PKG-IDEM-${n}`;
    const tag = `TAG-IDEM-${n}`;
    const trailer = `TRL-IDEM-${n}`;
    const stream = `package-${pkg}`;

    await appendToStream(es, stream, 0, [pkgCreated(pkg, tag), rfid(tag, trailer)], at(0));
    const mine = (await readAll(es, 0n)).filter((e) => e.streamId === stream);
    for (const ev of mine) await applyInline(proj, ev);
    const first = await fx.db
      .selectFrom("zone_estimate")
      .selectAll()
      .where("package_id", "=", pkg)
      .executeTakeFirst();

    // Re-apply every event again: checkpoints gate the skip.
    for (const ev of mine) await applyInline(proj, ev);
    const second = await fx.db
      .selectFrom("zone_estimate")
      .selectAll()
      .where("package_id", "=", pkg)
      .executeTakeFirst();

    expect(second).toEqual(first);
    const count = await fx.db
      .selectFrom("zone_estimate")
      .select((eb) => eb.fn.countAll<string>().as("c"))
      .where("package_id", "=", pkg)
      .executeTakeFirst();
    expect(Number(count?.c)).toBe(1);
  });

  it("an UNMAPPED tag produces NO zone estimate (T-03-13, never an exception)", async () => {
    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);
    const trailer = `TRL-UNK-${n}`;
    const stream = `rfid-UNK-${n}`;

    // RfidObserved for a tag never bound by any PackageCreated.
    await appendToStream(es, stream, 0, [rfid(`TAG-UNMAPPED-${n}`, trailer)], at(0));
    const mine = (await readAll(es, 0n)).filter((e) => e.streamId === stream);
    for (const ev of mine) await applyInline(proj, ev);

    const est = await fx.db
      .selectFrom("zone_estimate")
      .selectAll()
      .where("trailer_id", "=", trailer)
      .executeTakeFirst();
    expect(est).toBeUndefined();
  });

  it("truncate + replay rebuilds tag_registry + zone_estimate byte-identically (FND-04)", async () => {
    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);
    const pkg = `PKG-RB-${n}`;
    const tag = `TAG-RB-${n}`;
    const trailer = `TRL-RB-${n}`;
    const stream = `package-${pkg}`;

    await appendToStream(
      es,
      stream,
      0,
      [pkgCreated(pkg, tag), rfid(tag, trailer), rfid(tag, trailer)],
      at(0),
    );
    const mine = (await readAll(es, 0n)).filter((e) => e.streamId === stream);
    for (const ev of mine) await applyInline(proj, ev);

    const live = await fx.db
      .selectFrom("zone_estimate")
      .selectAll()
      .orderBy("package_id")
      .orderBy("trailer_id")
      .execute();

    await rebuildProjections(proj, replayReadAll);

    const rebuilt = await fx.db
      .selectFrom("zone_estimate")
      .selectAll()
      .orderBy("package_id")
      .orderBy("trailer_id")
      .execute();

    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(live));
    const regRebuilt = await fx.db
      .selectFrom("tag_registry")
      .selectAll()
      .where("tag_id", "=", tag)
      .executeTakeFirst();
    expect(regRebuilt?.package_id).toBe(pkg);
  });
});
