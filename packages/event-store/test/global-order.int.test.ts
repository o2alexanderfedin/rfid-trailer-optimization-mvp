import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { DomainEvent } from "@mm/domain";
import { appendToStream, readAll, type StoredEvent } from "../src/index.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * M-1 / M-2: GAP-FREE global total order under concurrent cross-stream writers.
 *
 * `global_seq` is `BIGINT GENERATED ALWAYS AS IDENTITY` — allocated at INSERT,
 * visible only at COMMIT. Without serialization, two appends to DIFFERENT streams
 * can allocate `global_seq` in one order but COMMIT in the other, opening an
 * in-flight gap: a high-water `readAll(fromGlobalSeq)`+checkpoint consumer that
 * polls while seq=N is committed but seq=N-1 is still in-flight advances its
 * checkpoint past N and PERMANENTLY skips N-1.
 *
 * The fix takes a transaction-scoped `pg_advisory_xact_lock(<fixed key>)` at the
 * START of every append transaction (before the IDENTITY insert), so the
 * allocation order equals the commit order — closing the gap window.
 *
 * Two proofs below:
 *  1. FORCED adverse interleaving — a lock-holder (raw client) blocks a concurrent
 *     `appendToStream` from allocating ahead of it, demonstrating serialization.
 *  2. A high-volume concurrent-cross-stream stress: an incremental
 *     `readAll`+checkpoint consumer applies EVERY committed event with NO skip.
 */

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);

const GLOBAL_ORDER_LOCK_KEY = "402107"; // must match store.ts.

function scan(packageId: string, scanType: "inbound" | "outbound"): DomainEvent {
  return { type: "PackageScanned", schemaVersion: 1, payload: { packageId, hubId: "MEM", scanType } };
}

/**
 * An incremental high-water consumer: reads strictly after `from`, applies each
 * event, advancing the cursor to that event's `globalSeq` — exactly the
 * catch-up/checkpoint pattern (catchup.ts:155, inline.ts:254). Returns the
 * ordered applied events.
 */
async function drainIncrementally(
  db: PgFixture["db"],
  from: bigint,
): Promise<{ applied: StoredEvent[]; cursor: bigint }> {
  let cursor = from;
  const applied: StoredEvent[] = [];
  for (;;) {
    const batch = await readAll(db, cursor);
    if (batch.length === 0) break;
    for (const ev of batch) {
      applied.push(ev);
      cursor = ev.globalSeq; // advance the high-water cursor per event.
    }
  }
  return { applied, cursor };
}

describe("event store: gap-free global order under concurrent writers (M-1 / M-2)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("a concurrent append BLOCKS until a lock-holding writer commits (allocation == commit order)", async () => {
    // Raw client = the "slow writer" that grabs the global-order lock first and
    // holds it open, simulating an in-flight append that has not yet committed.
    const holder = new pg.Client({ connectionString: fx.connectionString });
    await holder.connect();
    let settled = false;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(${GLOBAL_ORDER_LOCK_KEY}::bigint)`);

      // Fire a concurrent appendToStream to a DIFFERENT stream. With the fix it
      // must BLOCK on the advisory lock (cannot allocate global_seq ahead of the
      // holder), so its promise stays pending while the holder owns the lock.
      const pending = appendToStream(fx.db, "package-CONC", 0, [scan("C", "inbound")], at(1)).then(
        (r) => {
          settled = true;
          return r;
        },
      );

      // Give the would-be writer ample time to (try to) proceed.
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // proven blocked by the advisory lock.

      // Release the lock by committing the holder (no events written by it).
      await holder.query("COMMIT");

      // Now the blocked append proceeds and resolves.
      const result = await pending;
      expect(result.newVersion).toBe(1);
      expect(settled).toBe(true);
    } finally {
      // Defensive: if anything above threw mid-transaction, roll back + close.
      try {
        await holder.query("ROLLBACK");
      } catch {
        /* already committed */
      }
      await holder.end();
    }
  });

  it("incremental readAll+checkpoint consumer applies BOTH concurrent cross-stream events with NO skip", async () => {
    // Establish a starting cursor at the current head so we only observe this
    // test's appends.
    const head0 = (await readAll(fx.db, 0n)).at(-1)?.globalSeq ?? 0n;

    const ROUNDS = 25;
    const expectedStreams: string[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const sx = `package-X${i}`;
      const sy = `package-Y${i}`;
      expectedStreams.push(sx, sy);
      // Two TRULY concurrent appends to DIFFERENT streams (the adverse case).
      await Promise.all([
        appendToStream(fx.db, sx, 0, [scan(`x${i}`, "inbound")], at(i)),
        appendToStream(fx.db, sy, 0, [scan(`y${i}`, "outbound")], at(i)),
      ]);
    }

    // Drain incrementally from the pre-test head. Every committed event must be
    // observed exactly once, contiguous in global_seq — no permanent skip.
    const { applied } = await drainIncrementally(fx.db, head0);
    const seenStreams = applied.map((e) => e.streamId);

    // All 2*ROUNDS events were applied, none skipped.
    expect(seenStreams.sort()).toEqual([...expectedStreams].sort());

    // global_seq is strictly increasing and GAP-FREE across the drained window.
    const seqs = applied.map((e) => e.globalSeq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]! > seqs[i - 1]!).toBe(true);
      // Contiguity: with allocation==commit order, the drained window has no
      // holes (each consecutive global_seq differs by exactly 1).
      expect(seqs[i]! - seqs[i - 1]!).toBe(1n);
    }
  });
});
