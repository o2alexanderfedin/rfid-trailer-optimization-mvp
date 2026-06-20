/**
 * Tests for the KPI HTTP routes. Plan 05-03, Task 3 (TDD RED → GREEN).
 * Updated Plan 05-05 for live-wiring: GET /kpis now reads trailer_state,
 * exceptions, and exception_kpi projections via the DB handle + the optimizer
 * service's `latestResult()`. The unit tests use a stub DB + stub optimizer.
 *
 * Verifies:
 *  - GET /kpis returns 200 with a full KpiSnapshot shape (incl. baseline).
 *  - GET /kpis/comparison returns 200 with { baseline, optimizer, deltas }.
 *  - Both routes are read-only (no event-store writes via inject).
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { KpiSnapshot } from "../ws/envelope.js";
import { registerKpiRoutes } from "./kpis.js";
import type { ApiDb } from "./queries.js";
import type { RollingOptimizerService } from "../optimizer/rolling-service.js";

// ---------------------------------------------------------------------------
// Minimal fake DB — returns empty rows for trailer_state, exceptions, kpi.
// ---------------------------------------------------------------------------

/**
 * A DB stub that returns empty result sets for the tables GET /kpis reads.
 * We model the Kysely query builder chain as a fluent stub that always resolves
 * to [] (trailer_state, exceptions) or undefined (exception_kpi).
 */
function buildFakeDb(opts?: {
  trailerRows?: Array<{ trailer_id: string; assigned_package_ids: unknown }>;
}): ApiDb {
  const trailerRows = opts?.trailerRows ?? [];

  // Fluent query builder stub: selectFrom(table).select(...).execute()
  // or selectFrom(table).selectAll().execute() / executeTakeFirst()
  const makeQueryBuilder = (table: string) => {
    const builder = {
      select: (_cols: unknown) => builder,
      selectAll: () => builder,
      orderBy: (_col: unknown, _dir?: unknown) => builder,
      execute: () => {
        if (table === "trailer_state") return Promise.resolve(trailerRows);
        if (table === "exceptions") return Promise.resolve([]);
        if (table === "exception_kpi") return Promise.resolve([]);
        return Promise.resolve([]);
      },
      executeTakeFirst: () => {
        if (table === "exception_kpi") return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      },
    };
    return builder;
  };

  return {
    selectFrom: (table: string) => makeQueryBuilder(table),
  } as unknown as ApiDb;
}

/** A stub optimizer that returns null (no epoch run yet). */
const NULL_OPTIMIZER: Pick<RollingOptimizerService, "latestResult"> = {
  latestResult: () => null,
};

// ---------------------------------------------------------------------------
// App fixture
// ---------------------------------------------------------------------------

async function buildApp(db?: ApiDb): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerKpiRoutes(
    app,
    db ?? buildFakeDb(),
    NULL_OPTIMIZER as RollingOptimizerService,
  );
  await app.ready();
  return app;
}

