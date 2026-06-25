/**
 * Tests for GET /hubs/:id/detail (v1.2 HUBQ-01..07). Phase 14 — TDD RED → GREEN.
 *
 * The route is read-only (inject-based). It returns the trailers currently at a
 * hub with each trailer's status, dock door, assigned packages, bound-driver duty
 * summary, reconstructed rear→nose load-plan summary + slice-aware utilization,
 * derived next hub, arrival sim-ms (from audit_timeline), and an EXPLICITLY
 * estimated time-to-depart for parked trailers.
 *
 * Test strategy (mirrors plan-detail.test.ts):
 *  - All tests use Fastify's app.inject() — no real Postgres needed.
 *  - A fake DB stub returns the minimal rows each handler reads.
 *  - Tests verify the wire shape, the driver join, the HUBQ-05 arrival source
 *    (audit_timeline, NOT last_event_at), and the HUBQ-07 estimate labelling.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHubDetailRoutes } from "./hub-detail.js";
import type { HubDetailDto } from "./hub-detail.js";
import type { ApiDb } from "./queries.js";

// ---------------------------------------------------------------------------
// Minimal fake DB (selectFrom chain interceptor) — extends the plan-detail fake
// with current_hub_id filtering, the `in` operator, `limit`, driver_status, and
// the HubRegistered geo events readHubsFromLog reads.
// ---------------------------------------------------------------------------

interface FakeTrailerRow {
  trailer_id: string;
  status: string;
  current_hub_id: string | null;
  trip_id: string | null;
  dock_door_id: string | null;
  assigned_package_ids: string[];
  driver_id: string | null;
  last_event_at: string;
}

interface FakeHubInventoryRow {
  hub_id: string;
  inbound: string[];
  outbound: string[];
  staged: string[];
}

interface FakeEventRow {
  event_type: string;
  data: unknown;
  global_seq: string;
}

interface FakeDriverStatusRow {
  driver_id: string;
  status: string;
  remaining_drive_minutes: number;
}

interface FakeAuditRow {
  global_seq: bigint;
  trailer_id: string | null;
  hub_id: string | null;
  event_type: string;
  occurred_at: string;
}

interface FakeData {
  trailerRows: FakeTrailerRow[];
  hubInventoryRows: FakeHubInventoryRow[];
  eventRows: FakeEventRow[];
  driverRows: FakeDriverStatusRow[];
  auditRows: FakeAuditRow[];
}

function buildFakeDb(opts: FakeData): ApiDb {
  function makeChain(tableName: string) {
    const wheres: Array<{ field: string; op: string; val: unknown }> = [];
    let orderByField: string | null = null;
    let orderByDir: "asc" | "desc" = "asc";
    let limitN: number | null = null;

    const matches = (row: Record<string, unknown>): boolean =>
      wheres.every((w) => {
        const cell = row[w.field];
        return w.op === "in" ? (w.val as unknown[]).includes(cell) : cell === w.val;
      });

    const chain = {
      selectAll: () => chain,
      select: () => chain,
      where: (field: string, op: string, val: unknown) => {
        wheres.push({ field, op, val });
        return chain;
      },
      orderBy: (field: string, dir: "asc" | "desc" = "asc") => {
        orderByField = field;
        orderByDir = dir;
        return chain;
      },
      limit: (n: number) => {
        limitN = n;
        return chain;
      },
      executeTakeFirst: () => {
        const rows = run();
        return Promise.resolve(rows[0]);
      },
      execute: () => Promise.resolve(run()),
    };

    function run(): Array<Record<string, unknown>> {
      let rows: Array<Record<string, unknown>> = [];
      if (tableName === "trailer_state") rows = opts.trailerRows as unknown as typeof rows;
      else if (tableName === "hub_inventory")
        rows = opts.hubInventoryRows as unknown as typeof rows;
      else if (tableName === "events") rows = opts.eventRows as unknown as typeof rows;
      else if (tableName === "driver_status")
        rows = opts.driverRows as unknown as typeof rows;
      else if (tableName === "audit_timeline")
        rows = opts.auditRows as unknown as typeof rows;

      rows = rows.filter(matches);

      if (orderByField !== null) {
        const f = orderByField;
        rows = [...rows].sort((a, b) => {
          const av = a[f] as bigint | number | string;
          const bv = b[f] as bigint | number | string;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return orderByDir === "asc" ? cmp : -cmp;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    return chain;
  }

  return { selectFrom: (table: string) => makeChain(table) } as unknown as ApiDb;
}

// ---------------------------------------------------------------------------
// Fixtures — a star network MEM(center) ↔ DFW, ATL spokes.
// ---------------------------------------------------------------------------

const HUB_EVENTS: FakeEventRow[] = [
  { event_type: "HubRegistered", global_seq: "1", data: { hubId: "MEM", name: "Memphis", lat: 35.04, lon: -89.97 } },
  { event_type: "HubRegistered", global_seq: "2", data: { hubId: "DFW", name: "Dallas", lat: 32.9, lon: -96.85 } },
  { event_type: "HubRegistered", global_seq: "3", data: { hubId: "ATL", name: "Atlanta", lat: 33.64, lon: -84.43 } },
];

const ROUTE_EVENTS: FakeEventRow[] = [
  { event_type: "RouteRegistered", global_seq: "4", data: { routeId: "R-MEM-DFW", fromHubId: "MEM", toHubId: "DFW", geometry: [[-89.97, 35.04], [-96.85, 32.9]] } },
  { event_type: "RouteRegistered", global_seq: "5", data: { routeId: "R-MEM-ATL", fromHubId: "MEM", toHubId: "ATL", geometry: [[-89.97, 35.04], [-84.43, 33.64]] } },
];

/** A docked trailer at MEM with a plan + a bound driver. */
const T1: FakeTrailerRow = {
  trailer_id: "T1",
  status: "docked",
  current_hub_id: "MEM",
  trip_id: null,
  dock_door_id: "DOCK7",
  assigned_package_ids: ["PKG-001", "PKG-002"],
  driver_id: "D1",
  last_event_at: "2026-02-01T10:00:00.000Z", // LATER than the arrival → must NOT be used
};

