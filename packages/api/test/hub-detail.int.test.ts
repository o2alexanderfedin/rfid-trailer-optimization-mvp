import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  DEFAULT_HOS_CONFIG,
  type DomainEvent,
  type HosClock,
  isoToEpochMinutes,
  remainingLegalDriveMinutes,
} from "@mm/domain";
import { appendToStream, readAll } from "@mm/event-store";
import {
  applyInline,
  projectionView,
  runCatchup,
  type CatchupDb,
} from "@mm/projections";
import type { Kysely } from "kysely";
import {
  buildServer,
  type ApiDb,
  type HubDetailDto,
} from "../src/index.js";
import type { BuiltServer } from "../src/server.js";
import { buildSnapshotPayload } from "../src/ws/snapshots.js";
import { eventStoreView, startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * Phase 14 (HUBQ-01..08) — `GET /hubs/:id/detail` + ws driver buckets over a REAL
 * Postgres. We build a fully-controlled, deterministic scenario via inline event
 * appends (read-your-writes, mirroring driver-status-golden-replay.int.test.ts):
 * a trailer departs MEM with two packages, ARRIVES + DOCKS at DFW, and a driver
 * is registered + assigned to its trip and put on a 30-min break. Then we exercise
 * the live endpoint via Fastify `inject` and assert each HUBQ datum end-to-end.
 *
 * This is a pure read-layer test: the only writes are the seed events. It also
 * confirms HUBQ-02 (the `current_hub_id` query is index-backed, no seq scan) and
 * HUBQ-08 (the ws snapshot carries per-hub driver buckets).
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const MIN = 60_000;

// --- Event builders (the seed scenario) -------------------------------------
function hubRegistered(hubId: string, name: string, lat: number, lon: number): DomainEvent {
  return { type: "HubRegistered", schemaVersion: 1, payload: { hubId, name, lat, lon } };
}
function routeRegistered(fromHubId: string, toHubId: string): DomainEvent {
  return {
    type: "RouteRegistered",
    schemaVersion: 1,
    payload: {
      routeId: `R-${fromHubId}-${toHubId}`,
      fromHubId,
      toHubId,
      geometry: [
        [-89.97, 35.04],
        [-96.85, 32.9],
      ],
    },
  };
}
function departed(trailerId: string, fromHubId: string, toHubId: string, tripId: string, packageIds: string[]): DomainEvent {
  return { type: "TrailerDeparted", schemaVersion: 1, payload: { trailerId, fromHubId, toHubId, tripId, packageIds } };
}
function arrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return { type: "TrailerArrivedAtHub", schemaVersion: 1, payload: { trailerId, hubId, tripId } };
}
function docked(trailerId: string, hubId: string, dockDoorId: string): DomainEvent {
  return { type: "TrailerDocked", schemaVersion: 1, payload: { trailerId, hubId, dockDoorId } };
}
function driverRegistered(driverId: string, homeHubId: string, occurredAt: string): DomainEvent {
  return { type: "DriverRegistered", schemaVersion: 1, payload: { driverId, homeHubId, occurredAt } };
}
function driverAssigned(driverId: string, tripId: string, trailerId: string, occurredAt: string): DomainEvent {
  return { type: "DriverAssignedToTrip", schemaVersion: 1, payload: { driverId, tripId, trailerId, occurredAt } };
}
function clockAt(startMs: number, overrides: Partial<HosClock> = {}): HosClock {
  const startIso = iso(startMs);
  return {
    driveTodayMin: 0,
    dutyWindowStartAt: startIso,
    sinceLastBreakMin: 0,
    weeklyOnDutyMin: 0,
    comeOnDutyAt: startIso,
    sleeperBerthLongMin: 0,
    sleeperBerthShortMin: 0,
    ...overrides,
  };
}
function dutyChanged(driverId: string, dutyStatus: "driving" | "on_break" | "resting" | "off_duty", clock: HosClock, reason: string, occurredAt: string): DomainEvent {
  return { type: "DriverDutyStateChanged", schemaVersion: 1, payload: { driverId, dutyStatus, reason, clock, occurredAt } };
}

const MEM = "HD-MEM";
const DFW = "HD-DFW";
const ATL = "HD-ATL";
const T1 = "HD-T1";
const TRIP = "HD-TRIP1";
const D1 = "HD-D1";
const P1 = "HD-PKG-1";
const P2 = "HD-PKG-2";