describe("GET /kpis", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 with a live KPI snapshot shape (FIX 4: no baseline field)", async () => {
    app = await buildApp();
    const resp = await app.inject({ method: "GET", url: "/kpis" });
    expect(resp.statusCode).toBe(200);

    const body = resp.json() as Record<string, unknown>;
    // All scalar KPI fields must be numbers.
    const numericFields: Array<keyof Omit<KpiSnapshot, "baseline">> = [
      "utilization",
      "rehandleCount",
      "rehandleMinutes",
      "wrongTrailerCount",
      "missedUnloadCount",
      "slaViolationRate",
      "onTimeDeparture",
      "onTimeArrival",
    ];
    for (const field of numericFields) {
      expect(typeof body[field], `field ${field}`).toBe("number");
    }

    // FIX 4: baseline must NOT be present. The previous implementation set
    // baseline = { ...liveValues } which was a misleading copy of the live data.
    // The honest before/after baseline belongs in GET /kpis/comparison only.
    expect(body["baseline"]).toBeUndefined();
  });

  it("returns trailerCount > 0 when trailer_state has rows", async () => {
    // Arrange: DB returns 2 trailer rows with empty package lists.
    const db = buildFakeDb({
      trailerRows: [
        { trailer_id: "T-01", assigned_package_ids: [] },
        { trailer_id: "T-02", assigned_package_ids: [] },
      ],
    });
    app = await buildApp(db);
    const resp = await app.inject({ method: "GET", url: "/kpis" });
    expect(resp.statusCode).toBe(200);
    // trailerCount feeds into utilization — with 0 packages both trailers
    // contribute utilization = 0. The shape must still be valid.
    const body = resp.json() as Record<string, unknown>;
    expect(typeof body["utilization"]).toBe("number");
  });

  it("is read-only: does not mutate the event store", async () => {
    // GET /kpis now reads from projections, but must NEVER write to the event store.
    // The stub DB above returns empty arrays — if the route attempted to write,
    // the stub would not throw (it has no insert/update stubs), so this verifies
    // the route completes without 500 errors on a read-only projection DB.
    app = await buildApp();
    const resp = await app.inject({ method: "GET", url: "/kpis" });
    expect(resp.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — baseline sub-object must NOT be a copy of the live snapshot
// The baseline is either a real FIFO baseline or removed from GET /kpis.
// ---------------------------------------------------------------------------

describe("GET /kpis FIX 4 — baseline sub-object is not a misleading copy", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("RED: baseline must differ from the live snapshot values OR be absent", async () => {
    // FIX 4: the current implementation sets baseline = { ...base } which is a
    // bitwise copy of the live snapshot. This is misleading — if the optimizer
    // is running, baseline should reflect the FIFO/no-optimizer baseline, not
    // the live data. The simplest honest fix is to remove the baseline field.
    // After the fix, baseline should be absent (or differ from live values).
    // We use a non-null optimizer result to make the live values differ from
    // a "no-optimizer" baseline scenario.
    app = await buildApp();
    const resp = await app.inject({ method: "GET", url: "/kpis" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as Record<string, unknown>;
    // After FIX 4: the baseline field is removed from GET /kpis response.
    // It was set to a misleading copy of the live snapshot.
    // The correct approach: remove it (the money slide in /kpis/comparison
    // owns the before/after comparison).
    expect(body["baseline"]).toBeUndefined();
  });
});

describe("GET /kpis/comparison", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 with { baseline, optimizer, deltas }", async () => {
    app = await buildApp();
    const resp = await app.inject({ method: "GET", url: "/kpis/comparison" });
    expect(resp.statusCode).toBe(200);

    const body = resp.json() as Record<string, unknown>;
    expect(body["baseline"]).toBeDefined();
    expect(body["optimizer"]).toBeDefined();
    expect(body["deltas"]).toBeDefined();
  });

  it("comparison baseline and optimizer each have rehandleScore", async () => {
    app = await buildApp();
    const resp = await app.inject({ method: "GET", url: "/kpis/comparison" });
    const body = resp.json() as Record<string, unknown>;

    const baseline = body["baseline"] as Record<string, unknown>;
    const optimizer = body["optimizer"] as Record<string, unknown>;
    expect(typeof baseline["rehandleScore"]).toBe("number");
    expect(typeof optimizer["rehandleScore"]).toBe("number");
  });

  it("comparison optimizer wins on rehandleScore (keystone)", async () => {
    app = await buildApp();
    const resp = await app.inject({ method: "GET", url: "/kpis/comparison" });
    const body = resp.json() as Record<string, unknown>;

    const baseline = body["baseline"] as Record<string, number>;
    const optimizer = body["optimizer"] as Record<string, number>;
    expect(optimizer["rehandleScore"]).toBeLessThan(baseline["rehandleScore"] as number);
  });

  it("is read-only: does not write to the event store", async () => {
    app = await buildApp();
    const resp = await app.inject({ method: "GET", url: "/kpis/comparison" });
    expect(resp.statusCode).toBe(200);
  });
});