const HUB_MEM_INV: FakeHubInventoryRow = {
  hub_id: "MEM",
  inbound: [],
  outbound: ["PKG-001", "PKG-002"],
  staged: [],
};

const DRIVER_D1: FakeDriverStatusRow = {
  driver_id: "D1",
  status: "on_break",
  remaining_drive_minutes: 240,
};

/** Two TrailerArrivedAtHub rows; the LATEST (higher global_seq) must win (HUBQ-05). */
const ARRIVED_T1_MEM = Date.parse("2026-02-01T08:00:00.000Z");
const AUDIT_ROWS: FakeAuditRow[] = [
  { global_seq: 10n, trailer_id: "T1", hub_id: "MEM", event_type: "TrailerArrivedAtHub", occurred_at: "2026-01-01T00:00:00.000Z" },
  { global_seq: 50n, trailer_id: "T1", hub_id: "MEM", event_type: "TrailerArrivedAtHub", occurred_at: "2026-02-01T08:00:00.000Z" },
  // A later TrailerDocked event — must be ignored by the arrival query.
  { global_seq: 60n, trailer_id: "T1", hub_id: "MEM", event_type: "TrailerDocked", occurred_at: "2026-02-01T08:30:00.000Z" },
];

function baseData(overrides: Partial<FakeData> = {}): FakeData {
  return {
    trailerRows: [T1],
    hubInventoryRows: [HUB_MEM_INV],
    eventRows: [...HUB_EVENTS, ...ROUTE_EVENTS],
    driverRows: [DRIVER_D1],
    auditRows: [...AUDIT_ROWS],
    ...overrides,
  };
}

