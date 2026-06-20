import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  appendToStream,
  readAll,
  readStream,
  type StoredEvent,
} from "../src/index.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * FND-01: append-only JSONB persistence + round-trip via readStream/readAll,
 * against a REAL Postgres container (OrbStack via Testcontainers).
 *
 * Helpers craft distinct domain events so JSONB round-trips are observable and
 * `occurred_at` can be deliberately set OUT OF ORDER vs insertion to prove
 * readAll orders by `global_seq`, never by timestamp.
 */

function pkgCreated(packageId: string): DomainEvent {
  return {
    type: "PackageCreated",
    schemaVersion: 1,
    payload: {
      packageId,
      originHubId: "MEM",
      destHubId: "LAX",
      sizeClass: "medium",
      weight: 12.5,
    },
  };
}

function pkgScanned(packageId: string): DomainEvent {
  return {
    type: "PackageScanned",
    schemaVersion: 1,
    payload: { packageId, hubId: "MEM", scanType: "inbound" },
  };
}

/** A fixed past instant; tests offset from it to control ordering. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetMs: number): Date => new Date(T0 + offsetMs);

describe("event store: append-only persistence + ordered reads (FND-01)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  // Unique stream ids per test keep cases independent on the shared container.
  let n = 0;
  let stream = "";
  beforeEach(() => {
    n += 1;
    stream = `package-P${n}`;
  });

  it("appends 3 events to a fresh stream and round-trips them in version order", async () => {
    const events: DomainEvent[] = [
      pkgCreated("P1"),
      pkgScanned("P1"),
      pkgScanned("P1"),
    ];

    const { newVersion } = await appendToStream(fx.db, stream, 0, events, at(0));
    expect(newVersion).toBe(3);

    const stored = await readStream(fx.db, stream);
    expect(stored).toHaveLength(3);
    expect(stored.map((s) => s.version)).toEqual([1, 2, 3]);
    expect(stored.map((s) => s.streamId)).toEqual([stream, stream, stream]);
    // JSONB `data` round-trips intact as the typed DomainEvent.
    expect(stored[0]?.event).toEqual(events[0]);
    expect(stored[1]?.event).toEqual(events[1]);
    expect(stored[2]?.event).toEqual(events[2]);
    // globalSeq is a strictly increasing bigint total order.
    expect(typeof stored[0]?.globalSeq).toBe("bigint");
    expect((stored[1]?.globalSeq ?? 0n) > (stored[0]?.globalSeq ?? 0n)).toBe(
      true,
    );
    // recorded_at is the DB-clock field and is present.
    expect(typeof stored[0]?.recordedAt).toBe("string");
  });

  it("appends more events at the current version with contiguous versions", async () => {
    await appendToStream(fx.db, stream, 0, [pkgCreated("P")], at(0));
    const { newVersion } = await appendToStream(
      fx.db,
      stream,
      1,
      [pkgScanned("P"), pkgScanned("P")],
      at(10),
    );
    expect(newVersion).toBe(3);

    const stored = await readStream(fx.db, stream);
    expect(stored.map((s) => s.version)).toEqual([1, 2, 3]);
  });

  it("readAll orders strictly by global_seq, NOT by occurred_at", async () => {
    const baseline = await readAll(fx.db, 0n);
    const from = baseline.at(-1)?.globalSeq ?? 0n;

    const streamA = `pkg-A${n}`;
    const streamB = `pkg-B${n}`;

    // Insert A first but with a LATER occurred_at; B second with an EARLIER
    // occurred_at. If readAll mistakenly sorted by time, B would come first.
    await appendToStream(fx.db, streamA, 0, [pkgCreated("A")], at(10_000));
    await appendToStream(fx.db, streamB, 0, [pkgCreated("B")], at(1_000));

    const tail = await readAll(fx.db, from);
    const newOnes = tail.filter(
      (s) => s.streamId === streamA || s.streamId === streamB,
    );
    expect(newOnes.map((s) => s.streamId)).toEqual([streamA, streamB]);

    // global_seq is strictly ascending across the whole read.
    for (let i = 1; i < tail.length; i += 1) {
      expect((tail[i]?.globalSeq ?? 0n) > (tail[i - 1]?.globalSeq ?? 0n)).toBe(
        true,
      );
    }
  });

  it("readAll(fromGlobalSeq) returns only events strictly after the position", async () => {
    await appendToStream(fx.db, stream, 0, [pkgCreated("P")], at(0));
    const all = await readAll(fx.db, 0n);
    expect(all.length).toBeGreaterThan(0);
    const cut = all[Math.floor(all.length / 2)]?.globalSeq ?? 0n;
    const after = await readAll(fx.db, cut);
    expect(after.every((s) => s.globalSeq > cut)).toBe(true);
    expect(after.some((s) => s.globalSeq === cut)).toBe(false);
  });

  it("exposes no update/delete path — the store API is append-only", async () => {
    // Compile-time + runtime guard: the public surface offers only append/read.
    const api = await import("../src/index.js");
    const mutators = Object.keys(api).filter((k) =>
      /update|delete|remove|truncate/i.test(k),
    );
    expect(mutators).toEqual([]);
    const surface: StoredEvent[] = await readStream(fx.db, "nonexistent");
    expect(surface).toEqual([]);
  });
});
