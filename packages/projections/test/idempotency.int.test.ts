import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import { appendToStream, readAll } from "@mm/event-store";
import { applyInline, projectionView, readOperationalTwin } from "../src/index.js";
import { eventStoreView, startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * Task 2 (RED → GREEN), P5a: inline application is IDEMPOTENT.
 *
 * Re-applying an already-processed stored event is a strict no-op: the
 * projection state and counts are unchanged because each projection's
 * `projection_checkpoints.last_seq` gates the skip (the event's global_seq is
 * at/below the stored last_seq). This proves the fold can never double-count on
 * restart/replay/at-least-once delivery.
 */

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);

function scanned(
  packageId: string,
  hubId: string,
  scanType: "inbound" | "outbound" | "load" | "unload",
): DomainEvent {
  return { type: "PackageScanned", schemaVersion: 1, payload: { packageId, hubId, scanType } };
}

describe("inline projection idempotency (P5a, FND-05/07)", () => {
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

  async function lastSeq(projection: string): Promise<bigint> {
    const row = await fx.db
      .selectFrom("projection_checkpoints")
      .select("last_seq")
      .where("projection", "=", projection)
      .executeTakeFirst();
    return row === undefined ? 0n : BigInt(row.last_seq);
  }

  it("re-applying the same stored event is a no-op (state + counts unchanged)", async () => {
    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);
    const stream = `package-IDEMP-${n}`;
    const pkg = `PKG-IDEMP-${n}`;
    const hub = `HUB-IDEMP-${n}`;
    await appendToStream(es, stream, 0, [scanned(pkg, hub, "inbound")], at(0));

    // Find the event we just appended.
    const all = await readAll(es, 0n);
    const mine = all.filter((e) => e.streamId === stream);
    expect(mine).toHaveLength(1);
    const stored = mine[0]!;

    // First application: package located + hub inbound bucket has exactly the one.
    await applyInline(proj, stored);
    const twin1 = await readOperationalTwin(proj);
    expect(twin1.packageLocation.get(pkg)?.hubId).toBe(hub);
    expect(twin1.hubInventory.get(hub)?.inbound).toEqual([pkg]);
    const seqAfterFirst = await lastSeq("hub-inventory");
    expect(seqAfterFirst).toBe(stored.globalSeq);

    // SECOND application of the SAME stored event: must be a no-op.
    await applyInline(proj, stored);
    const twin2 = await readOperationalTwin(proj);
    expect(twin2.hubInventory.get(hub)?.inbound).toEqual([pkg]); // not [pkg, pkg]
    expect(twin2.packageLocation.get(pkg)).toEqual(twin1.packageLocation.get(pkg));
    // The checkpoint did not advance further (still at the event's global_seq).
    expect(await lastSeq("hub-inventory")).toBe(seqAfterFirst);
  });

  it("a lower/equal global_seq event is skipped by the last_seq gate", async () => {
    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);
    const stream = `package-GATE-${n}`;
    const pkg = `PKG-GATE-${n}`;
    const hub = `HUB-GATE-${n}`;
    await appendToStream(
      es,
      stream,
      0,
      [scanned(pkg, hub, "inbound"), scanned(pkg, hub, "outbound")],
      at(0),
    );
    const all = await readAll(es, 0n);
    const mine = all.filter((e) => e.streamId === stream);
    expect(mine).toHaveLength(2);
    const [first, second] = mine as [(typeof mine)[number], (typeof mine)[number]];

    // Apply both in order — package ends up outbound.
    await applyInline(proj, first);
    await applyInline(proj, second);
    const afterBoth = await readOperationalTwin(proj);
    expect(afterBoth.hubInventory.get(hub)?.outbound).toEqual([pkg]);
    expect(afterBoth.hubInventory.get(hub)?.inbound).toEqual([]);

    // Re-applying the FIRST (older) event must NOT resurrect the inbound bucket:
    // its global_seq is <= the stored last_seq, so it's skipped.
    await applyInline(proj, first);
    const afterReplayOld = await readOperationalTwin(proj);
    expect(afterReplayOld.hubInventory.get(hub)?.outbound).toEqual([pkg]);
    expect(afterReplayOld.hubInventory.get(hub)?.inbound).toEqual([]);
  });
});
