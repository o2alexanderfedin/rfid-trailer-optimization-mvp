/**
 * Tests for the KPI HTTP routes. Plan 05-03, Task 3 (TDD RED → GREEN).
 *
 * Verifies:
 *  - GET /kpis returns 200 with a full KpiSnapshot shape (incl. baseline).
 *  - GET /kpis/comparison returns 200 with { baseline, optimizer, deltas }.
 *  - Both routes are read-only (no event-store writes via inject).
 *
 * All tests run without a real DB (inject-based, DB-free per plan.ts pattern).
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { KpiSnapshot } from "../ws/envelope.js";
import { registerKpiRoutes } from "./kpis.js";
import type { ApiDb } from "./queries.js";

// ---------------------------------------------------------------------------
// Minimal fake DB — routes must be read-only, so we inject an empty stub.
// ---------------------------------------------------------------------------

const FAKE_DB: ApiDb = {
  selectFrom: () => {
    throw new Error("DB should not be called for KPI routes");
  },
} as unknown as ApiDb;

// ---------------------------------------------------------------------------
// App fixture
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerKpiRoutes(app, FAKE_DB);
  await app.ready();
  return app;
}

describe("GET /kpis", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 with a KpiSnapshot shape", async () => {
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

    // The baseline sub-object must also be present.
    expect(body["baseline"]).toBeDefined();
    const baseline = body["baseline"] as Record<string, unknown>;
    for (const field of numericFields) {
      expect(typeof baseline[field], `baseline.${field}`).toBe("number");
    }
  });

  it("is read-only: does not write to the event store", async () => {
    // FAKE_DB throws if selectFrom is called; if we get a 200, no DB access happened.
    // (The current KPI endpoint computes from static defaults without a DB query.)
    app = await buildApp();
    const resp = await app.inject({ method: "GET", url: "/kpis" });
    expect(resp.statusCode).toBe(200);
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
