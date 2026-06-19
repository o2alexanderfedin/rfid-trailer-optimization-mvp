import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DomainEvent } from "@mm/domain";
import { appendToStream, readAll } from "@mm/event-store";
import {
  applyInline,
  projectionView,
  type ProjectionDb,
  readOperationalTwin,
  rebuildProjections,
  type ReplayEvent,
  serializeTwin,
} from "../src/index.js";
import { eventStoreView, startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * The injected log reader for `rebuildProjections`. It receives the SAME
 * connection (typed as the projection sub-schema) and reads the whole event log
 * via `@mm/event-store`'s `readAll`, viewing the handle as `Kysely<Database>`.
 * `StoredEvent` is a structural superset of `ReplayEvent`, so the result flows
 * through unchanged.
 */
function replayReadAll(
  db: Kysely<ProjectionDb>,
  fromGlobalSeq: bigint,
): Promise<readonly ReplayEvent[]> {
  // The runtime instance owns the full event-store schema; view it as such.
  return readAll(eventStoreView(db as unknown as PgFixture["db"]), fromGlobalSeq);
}

/**
 * FND-04 — THE KEYSTONE GOLDEN-REPLAY TEST.
 *
 * Build the operational twin LIVE by appending a seeded event stream and
 * applying each event inline. Capture the live twin (deterministic, sorted-key
 * serialization). Then INDEPENDENTLY rebuild the same read models by TRUNCATEing
 * the projection tables, resetting checkpoints to 0, and replaying `readAll(0n)`
 * strictly by global_seq through the SAME inline applier. Assert the rebuilt
 * twin is BYTE-IDENTICAL to the live twin.
 *
 * This is the phase's determinism keystone (P3): live state == state rebuilt
 * from the log, byte-for-byte. If any reducer leaked ambient nondeterminism
 * (Date.now/Math.random/unstable sort), the two serializations would differ.
 */

const T0 = Date.parse("2026-04-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);

// --- Event builders ---------------------------------------------------------
function pkgCreated(packageId: string, origin: string, dest: string): DomainEvent {
  return {
    type: "PackageCreated",
    schemaVersion: 1,
    payload: { packageId, originHubId: origin, destHubId: dest, sizeClass: "medium", weight: 10 },
  };
}
function scanned(
  packageId: string,
  hubId: string,
  scanType: "inbound" | "outbound" | "load" | "unload",
): DomainEvent {
  return { type: "PackageScanned", schemaVersion: 1, payload: { packageId, hubId, scanType } };
}
function arrived(packageId: string, hubId: string): DomainEvent {
  return { type: "PackageArrivedAtHub", schemaVersion: 1, payload: { packageId, hubId } };
}
function departed(
  trailerId: string,
  fromHubId: string,
  toHubId: string,
  tripId: string,
  packageIds: string[],
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId, packageIds },
  };
}
function trailerArrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return { type: "TrailerArrivedAtHub", schemaVersion: 1, payload: { trailerId, hubId, tripId } };
}
function docked(trailerId: string, hubId: string, dockDoorId: string): DomainEvent {
  return { type: "TrailerDocked", schemaVersion: 1, payload: { trailerId, hubId, dockDoorId } };
}

interface Seed {
  readonly stream: string;
  readonly events: readonly DomainEvent[];
  /** occurredAt offset (ms) for this append batch — deliberately varied. */
  readonly offsetMs: number;
}

