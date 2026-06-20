/**
 * Tests for GET /trailers/:id/plan (VIZ-05) and GET /trailers/:id/history (UI-02).
 * Plan 05-04, Task 2 — TDD RED → GREEN.
 *
 * Both routes are read-only (inject-based). The plan-detail route returns the
 * trailer's rear→nose load order, loading instructions, and plan explanation
 * derived from the current twin state. The history route returns the trailer
 * audit timeline including captured recommendations.
 *
 * Test strategy:
 *  - All tests use Fastify's app.inject() — no real Postgres needed.
 *  - A fake DB stub returns the minimal rows each handler reads.
 *  - Tests verify the wire shape, 404 behavior, and input validation.
 *
 * Threat coverage:
 *  - T-05-07: :id param validated non-empty by Fastify schema
 *  - T-05-08: read-only endpoints, no DB writes
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPlanDetailRoutes } from "./plan-detail.js";
import type { ApiDb } from "./queries.js";

// ---------------------------------------------------------------------------
// Minimal fake DB
// ---------------------------------------------------------------------------

/**
 * Build a fake DB that simulates the minimal rows the plan-detail handler reads.
 * We intercept the Kysely fluent chain by returning a proxy that eventually
 * calls the stub functions.
 */

/** A single fake trailer state row (from trailer_state). */
interface FakeTrailerRow {
  trailer_id: string;
  status: string;
  current_hub_id: string | null;
  trip_id: string | null;
  dock_door_id: string | null;
  assigned_package_ids: string[];
  last_event_at: string;
}

/** A single fake hub_inventory row. */
interface FakeHubInventoryRow {
  hub_id: string;
  inbound: string[];
  outbound: string[];
  staged: string[];
}

/** A single fake events row (RouteRegistered / PlanAccepted). */
interface FakeEventRow {
  event_type: string;
  data: unknown;
  global_seq: string;
}

/** Fake audit timeline row (from audit_timeline). */
interface FakeAuditRow {
  global_seq: bigint;
  package_id: string | null;
  trailer_id: string | null;
  event_type: string;
  occurred_at: string;
  hub_id: string | null;
  scan_type: string | null;
  recommendation: string | null;
}

/**
 * Build a minimal Kysely-like fake that supports the selectFrom chain used
 * by the plan-detail handler. Uses a simple interceptor pattern.
 */
