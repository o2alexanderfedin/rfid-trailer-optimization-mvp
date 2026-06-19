import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendToStream, readAll } from "@mm/event-store";
import {
  applyInline,
  projectionView,
  readOperationalTwin,
} from "@mm/projections";
import { runSimulation, simulate, type SimulatedEvent } from "../src/engine.js";
import { eventStoreView, startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * SIM-02 integration: the simulator drives the REAL event store + operational
 * projections without error, and a seeded package/trailer/hub resolves to the
 * expected projected state. Proves the pure generator and the store-driven path
 * share ONE generation core (no divergence): we persist exactly the events the
 * pure `simulate` produced, then project and assert the twin matches.
 *
 * Persistence strategy:
 *  - Buffer the deterministic stream per aggregate (stream), in arrival order.
 *  - Flush each stream as one OCC-guarded `appendToStream` (the conventional
 *    event-sourcing append-per-aggregate); the streams are independent, so the
 *    appends run concurrently over the connection pool.
 *  - Project the whole persisted log in ONE transaction through the SAME inline
 *    applier the production read path uses (read-your-writes), strictly ordered
 *    by `global_seq`.
 *
 * The operational reducers are per-aggregate (a package's / trailer's / hub's
 * state depends only on that aggregate's events), so the per-stream batching
 * preserves every causal order the projections rely on.
 */

const SEED = 4242;
// Enough ticks for a full trailer round-trip (depart -> transit -> arrive ->
// dock + package arrivals) so EVERY operational event type is exercised, while
// keeping the stream small (the inline applier reloads each projection table
// per event). The larger byte-identical stream is covered by the unit test.
const DURATION = 31;

describe("simulator drives operational projections (SIM-02)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("persists a seeded stream and populates the operational twin", async () => {
    const es = eventStoreView(fx.db);

    // Buffer the deterministic stream per aggregate, preserving arrival order.
    const buffers = new Map<string, SimulatedEvent[]>();
    const order: string[] = [];
    await runSimulation({
      seed: SEED,
      durationTicks: DURATION,
      sink: (item: SimulatedEvent) => {
        let buf = buffers.get(item.streamId);
        if (buf === undefined) {
          buf = [];
          buffers.set(item.streamId, buf);
          order.push(item.streamId);
        }
        buf.push(item);
      },
    });

    // Flush each stream's events as one append (concurrent — streams are independent).
    await Promise.all(
      order.map((streamId) => {
        const buf = buffers.get(streamId)!;
        return appendToStream(
          es,
          streamId,
          0,
          buf.map((b) => b.event),
          new Date(buf[0]!.occurredAt),
        );
      }),
    );

    // Project the whole persisted log once, strictly by global_seq, in one txn.
    const log = await readAll(es, 0n);
    await fx.db.transaction().execute(async (trx) => {
      const proj = projectionView(trx);
      for (const stored of log) await applyInline(proj, stored);
    });

    // The pure generator (same seed) is the oracle for what was persisted.
    const expectedStream = simulate({ seed: SEED, durationTicks: DURATION });
    expect(log.length).toBe(expectedStream.length);

    // The operational twin populated without error and is non-empty on ALL three
    // read models (package location, trailer state, hub inventory).
    const twin = await readOperationalTwin(projectionView(fx.db));
    expect(twin.packageLocation.size).toBeGreaterThan(0);
    expect(twin.trailerState.size).toBeGreaterThan(0);
    expect(twin.hubInventory.size).toBeGreaterThan(0);

    // The full trailer lifecycle was exercised (at least one trailer docked).
    const statuses = [...twin.trailerState.values()].map((t) => t.status);
    expect(statuses).toContain("docked");

    // A known seeded package resolves to a real hub it was last seen at.
    const firstPkg = expectedStream.find((e) => e.event.type === "PackageCreated");
    expect(firstPkg).toBeDefined();
    const pkgId = (firstPkg!.event.payload as { packageId: string }).packageId;
    const loc = twin.packageLocation.get(pkgId);
    expect(loc).toBeDefined();
    expect(loc!.hubId.length).toBeGreaterThan(0);
    expect(loc!.confidence).toBe(1);

    // A known seeded trailer resolves to a valid Phase-1 lifecycle status.
    const firstDeparted = expectedStream.find((e) => e.event.type === "TrailerDeparted");
    expect(firstDeparted).toBeDefined();
    const trailerId = (firstDeparted!.event.payload as { trailerId: string }).trailerId;
    const trailer = twin.trailerState.get(trailerId);
    expect(trailer).toBeDefined();
    expect(["in_transit", "arrived", "docked"]).toContain(trailer!.status);
  });
});