describe("GOLDEN REPLAY: live twin == rebuilt-from-log twin, byte-identical (FND-04)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("rebuilds the operational twin byte-identically from global_seq=0", async () => {
    // A multi-entity seeded stream touching all three projections. occurredAt
    // offsets are intentionally NOT monotonic vs append order, to prove replay
    // orders by global_seq and reducers read time only from occurredAt.
    const tag = "GR";
    const P = (s: string): string => `${tag}-${s}`;
    const seeds: Seed[] = [
      { stream: `package-${P("A")}`, offsetMs: 5_000, events: [pkgCreated(P("A"), P("MEM"), P("LAX")), arrived(P("A"), P("MEM")), scanned(P("A"), P("MEM"), "inbound")] },
      { stream: `package-${P("B")}`, offsetMs: 1_000, events: [pkgCreated(P("B"), P("MEM"), P("DFW")), scanned(P("B"), P("MEM"), "inbound"), scanned(P("B"), P("MEM"), "load")] },
      { stream: `package-${P("C")}`, offsetMs: 9_000, events: [pkgCreated(P("C"), P("DFW"), P("LAX")), arrived(P("C"), P("DFW")), scanned(P("C"), P("DFW"), "unload"), scanned(P("C"), P("DFW"), "outbound")] },
      { stream: `trailer-${P("T1")}`, offsetMs: 3_000, events: [departed(P("T1"), P("MEM"), P("DFW"), P("TRIP1"), [P("B"), P("A")]), trailerArrived(P("T1"), P("DFW"), P("TRIP1")), docked(P("T1"), P("DFW"), P("DOCK1"))] },
      { stream: `trailer-${P("T2")}`, offsetMs: 2_000, events: [departed(P("T2"), P("DFW"), P("LAX"), P("TRIP2"), [P("C")])] },
      { stream: `package-${P("A")}`, offsetMs: 7_000, events: [scanned(P("A"), P("DFW"), "unload")] },
    ];

    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);

    // --- LIVE: append each batch, then apply every NEW stored event inline ---
    let cursor = 0n;
    for (const seed of seeds) {
      // appendToStream needs the current version of the stream.
      const current = await es
        .selectFrom("streams")
        .select("version")
        .where("stream_id", "=", seed.stream)
        .executeTakeFirst();
      await appendToStream(es, seed.stream, current?.version ?? 0, seed.events, at(seed.offsetMs));

      const fresh = await readAll(es, cursor);
      for (const ev of fresh) await applyInline(proj, ev);
      if (fresh.length > 0) cursor = fresh[fresh.length - 1]!.globalSeq;
    }

    const liveTwin = await readOperationalTwin(proj);
    const liveSerialized = serializeTwin(liveTwin);

    // Sanity: the live twin is non-trivial and matches the documented semantics.
    expect(liveTwin.packageLocation.get(P("A"))?.hubId).toBe(P("DFW")); // last scan moved it
    expect(liveTwin.packageLocation.get(P("B"))?.hubId).toBe(P("MEM"));
    expect(liveTwin.trailerState.get(P("T1"))?.status).toBe("docked");
    expect(liveTwin.trailerState.get(P("T1"))?.assignedPackageIds).toEqual([P("A"), P("B")]);
    expect(liveTwin.trailerState.get(P("T2"))?.status).toBe("in_transit");
    // B was loaded (removed from hub inventory); C ended outbound at DFW.
    expect(liveTwin.hubInventory.get(P("DFW"))?.outbound).toEqual([P("C")]);

    // --- REBUILD: truncate + reset checkpoints + replay from global_seq=0 ----
    await rebuildProjections(proj, replayReadAll);
    const rebuiltTwin = await readOperationalTwin(proj);
    const rebuiltSerialized = serializeTwin(rebuiltTwin);

    // THE KEYSTONE ASSERTION: byte-identical serialization.
    expect(rebuiltSerialized).toBe(liveSerialized);
    // And structurally deep-equal as a second, independent check.
    expect(rebuiltTwin).toEqual(liveTwin);
  });

  it("a second rebuild is identical to the first (replay is deterministic)", async () => {
    const proj = projectionView(fx.db);
    await rebuildProjections(proj, replayReadAll);
    const a = serializeTwin(await readOperationalTwin(proj));
    await rebuildProjections(proj, replayReadAll);
    const b = serializeTwin(await readOperationalTwin(proj));
    expect(b).toBe(a);
  });
});