function buildFakeDb(opts: {
  trailerRows: FakeTrailerRow[];
  hubInventoryRows: FakeHubInventoryRow[];
  eventRows: FakeEventRow[];
  auditRows: FakeAuditRow[];
}): ApiDb {
  const { trailerRows, hubInventoryRows, eventRows, auditRows } = opts;

  function makeChain(tableName: string) {
    let whereField: string | null = null;
    let whereValue: unknown = null;
    let orderByField: string | null = null;
    let orderByDir: "asc" | "desc" = "asc";

    const chain = {
      selectAll: () => chain,
      select: () => chain,
      where: (field: string, _op: string, val: unknown) => {
        whereField = field;
        whereValue = val;
        return chain;
      },
      orderBy: (field: string, dir: "asc" | "desc" = "asc") => {
        orderByField = field;
        orderByDir = dir;
        return chain;
      },
      executeTakeFirst: () => {
        if (tableName === "trailer_state") {
          return Promise.resolve(trailerRows.find((r) => r.trailer_id === whereValue));
        }
        return Promise.resolve(undefined);
      },
      execute: () => {
        if (tableName === "hub_inventory") return Promise.resolve(hubInventoryRows);
        if (tableName === "events") {
          let rows = eventRows;
          if (whereField === "event_type") {
            rows = rows.filter((r) => r.event_type === whereValue);
          }
          if (orderByField === "global_seq") {
            rows = [...rows].sort((a, b) => {
              const diff = BigInt(a.global_seq) < BigInt(b.global_seq) ? -1 : 1;
              return orderByDir === "asc" ? diff : -diff;
            });
          }
          return Promise.resolve(rows);
        }
        if (tableName === "audit_timeline") {
          let rows = auditRows;
          if (whereField === "trailer_id") {
            rows = rows.filter((r) => r.trailer_id === whereValue);
          } else if (whereField === "package_id") {
            rows = rows.filter((r) => r.package_id === whereValue);
          }
          if (orderByField === "global_seq") {
            rows = [...rows].sort((a, b) =>
              a.global_seq < b.global_seq ? -1 : 1,
            );
          }
          return Promise.resolve(rows);
        }
        return Promise.resolve([]);
      },
    };
    return chain;
  }

  return {
    selectFrom: (table: string) => makeChain(table),
  } as unknown as ApiDb;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A trailer with packages assigned and a known hub. */
const TRAILER_WITH_PLAN: FakeTrailerRow = {
  trailer_id: "T1",
  status: "docked",
  current_hub_id: "MEM",
  trip_id: null,
  dock_door_id: "DOCK7",
  assigned_package_ids: ["PKG-001", "PKG-002"],
  last_event_at: "2026-02-01T00:00:00.000Z",
};

/** Hub inventory — both packages are outbound from MEM to DFW. */
const HUB_MEM: FakeHubInventoryRow = {
  hub_id: "MEM",
  inbound: [],
  outbound: ["PKG-001", "PKG-002"],
  staged: [],
};

/** A RouteRegistered event for MEM → DFW. */
const ROUTE_EVENT: FakeEventRow = {
  event_type: "RouteRegistered",
  data: {
    routeId: "ROUTE-MEM-DFW",
    fromHubId: "MEM",
    toHubId: "DFW",
    geometry: [[-89.97, 35.04], [-96.85, 32.90]],
  },
  global_seq: "1",
};

/** A PlanAccepted event for T1 in the optimizer stream. */
const PLAN_ACCEPTED_EVENT: FakeEventRow = {
  event_type: "PlanAccepted",
  data: {
    planId: "PLAN1",
    trailerId: "T1",
    epochId: "E1",
    scopeHash: "HASH1",
    occurredAt: "2026-02-01T00:01:00.000Z",
  },
  global_seq: "5",
};

/** Audit rows for T1 trailer history. */
const AUDIT_ROWS: FakeAuditRow[] = [
  {
    global_seq: 10n,
    package_id: null,
    trailer_id: "T1",
    event_type: "TrailerDocked",
    occurred_at: "2026-02-01T00:00:00.000Z",
    hub_id: "MEM",
    scan_type: null,
    recommendation: null,
  },
  {
    global_seq: 20n,
    package_id: null,
    trailer_id: "T1",
    event_type: "PlanGenerated",
    occurred_at: "2026-02-01T00:01:00.000Z",
    hub_id: null,
    scan_type: null,
    recommendation: "Plan PLAN1 generated for trailer T1: FEASIBLE, objective cost 5 (epoch E1, scope HASH1123).",
  },
];

/**
 * Audit rows for the PKG-001 package history (UI-02 package-keyed timeline,
 * FND-08). `trailer_id` is null so these package-keyed rows do not pollute the
 * trailer-keyed (`T1`) history fixture — the two reads filter by different keys.
 */
const PACKAGE_AUDIT_ROWS: FakeAuditRow[] = [
  {
    global_seq: 30n,
    package_id: "PKG-001",
    trailer_id: null,
    event_type: "PackageScanned",
    occurred_at: "2026-02-01T00:02:00.000Z",
    hub_id: "MEM",
    scan_type: "RFID",
    recommendation: null,
  },
  {
    global_seq: 40n,
    package_id: "PKG-001",
    trailer_id: null,
    event_type: "PlanGenerated",
    occurred_at: "2026-02-01T00:03:00.000Z",
    hub_id: null,
    scan_type: null,
    recommendation: "Plan PLAN1 generated for package PKG-001: FEASIBLE, objective cost 5 (epoch E1, scope HASH1123).",
  },
];

// ---------------------------------------------------------------------------
// App fixtures
// ---------------------------------------------------------------------------

async function buildAppWithPlan(): Promise<FastifyInstance> {
  const db = buildFakeDb({
    trailerRows: [TRAILER_WITH_PLAN],
    hubInventoryRows: [HUB_MEM],
    eventRows: [ROUTE_EVENT, PLAN_ACCEPTED_EVENT],
    auditRows: [...AUDIT_ROWS, ...PACKAGE_AUDIT_ROWS],
  });
  const app = Fastify({ logger: false });
  registerPlanDetailRoutes(app, db);
  await app.ready();
  return app;
}

async function buildAppEmpty(): Promise<FastifyInstance> {
  const db = buildFakeDb({
    trailerRows: [],
    hubInventoryRows: [],
    eventRows: [],
    auditRows: [],
  });
  const app = Fastify({ logger: false });
  registerPlanDetailRoutes(app, db);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /trailers/:id/plan (VIZ-05)
// ---------------------------------------------------------------------------

describe("GET /trailers/:id/plan (VIZ-05)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 with rearToNose, instructions, and explanation for a known trailer", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/trailers/T1/plan",
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<Record<string, unknown>>();

    // Shape assertions
    expect(Array.isArray(body["rearToNose"])).toBe(true);
    expect(body["instructions"]).toBeDefined();
    expect(typeof body["explanation"]).toBe("string");
    expect((body["explanation"] as string).length).toBeGreaterThan(0);
  });

  it("rearToNose order has depth 0 at index 0 (rear first)", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/trailers/T1/plan",
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ rearToNose: Array<{ depth: number }> }>();
    // The rearToNose array is ordered depth ascending (0 = rear = first)
    const depths = body.rearToNose.map((s) => s.depth);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]!).toBeGreaterThanOrEqual(depths[i - 1]!);
    }
  });

  it("returns 404 for an unknown trailer", async () => {
    app = await buildAppEmpty();
    const resp = await app.inject({
      method: "GET",
      url: "/trailers/UNKNOWN/plan",
    });
    expect(resp.statusCode).toBe(404);
  });

  it("returns 404 for a trailer with no accepted plan (no packages assigned)", async () => {
    const db = buildFakeDb({
      trailerRows: [
        {
          ...TRAILER_WITH_PLAN,
          trailer_id: "T2",
          assigned_package_ids: [], // no packages → no plan
        },
      ],
      hubInventoryRows: [],
      eventRows: [ROUTE_EVENT],
      auditRows: [],
    });
    app = Fastify({ logger: false });
    registerPlanDetailRoutes(app, db);
    await app.ready();
    const resp = await app.inject({
      method: "GET",
      url: "/trailers/T2/plan",
    });
    expect(resp.statusCode).toBe(404);
  });

  it("validates :id as non-empty (T-05-07)", async () => {
    app = await buildAppWithPlan();
    // An empty :id would not match the route, Fastify returns 404 by default
    const resp = await app.inject({
      method: "GET",
      url: "/trailers//plan",
    });
    // Route shouldn't match or should fail validation
    expect(resp.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("is read-only: does not write to the event store", async () => {
    // If selectFrom throws on write calls, a 200 proves no writes happened.
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/trailers/T1/plan",
    });
    expect(resp.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /trailers/:id/history (UI-02)
// ---------------------------------------------------------------------------

describe("GET /trailers/:id/history (UI-02)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 with an array of audit entries for a known trailer", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/trailers/T1/history",
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2); // TrailerDocked + PlanGenerated
  });

  it("returns entries in globalSeq order", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({ method: "GET", url: "/trailers/T1/history" });
    const body = resp.json<Array<{ globalSeq: string }>>();
    const seqs = body.map((e) => BigInt(e.globalSeq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]! >= seqs[i - 1]!).toBe(true);
    }
  });

  it("includes the captured recommendation on plan-lifecycle entries", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({ method: "GET", url: "/trailers/T1/history" });
    const body = resp.json<Array<{ eventType: string; recommendation: string | null }>>();
    const planRow = body.find((e) => e.eventType === "PlanGenerated");
    expect(planRow).toBeDefined();
    expect(planRow?.recommendation).not.toBeNull();
    expect(planRow?.recommendation).toContain("PLAN1");
  });

  it("returns empty array for an unknown trailer (no history = empty, not 404)", async () => {
    app = await buildAppEmpty();
    const resp = await app.inject({
      method: "GET",
      url: "/trailers/UNKNOWN/history",
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual([]);
  });

  it("validates :id as non-empty (T-05-07)", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/trailers//history",
    });
    expect(resp.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /packages/:id/history (UI-02, FND-08)
// ---------------------------------------------------------------------------

describe("GET /packages/:id/history (UI-02)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 with an array of audit entries for a known package", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/packages/PKG-001/history",
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2); // PackageScanned + PlanGenerated
  });

  it("returns entries in globalSeq order", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/packages/PKG-001/history",
    });
    const body = resp.json<Array<{ globalSeq: string }>>();
    const seqs = body.map((e) => BigInt(e.globalSeq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]! >= seqs[i - 1]!).toBe(true);
    }
  });

  it("returns the trailer-history DTO shape (globalSeq/eventType/occurredAt/hubId/scanType/recommendation)", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/packages/PKG-001/history",
    });
    const body = resp.json<Array<Record<string, unknown>>>();
    const scanRow = body.find((e) => e["eventType"] === "PackageScanned");
    expect(scanRow).toBeDefined();
    expect(typeof scanRow!["globalSeq"]).toBe("string");
    expect(scanRow!["occurredAt"]).toBe("2026-02-01T00:02:00.000Z");
    expect(scanRow!["hubId"]).toBe("MEM");
    expect(scanRow!["scanType"]).toBe("RFID");
    expect(scanRow!["recommendation"]).toBeNull();
  });

  it("includes the captured recommendation on plan-lifecycle entries", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/packages/PKG-001/history",
    });
    const body = resp.json<Array<{ eventType: string; recommendation: string | null }>>();
    const planRow = body.find((e) => e.eventType === "PlanGenerated");
    expect(planRow).toBeDefined();
    expect(planRow?.recommendation).not.toBeNull();
    expect(planRow?.recommendation).toContain("PKG-001");
  });

  it("returns empty array for an unknown package (no history = empty, not 404)", async () => {
    app = await buildAppEmpty();
    const resp = await app.inject({
      method: "GET",
      url: "/packages/UNKNOWN/history",
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual([]);
  });

  it("validates :id as non-empty (T-05-07)", async () => {
    app = await buildAppWithPlan();
    const resp = await app.inject({
      method: "GET",
      url: "/packages//history",
    });
    expect(resp.statusCode).toBeGreaterThanOrEqual(400);
  });
});
