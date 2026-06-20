import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "@mm/simulation";
import {
  buildServer,
  driveSimulation,
  type AuditEntryDto,
  type ApiDb,
  type HubInventoryDto,
  type PackageLocationDto,
  type RouteDto,
  type TrailerDto,
} from "../src/index.js";
import type { BuiltServer } from "../src/server.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * Plan 06 Task 2 — the FND query endpoints against a REAL Postgres + a seeded
 * deterministic sim. We drive the sim ONCE to populate the operational + audit +
 * geo projections, then exercise each endpoint via Fastify `inject`.
 *
 *  - FND-05 GET /packages/:id/location -> last hub + confidence + timestamp; 404.
 *  - FND-06 GET /trailers/:id          -> assignment/observed contents; 404.
 *  - FND-07 GET /hubs/:id/inventory    -> inbound/outbound/staged.
 *  - FND-08 GET /packages/:id/history  -> ordered timeline == audit projection.
 *  - GET /hubs and GET /routes         -> geo data for the map.
 */

const SEED = 4242;
// Enough ticks for a full trailer round-trip (depart@1 -> transit 30 -> arrive
// @31 -> dock + dwell) so every projection is exercised, kept small so the
// per-event inline fold stays fast.
const DURATION = 45;

/** First package + trailer ids the seeded stream produces (deterministic). */
function seededIds(): { pkg: string; trailer: string } {
  const stream = simulate({ seed: SEED, durationTicks: DURATION });
  const created = stream.find((e) => e.event.type === "PackageCreated")!;
  const departed = stream.find((e) => e.event.type === "TrailerDeparted")!;
  return {
    pkg: (created.event.payload as { packageId: string }).packageId,
    trailer: (departed.event.payload as { trailerId: string }).trailerId,
  };
}

describe("FND query endpoints (FND-05/06/07/08) over a seeded sim", () => {
  let fx: PgFixture;
  let built: BuiltServer;

  beforeAll(async () => {
    fx = await startPgFixture();
    const db: ApiDb = fx.db;
    // No ws needed for the REST tests — keeps the inject-only app light.
    built = await buildServer({ db, enableWs: false });
    await driveSimulation({ db, seed: SEED, durationTicks: DURATION, broadcast: undefined });
  }, 180_000);

  afterAll(async () => {
    await built?.app.close();
    await fx?.stop();
  });

  it("FND-05: GET /packages/:id/location returns hub + confidence + timestamp", async () => {
    const { pkg } = seededIds();
    const res = await built.app.inject({ method: "GET", url: `/packages/${pkg}/location` });
    expect(res.statusCode).toBe(200);
    const body = res.json<PackageLocationDto>();
    expect(body.packageId).toBe(pkg);
    expect(body.hubId.length).toBeGreaterThan(0);
    expect(body.confidence).toBe(1);
    expect(typeof body.lastSeenAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.lastSeenAt))).toBe(false);
  });

  it("FND-05: unknown package id returns 404", async () => {
    const res = await built.app.inject({ method: "GET", url: "/packages/NOPE-XYZ/location" });
    expect(res.statusCode).toBe(404);
  });

  it("FND-06: GET /trailers/:id returns current assignment/contents", async () => {
    const { trailer } = seededIds();
    const res = await built.app.inject({ method: "GET", url: `/trailers/${trailer}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<TrailerDto>();
    expect(body.trailerId).toBe(trailer);
    expect(["in_transit", "arrived", "docked"]).toContain(body.status);
    expect(Array.isArray(body.assignedPackageIds)).toBe(true);
  });

  it("FND-06: unknown trailer id returns 404", async () => {
    const res = await built.app.inject({ method: "GET", url: "/trailers/NOPE-T/" });
    // Trailing slash routes to /trailers/:id with id "NOPE-T".
    expect([404, 200]).toContain(res.statusCode);
    if (res.statusCode === 200) throw new Error("unknown trailer should not exist");
  });

  it("FND-07: GET /hubs/:id/inventory returns inbound/outbound/staged", async () => {
    // The center hub (MEM) accumulates inbound/outbound activity in the sim.
    const res = await built.app.inject({ method: "GET", url: "/hubs/MEM/inventory" });
    expect(res.statusCode).toBe(200);
    const body = res.json<HubInventoryDto>();
    expect(body.hubId).toBe("MEM");
    expect(Array.isArray(body.inbound)).toBe(true);
    expect(Array.isArray(body.outbound)).toBe(true);
    expect(Array.isArray(body.staged)).toBe(true);
    // Buckets are disjoint id sets (no package appears in two buckets at once).
    const all = [...body.inbound, ...body.outbound, ...body.staged];
    expect(new Set(all).size).toBe(all.length);
  });

  it("FND-08: GET /packages/:id/history is the ordered audit timeline", async () => {
    const { pkg } = seededIds();
    const res = await built.app.inject({ method: "GET", url: `/packages/${pkg}/history` });
    expect(res.statusCode).toBe(200);
    const body = res.json<AuditEntryDto[]>();
    expect(body.length).toBeGreaterThan(0);
    // The first event in any package's history is its creation.
    expect(body[0]!.eventType).toBe("PackageCreated");
    // Strictly increasing global_seq order (no gaps/reorder).
    for (let i = 1; i < body.length; i += 1) {
      expect(BigInt(body[i]!.globalSeq) > BigInt(body[i - 1]!.globalSeq)).toBe(true);
    }
    // Every entry carries eventType + occurredAt.
    expect(body.every((e) => e.eventType.length > 0 && e.occurredAt.length > 0)).toBe(true);
  });

  it("GET /hubs returns the geo hub list (supersedes the Plan 01 skeleton route)", async () => {
    const res = await built.app.inject({ method: "GET", url: "/hubs" });
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ hubId: string; name: string; lat: number; lon: number }>>();
    expect(body.length).toBeGreaterThanOrEqual(10); // the full USA hub network
    const mem = body.find((h) => h.hubId === "MEM");
    expect(mem).toBeDefined();
    expect(mem!.name).toBe("Memphis");
  });

  it("GET /routes returns route geometries for the map", async () => {
    const res = await built.app.inject({ method: "GET", url: "/routes" });
    expect(res.statusCode).toBe(200);
    const body = res.json<RouteDto[]>();
    expect(body.length).toBeGreaterThan(0);
    const r = body[0]!;
    expect(r.routeId.length).toBeGreaterThan(0);
    expect(Array.isArray(r.geometry)).toBe(true);
    expect(r.geometry.length).toBeGreaterThan(1);
    // Each vertex is a [lon, lat] pair.
    expect(r.geometry[0]!.length).toBe(2);
  });
});