const ARRIVED_AT_MS = T0 + 100 * MIN; // TrailerArrivedAtHub occurred_at (HUBQ-05)

interface Seed {
  readonly stream: string;
  readonly events: readonly DomainEvent[];
  readonly offsetMs: number;
}

describe("GET /hubs/:id/detail + ws driver buckets (HUBQ-01..08) over real Postgres", () => {
  let fx: PgFixture;
  let built: BuiltServer;

  beforeAll(async () => {
    fx = await startPgFixture();
    const db: ApiDb = fx.db;

    // A driver who has driven 200 min today (so remaining < the 11h cap) and is on
    // a 30-min break. The break clock keeps drive minutes accrued.
    const onBreakClock = clockAt(0, {
      driveTodayMin: 200,
      sinceLastBreakMin: 0,
      weeklyOnDutyMin: 200,
    });

    const seeds: Seed[] = [
      {
        stream: "geo",
        offsetMs: 0,
        events: [
          hubRegistered(MEM, "Memphis", 35.04, -89.97),
          hubRegistered(DFW, "Dallas", 32.9, -96.85),
          hubRegistered(ATL, "Atlanta", 33.64, -84.43),
          routeRegistered(MEM, DFW),
          routeRegistered(MEM, ATL),
          routeRegistered(DFW, ATL), // gives DFW an onward leg → nextHub + ETA estimate
        ],
      },
      {
        stream: `driver-${D1}`,
        offsetMs: 1 * MIN,
        events: [driverRegistered(D1, MEM, iso(0))],
      },
      {
        stream: `trailer-${T1}`,
        offsetMs: 60 * MIN,
        events: [
          departed(T1, MEM, DFW, TRIP, [P1, P2]),
          driverAssigned(D1, TRIP, T1, iso(60 * MIN)),
          dutyChanged(D1, "driving", clockAt(60 * MIN, { driveTodayMin: 0 }), "trip-dispatched", iso(60 * MIN)),
        ],
      },
      {
        stream: `trailer-${T1}-arr`,
        offsetMs: 100 * MIN, // → TrailerArrivedAtHub occurred_at == ARRIVED_AT_MS
        events: [
          arrived(T1, DFW, TRIP),
          docked(T1, DFW, "DOCK-3"),
          dutyChanged(D1, "on_break", onBreakClock, "30-min-break", iso(130 * MIN)),
        ],
      },
    ];

    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);
    let cursor = 0n;
    for (const seed of seeds) {
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

    // Advance the CATCH-UP projections (audit_timeline) so HUBQ-05 `arrivedAtMs`
    // — read from `TrailerArrivedAtHub` rows — is populated. applyInline only folds
    // the operational projections; the audit timeline is a catch-up projection.
    const catchup = fx.db as unknown as Kysely<CatchupDb>;
    await runCatchup(catchup, (db, fromSeq) =>
      readAll(eventStoreView(db as unknown as typeof fx.db), fromSeq),
    );

    built = await buildServer({ db, enableWs: false });
  }, 180_000);

  afterAll(async () => {
    await built?.app.close();
    await fx?.stop();
  });

  it("HUBQ-01: returns the trailer at DFW with status, dockDoorId, packages + driver", async () => {
    const res = await built.app.inject({ method: "GET", url: `/hubs/${DFW}/detail` });
    expect(res.statusCode).toBe(200);
    const body = res.json<HubDetailDto>();
    expect(body.hubId).toBe(DFW);
    expect(body.trailers).toHaveLength(1);
    const t = body.trailers[0]!;
    expect(t.trailerId).toBe(T1);
    expect(t.status).toBe("docked");
    expect(t.dockDoorId).toBe("DOCK-3");
    expect([...t.assignedPackageIds].sort()).toEqual([P1, P2].sort());

    // HUBQ-01: bound-driver duty status + remaining legal drive minutes (join).
    expect(t.driver).not.toBeNull();
    expect(t.driver?.driverId).toBe(D1);
    expect(t.driver?.dutyStatus).toBe("on_break");
    const expectedRemaining = remainingLegalDriveMinutes(
      // re-derive from the same on-break clock snapshot the seed carried
      clockAt(0, { driveTodayMin: 200, sinceLastBreakMin: 0, weeklyOnDutyMin: 200 }),
      DEFAULT_HOS_CONFIG,
      isoToEpochMinutes(iso(130 * MIN)),
    );
    expect(t.driver?.remainingDriveMinutes).toBe(expectedRemaining);
  });

  it("HUBQ-03/04: per-trailer rear→nose summary + slice-aware utilization in (0,1]", async () => {
    const t = (await built.app.inject({ method: "GET", url: `/hubs/${DFW}/detail` })).json<HubDetailDto>()
      .trailers[0]!;
    expect(Array.isArray(t.rearToNose)).toBe(true);
    expect(t.rearToNose.length).toBeGreaterThan(0);
    expect(typeof t.utilization).toBe("number");
    expect(t.utilization!).toBeGreaterThan(0);
    expect(t.utilization!).toBeLessThanOrEqual(1);
  });

  it("HUBQ-05: arrivedAtMs is the TrailerArrivedAtHub time, NOT last_event_at", async () => {
    const t = (await built.app.inject({ method: "GET", url: `/hubs/${DFW}/detail` })).json<HubDetailDto>()
      .trailers[0]!;
    expect(t.arrivedAtMs).toBe(ARRIVED_AT_MS);
  });

  it("HUBQ-06: nextHubId derives from the trailer's onward route (ATL from DFW)", async () => {
    const t = (await built.app.inject({ method: "GET", url: `/hubs/${DFW}/detail` })).json<HubDetailDto>()
      .trailers[0]!;
    expect(t.nextHubId).toBe(ATL); // only onward leg from DFW is DFW→ATL
  });

  it("HUBQ-07: a parked trailer carries an ESTIMATE later than arrival, flagged", async () => {
    const t = (await built.app.inject({ method: "GET", url: `/hubs/${DFW}/detail` })).json<HubDetailDto>()
      .trailers[0]!;
    expect(t.etaIsEstimate).toBe(true);
    expect(t.estimatedEtaMs).not.toBeNull();
    expect(t.estimatedEtaMs!).toBeGreaterThan(t.arrivedAtMs!);
  });

  it("returns an empty list for a hub with no trailers (not a 404)", async () => {
    const res = await built.app.inject({ method: "GET", url: `/hubs/${ATL}/detail` });
    expect(res.statusCode).toBe(200);
    const body = res.json<HubDetailDto>();
    expect(body.hubId).toBe(ATL);
    expect(body.trailers).toEqual([]);
    // FLOW-05: a zero balance for a hub with no inventory (a valid empty answer).
    expect(body.inventoryBalance).toEqual({ inbound: 0, outbound: 0 });
  });

  it("HUBQ-02: idx_trailer_state_current_hub exists and backs the current_hub_id filter", async () => {
    // The reverse index must exist on the projection table (Phase-13 landed it).
    const idx = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'trailer_state'
        AND indexname = 'idx_trailer_state_current_hub'
    `.execute(fx.db);
    expect(idx.rows).toHaveLength(1);

    // And the planner can USE it for the endpoint's exact filter. We force index
    // usage off seq-scan to prove the access path is available (a small demo table
    // can otherwise prefer a seq scan purely on row count). The point is that an
    // index path EXISTS — no full-table scan is forced on a busy hub.
    await sql`SET enable_seqscan = off`.execute(fx.db);
    try {
      const explain = await sql<{ "QUERY PLAN": string }>`
        EXPLAIN SELECT * FROM trailer_state WHERE current_hub_id = ${DFW}
      `.execute(fx.db);
      const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n").toLowerCase();
      expect(plan).toContain("idx_trailer_state_current_hub");
    } finally {
      await sql`SET enable_seqscan = on`.execute(fx.db);
    }
  });

  it("HUBQ-08: the ws snapshot carries per-hub driver buckets (DFW: 1 driver on_break)", async () => {
    const payload = await buildSnapshotPayload(fx.db);
    const dfw = payload.hubs.find((h) => h.id === DFW);
    expect(dfw).toBeDefined();
    expect(dfw?.driverCount).toBe(1);
    expect(dfw?.onBreakCount).toBe(1);
    expect(dfw?.restingCount).toBe(0);
    // A hub with no trailers/drivers reports zeroed buckets.
    const atl = payload.hubs.find((h) => h.id === ATL);
    expect(atl?.driverCount).toBe(0);
  });
});