async function buildApp(data: FakeData): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerHubDetailRoutes(app, buildFakeDb(data));
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /hubs/:id/detail (HUBQ-01..07)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("HUBQ-01: returns trailers at the hub with status, dockDoorId, packages", async () => {
    app = await buildApp(baseData());
    const res = await app.inject({ method: "GET", url: "/hubs/MEM/detail" });
    expect(res.statusCode).toBe(200);
    const body = res.json<HubDetailDto>();
    expect(body.hubId).toBe("MEM");
    expect(body.trailers).toHaveLength(1);
    const t = body.trailers[0]!;
    expect(t.trailerId).toBe("T1");
    expect(t.status).toBe("docked");
    expect(t.dockDoorId).toBe("DOCK7");
    expect(t.assignedPackageIds).toEqual(["PKG-001", "PKG-002"]);
  });

  it("HUBQ-01: includes the bound driver's duty status + remaining drive minutes", async () => {
    app = await buildApp(baseData());
    const res = await app.inject({ method: "GET", url: "/hubs/MEM/detail" });
    const t = res.json<HubDetailDto>().trailers[0]!;
    expect(t.driver).not.toBeNull();
    expect(t.driver?.driverId).toBe("D1");
    expect(t.driver?.dutyStatus).toBe("on_break");
    expect(t.driver?.remainingDriveMinutes).toBe(240);
  });

  it("HUBQ-01: driver is null when the trailer has no bound driver", async () => {
    app = await buildApp(
      baseData({ trailerRows: [{ ...T1, driver_id: null }] }),
    );
    const res = await app.inject({ method: "GET", url: "/hubs/MEM/detail" });
    expect(res.json<HubDetailDto>().trailers[0]!.driver).toBeNull();
  });

  it("HUBQ-03/04: includes a rear→nose summary + slice-aware utilization in [0,1]", async () => {
    app = await buildApp(baseData());
    const t = (await app.inject({ method: "GET", url: "/hubs/MEM/detail" })).json<HubDetailDto>()
      .trailers[0]!;
    expect(Array.isArray(t.rearToNose)).toBe(true);
    expect(t.rearToNose.length).toBeGreaterThan(0);
    // depth ascending (rear first)
    const depths = t.rearToNose.map((s) => s.depth);
    for (let i = 1; i < depths.length; i++) expect(depths[i]!).toBeGreaterThanOrEqual(depths[i - 1]!);
    expect(typeof t.utilization).toBe("number");
    expect(t.utilization!).toBeGreaterThan(0);
    expect(t.utilization!).toBeLessThanOrEqual(1);
  });

  it("HUBQ-06: nextHubId is the first derived stop (the packages' next-unload hub)", async () => {
    app = await buildApp(baseData());
    const t = (await app.inject({ method: "GET", url: "/hubs/MEM/detail" })).json<HubDetailDto>()
      .trailers[0]!;
    // PKG-001/002 are indexed as outbound AT MEM, so each block's nextUnloadHubId
    // is MEM and the first (only) route stop is MEM — the same reconstruction
    // semantics the /trailers/:id/plan route uses.
    expect(t.nextHubId).toBe("MEM");
  });

  it("HUBQ-06: nextHubId falls back to a route dest when packages are NOT in any outbound index", async () => {
    // No hub_inventory rows → buildBlocks falls back to routeDestHubs[0]: the FIRST
    // RouteRegistered leg out of MEM (log order) is MEM→DFW, so every block's
    // nextUnloadHubId is DFW and the only route stop is DFW.
    app = await buildApp(baseData({ hubInventoryRows: [] }));
    const t = (await app.inject({ method: "GET", url: "/hubs/MEM/detail" })).json<HubDetailDto>()
      .trailers[0]!;
    expect(t.nextHubId).toBe("DFW");
  });

  it("HUBQ-05: arrivedAtMs comes from the latest TrailerArrivedAtHub, NOT last_event_at", async () => {
    app = await buildApp(baseData());
    const t = (await app.inject({ method: "GET", url: "/hubs/MEM/detail" })).json<HubDetailDto>()
      .trailers[0]!;
    // The latest TrailerArrivedAtHub (global_seq 50) is 2026-02-01T08:00; the
    // later TrailerDocked (08:30) and last_event_at (10:00) must NOT be used.
    expect(t.arrivedAtMs).toBe(ARRIVED_T1_MEM);
    expect(t.arrivedAtMs).not.toBe(Date.parse(T1.last_event_at));
  });

  it("HUBQ-07: a parked trailer carries an ESTIMATE > arrivedAtMs, flagged etaIsEstimate", async () => {
    app = await buildApp(baseData());
    const t = (await app.inject({ method: "GET", url: "/hubs/MEM/detail" })).json<HubDetailDto>()
      .trailers[0]!;
    expect(t.etaIsEstimate).toBe(true);
    expect(t.estimatedEtaMs).not.toBeNull();
    // estimate = arrival + expected dwell + expected transit → strictly later.
    expect(t.estimatedEtaMs!).toBeGreaterThan(t.arrivedAtMs!);
  });

  it("HUBQ-07: an in-transit trailer gets NO server estimate (etaIsEstimate=false)", async () => {
    app = await buildApp(
      baseData({
        trailerRows: [{ ...T1, status: "in_transit", dock_door_id: null }],
      }),
    );
    const t = (await app.inject({ method: "GET", url: "/hubs/MEM/detail" })).json<HubDetailDto>()
      .trailers[0]!;
    expect(t.estimatedEtaMs).toBeNull();
    expect(t.etaIsEstimate).toBe(false);
  });

  it("returns an empty trailers list for an unseen hub (not a 404)", async () => {
    app = await buildApp(baseData());
    const res = await app.inject({ method: "GET", url: "/hubs/NOWHERE/detail" });
    expect(res.statusCode).toBe(200);
    const body = res.json<HubDetailDto>();
    expect(body.hubId).toBe("NOWHERE");
    expect(body.trailers).toEqual([]);
  });

  // FLOW-05 (P2): per-hub inbound/outbound inventory balance (cross-dock heat)
  // from the hub_inventory projection — the same projection the optimizer
  // consumes (Decision 3). Surfaces the consolidation value numerically.
  it("FLOW-05: surfaces the hub's inbound/outbound inventory balance from hub_inventory", async () => {
    app = await buildApp(
      baseData({
        hubInventoryRows: [
          { hub_id: "MEM", inbound: ["A", "B", "C"], outbound: ["X", "Y"], staged: ["S"] },
        ],
      }),
    );
    const body = (
      await app.inject({ method: "GET", url: "/hubs/MEM/detail" })
    ).json<HubDetailDto>();
    expect(body.inventoryBalance).toEqual({ inbound: 3, outbound: 2 });
  });

  it("FLOW-05: an unseen hub returns a zero balance without throwing", async () => {
    app = await buildApp(baseData());
    const res = await app.inject({ method: "GET", url: "/hubs/NOWHERE/detail" });
    expect(res.statusCode).toBe(200);
    const body = res.json<HubDetailDto>();
    expect(body.inventoryBalance).toEqual({ inbound: 0, outbound: 0 });
  });

  it("FLOW-05: a hub with no hub_inventory row reports a zero balance", async () => {
    app = await buildApp(baseData({ hubInventoryRows: [] }));
    const body = (
      await app.inject({ method: "GET", url: "/hubs/MEM/detail" })
    ).json<HubDetailDto>();
    expect(body.inventoryBalance).toEqual({ inbound: 0, outbound: 0 });
  });

  it("sorts trailers by id for a stable panel (P3)", async () => {
    app = await buildApp(
      baseData({
        trailerRows: [
          { ...T1, trailer_id: "T-Z" },
          { ...T1, trailer_id: "T-A" },
        ],
      }),
    );
    const body = (await app.inject({ method: "GET", url: "/hubs/MEM/detail" })).json<HubDetailDto>();
    expect(body.trailers.map((t) => t.trailerId)).toEqual(["T-A", "T-Z"]);
  });

  it("validates :id as non-empty (T-05-07 parity)", async () => {
    app = await buildApp(baseData());
    const res = await app.inject({ method: "GET", url: "/hubs//detail" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
