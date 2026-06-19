import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  appendToStream,
  appendWithRetry,
  ConcurrencyError,
  readStream,
} from "../src/index.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * FND-02 / PITFALLS P4: optimistic concurrency under truly concurrent appends.
 *
 * Node async/await interleaving at the DB I/O boundary IS real concurrency:
 * two `appendToStream` calls at the same expectedVersion race around the
 * round-trip. Exactly one must win; the other must throw a typed, retryable
 * `ConcurrencyError`, leaving no version gaps or duplicate (stream_id, version)
 * rows. This guard protects the sim + (Phase 4) optimizer as concurrent
 * writers.
 */

type ScanType = "inbound" | "outbound" | "load" | "unload";

function scan(packageId: string, scanType: ScanType): DomainEvent {
  return {
    type: "PackageScanned",
    schemaVersion: 1,
    payload: { packageId, hubId: "MEM", scanType },
  };
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetMs: number): Date => new Date(T0 + offsetMs);

describe("event store: optimistic concurrency (FND-02 / P4)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  let n = 0;
  let stream = "";
  beforeEach(() => {
    n += 1;
    stream = `trailer-T${n}`;
  });

  it("two concurrent appends at the same expectedVersion: exactly one wins", async () => {
    // Seed v1 so both writers race at expectedVersion = 1.
    await appendToStream(fx.db, stream, 0, [scan("P0", "inbound")], at(0));

    const results = await Promise.allSettled([
      appendToStream(fx.db, stream, 1, [scan("A", "outbound")], at(1)),
      appendToStream(fx.db, stream, 1, [scan("B", "outbound")], at(2)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConcurrencyError,
    );

    // No gaps, no duplicate (stream_id, version): versions are exactly 1..2.
    const stored = await readStream(fx.db, stream);
    expect(stored.map((s) => s.version)).toEqual([1, 2]);
  });

  it("surfaces a raw Postgres 23505 as a typed ConcurrencyError (not a pg error)", async () => {
    await appendToStream(fx.db, stream, 0, [scan("P", "inbound")], at(0));
    // Stale expectedVersion (0) -> conflict.
    const err = await appendToStream(
      fx.db,
      stream,
      0,
      [scan("P", "outbound")],
      at(1),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConcurrencyError);
    expect((err as ConcurrencyError).streamId).toBe(stream);
    // A raw pg error would carry SQLSTATE `code` 23505 and NOT be our type.
    expect((err as { code?: string }).code).toBeUndefined();

    const stored = await readStream(fx.db, stream);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.version).toBe(1);
  });

  it("rolls back fully on conflict — zero partial inserts", async () => {
    await appendToStream(fx.db, stream, 0, [scan("P", "inbound")], at(0));
    // Try to append THREE events at a stale version; all must be rolled back.
    await expect(
      appendToStream(
        fx.db,
        stream,
        0,
        [scan("a", "load"), scan("b", "load"), scan("c", "load")],
        at(1),
      ),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    const stored = await readStream(fx.db, stream);
    expect(stored).toHaveLength(1); // only the seed event survives
  });

  it("appendWithRetry: the losing writer reloads + retries to success", async () => {
    await appendToStream(fx.db, stream, 0, [scan("seed", "inbound")], at(0));

    // Two writers each build one event off the CURRENT version and append with
    // retry. Both must ultimately succeed; the stream stays contiguous.
    const writer = (label: string): Promise<{ newVersion: number }> =>
      appendWithRetry(
        fx.db,
        stream,
        () => [scan(label, "outbound")],
        at(1),
        { maxRetries: 5 },
      );

    const [a, b] = await Promise.all([writer("A"), writer("B")]);
    expect(typeof a.newVersion).toBe("number");
    expect(typeof b.newVersion).toBe("number");

    const stored = await readStream(fx.db, stream);
    // Seed + both writers = 3 contiguous versions, both writers' events present.
    expect(stored.map((s) => s.version)).toEqual([1, 2, 3]);
    const labels = stored
      .map((s) => s.event)
      .filter((e) => e.type === "PackageScanned")
      .map((e) => (e.type === "PackageScanned" ? e.payload.packageId : ""));
    expect(labels).toContain("A");
    expect(labels).toContain("B");
  });

  it("appendWithRetry throws ConcurrencyError after exhausting retries", async () => {
    await appendToStream(fx.db, stream, 0, [scan("seed", "inbound")], at(0));
    // A builder that ALWAYS targets version 0 can never converge -> exhausts.
    await expect(
      appendWithRetry(
        fx.db,
        stream,
        () => [scan("never", "outbound")],
        at(1),
        { maxRetries: 0, expectedVersion: () => 0 },
      ),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });
});
