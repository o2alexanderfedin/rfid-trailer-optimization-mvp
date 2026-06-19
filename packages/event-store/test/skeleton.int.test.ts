import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { append, getHubs, readStream, ConcurrencyError } from "../src/index.js";
import { buildApp, type HubDto } from "@mm/api";
import { MEMPHIS, hubRegisteredEvent } from "@mm/simulation";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * The walking-skeleton spine, end to end against a REAL Postgres container
 * (OrbStack via Testcontainers):
 *
 *   HubRegistered -> append (OCC + inline projection in one tx)
 *                 -> hubs projection upserted
 *                 -> GET /hubs (Fastify inject) returns the Memphis hub.
 *
 * Plus the optimistic-concurrency guard (FND-02 / PITFALLS P4).
 */
describe("skeleton spine: append -> inline projection -> GET /hubs", () => {
  let fx: PgFixture;
  const occurredAt = new Date("2026-01-01T00:00:00.000Z");

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("appends HubRegistered and projects it into hubs (read-your-writes)", async () => {
    await append(
      fx.db,
      `hub-${MEMPHIS.hubId}`,
      0,
      [hubRegisteredEvent(MEMPHIS)],
      occurredAt,
    );

    // Event persisted in the log...
    const stream = await readStream(fx.db, `hub-${MEMPHIS.hubId}`);
    expect(stream).toHaveLength(1);
    expect(stream[0]?.event_type).toBe("HubRegistered");
    expect(stream[0]?.version).toBe(1);

    // ...and the inline projection upserted the hub in the SAME transaction.
    const hubs = await getHubs(fx.db);
    const mem = hubs.find((h) => h.hub_id === MEMPHIS.hubId);
    expect(mem).toBeDefined();
    expect(mem?.lat).toBeCloseTo(MEMPHIS.lat);
    expect(mem?.lon).toBeCloseTo(MEMPHIS.lon);
  });

  it("serves the projected hub via GET /hubs (Fastify inject)", async () => {
    const app = buildApp(fx.db);
    const res = await app.inject({ method: "GET", url: "/hubs" });
    expect(res.statusCode).toBe(200);
    const body = res.json<HubDto[]>();
    const mem = body.find((h) => h.hubId === MEMPHIS.hubId);
    expect(mem).toEqual(MEMPHIS);
    await app.close();
  });

  it("enforces optimistic concurrency (FND-02 / P4)", async () => {
    const streamId = "hub-OCC-TEST";
    const hub = { ...MEMPHIS, hubId: "OCC", name: "Occ Hub" };
    await append(fx.db, streamId, 0, [hubRegisteredEvent(hub)], occurredAt);

    // Second append with a stale expectedVersion (0) must fail cleanly.
    await expect(
      append(fx.db, streamId, 0, [hubRegisteredEvent(hub)], occurredAt),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    // Stream has exactly one event — no gaps, no duplicates.
    const stream = await readStream(fx.db, streamId);
    expect(stream).toHaveLength(1);
    expect(stream[0]?.version).toBe(1);
  });

  it("is idempotent on the projection: re-appending the same logical state does not duplicate (P5a)", async () => {
    const before = await getHubs(fx.db);
    const memCountBefore = before.filter((h) => h.hub_id === MEMPHIS.hubId).length;
    expect(memCountBefore).toBe(1);
  });
});
