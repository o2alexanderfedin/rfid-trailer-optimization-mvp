/**
 * client.ts MSW-backed fetch reference test (the `ui` / jsdom lane).
 *
 * Proves the MSW + `fetch` lane works: each typed helper hits the modelled
 * `/api/*` surface and returns the contract-shaped DTO. This takes client.ts
 * from 0% → ~full line coverage (every helper + its error branch).
 *
 * Lives under `src/api/*.test.ts` and is routed to the jsdom `ui` project (NOT
 * the node `unit` lane) by the project config, so the MSW node server from the
 * jsdom setup intercepts these requests.
 */
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../test/msw/server.js";
import {
  HUBS,
  ROUTES,
  KPIS,
  EXCEPTIONS,
  SPEED_DEFAULT,
} from "../../test/msw/handlers.js";
import {
  fetchHubs,
  fetchRoutes,
  fetchKpis,
  fetchKpiComparison,
  fetchTrailerPlan,
  fetchTrailerHistory,
  fetchPackageHistory,
  setSimSpeed,
} from "./client.js";

describe("client.ts (MSW fetch lane)", () => {
  // --- happy paths against the modelled handlers ---------------------------

  it("fetchHubs returns the hub DTOs", async () => {
    const hubs = await fetchHubs();
    expect(hubs).toEqual(HUBS);
    expect(hubs.map((h) => h.hubId)).toEqual(["LAX", "DFW", "ORD"]);
  });

  it("fetchRoutes returns route DTOs with [lon,lat] geometry", async () => {
    const routes = await fetchRoutes();
    expect(routes).toEqual(ROUTES);
    expect(routes[0]?.geometry[0]).toEqual([-118.4085, 33.9416]);
  });

  it("fetchKpis returns the live KPI snapshot incl. baseline", async () => {
    const kpis = await fetchKpis();
    expect(kpis).toEqual(KPIS);
    expect(kpis.baseline.rehandleCount).toBe(19);
  });

  it("setSimSpeed POSTs and returns the effective speed state", async () => {
    const applied = await setSimSpeed({ multiplier: 2 });
    expect(applied.multiplier).toBe(2);
    expect(applied.paused).toBe(false);
  });

  it("setSimSpeed reflects pause as simSpeed 0", async () => {
    const applied = await setSimSpeed({ paused: true });
    expect(applied.paused).toBe(true);
    expect(applied.simSpeed).toBe(0);
  });

  it("setSimSpeed with no fields echoes the defaults", async () => {
    const applied = await setSimSpeed({});
    expect(applied).toEqual(SPEED_DEFAULT);
  });

  // --- per-test handler overrides exercise the remaining helpers + branches -

  it("fetchTrailerPlan returns the plan DTO when present", async () => {
    server.use(
      http.get("/api/trailers/:id/plan", () =>
        HttpResponse.json({
          trailerId: "T-100",
          rearToNose: [{ depth: 0, loadBlockIds: ["B-1"] }],
          instructions: {
            trailerId: "T-100",
            zones: [{ zone: "rear", blockIds: ["B-1"], text: "Load B-1 first" }],
            text: "Load rear to nose",
          },
          explanation: "LIFO-correct plan",
        }),
      ),
    );
    const plan = await fetchTrailerPlan("T-100");
    expect(plan?.trailerId).toBe("T-100");
    expect(plan?.rearToNose[0]?.depth).toBe(0);
  });

  it("fetchTrailerPlan returns null on 404 (no plan yet)", async () => {
    server.use(
      http.get("/api/trailers/:id/plan", () => new HttpResponse(null, { status: 404 })),
    );
    expect(await fetchTrailerPlan("T-unknown")).toBeNull();
  });

  it("fetchTrailerHistory + fetchPackageHistory return audit entries", async () => {
    const entries = [
      {
        globalSeq: "1",
        eventType: "TrailerDeparted",
        occurredAt: "2026-06-21T00:00:00.000Z",
        hubId: "LAX",
        scanType: null,
        recommendation: null,
      },
    ];
    server.use(
      http.get("/api/trailers/:id/history", () => HttpResponse.json(entries)),
      http.get("/api/packages/:id/history", () => HttpResponse.json(entries)),
    );
    expect(await fetchTrailerHistory("T-100")).toEqual(entries);
    expect(await fetchPackageHistory("P-9")).toEqual(entries);
  });

  it("fetchKpiComparison returns baseline-vs-optimizer scores", async () => {
    server.use(
      http.get("/api/kpis/comparison", () =>
        HttpResponse.json({
          baseline: { rehandleScore: 10, utilizationScore: 70 },
          optimizer: { rehandleScore: 3, utilizationScore: 82 },
          deltas: { rehandleScore: -7, utilizationScore: 12 },
        }),
      ),
    );
    const cmp = await fetchKpiComparison();
    expect(cmp.deltas.rehandleScore).toBe(-7);
  });

  it("exposes the open exceptions via the modelled GET /api/exceptions", async () => {
    const res = await fetch("/api/exceptions");
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual(EXCEPTIONS);
  });

  // --- error branches (each helper throws on a non-ok response) -------------

  it("throws a descriptive error when GET /api/hubs fails", async () => {
    server.use(
      http.get("/api/hubs", () => new HttpResponse(null, { status: 500 })),
    );
    await expect(fetchHubs()).rejects.toThrow(/GET \/api\/hubs failed: 500/);
  });

  it("throws when GET /api/routes fails", async () => {
    server.use(
      http.get("/api/routes", () => new HttpResponse(null, { status: 503 })),
    );
    await expect(fetchRoutes()).rejects.toThrow(
      /GET \/api\/routes failed: 503/,
    );
  });

  it("throws when GET /api/kpis fails", async () => {
    server.use(
      http.get("/api/kpis", () => new HttpResponse(null, { status: 500 })),
    );
    await expect(fetchKpis()).rejects.toThrow(/GET \/api\/kpis failed: 500/);
  });

  it("throws when GET /api/kpis/comparison fails", async () => {
    server.use(
      http.get("/api/kpis/comparison", () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );
    await expect(fetchKpiComparison()).rejects.toThrow(
      /GET \/api\/kpis\/comparison failed: 500/,
    );
  });

  it("fetchTrailerPlan throws on a non-404 error response", async () => {
    server.use(
      http.get("/api/trailers/:id/plan", () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );
    await expect(fetchTrailerPlan("T-err")).rejects.toThrow(
      /GET \/api\/trailers\/T-err\/plan failed: 500/,
    );
  });

  it("fetchTrailerHistory throws when the history endpoint fails", async () => {
    server.use(
      http.get("/api/trailers/:id/history", () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );
    await expect(fetchTrailerHistory("T-err")).rejects.toThrow(
      /GET \/api\/trailers\/T-err\/history failed: 500/,
    );
  });

  it("fetchPackageHistory throws when the history endpoint fails", async () => {
    server.use(
      http.get("/api/packages/:id/history", () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );
    await expect(fetchPackageHistory("P-err")).rejects.toThrow(
      /GET \/api\/packages\/P-err\/history failed: 500/,
    );
  });

  it("throws when POST /api/sim/speed fails", async () => {
    server.use(
      http.post("/api/sim/speed", () => new HttpResponse(null, { status: 400 })),
    );
    await expect(setSimSpeed({ multiplier: 99 })).rejects.toThrow(
      /POST \/api\/sim\/speed failed: 400/,
    );
  });

  it("passes an AbortSignal through without changing the result", async () => {
    const ac = new AbortController();
    const hubs = await fetchHubs(ac.signal);
    expect(hubs).toEqual(HUBS);
  });

  it("forwards an AbortSignal through every signal-aware helper", async () => {
    const ac = new AbortController();
    const entries = [
      {
        globalSeq: "1",
        eventType: "TrailerDeparted",
        occurredAt: "2026-06-21T00:00:00.000Z",
        hubId: "LAX",
        scanType: null,
        recommendation: null,
      },
    ];
    server.use(
      http.get("/api/kpis/comparison", () =>
        HttpResponse.json({
          baseline: { rehandleScore: 10, utilizationScore: 70 },
          optimizer: { rehandleScore: 3, utilizationScore: 82 },
          deltas: { rehandleScore: -7, utilizationScore: 12 },
        }),
      ),
      http.get("/api/trailers/:id/plan", () =>
        new HttpResponse(null, { status: 404 }),
      ),
      http.get("/api/trailers/:id/history", () => HttpResponse.json(entries)),
      http.get("/api/packages/:id/history", () => HttpResponse.json(entries)),
    );

    expect(await fetchRoutes(ac.signal)).toEqual(ROUTES);
    expect(await fetchKpis(ac.signal)).toEqual(KPIS);
    expect(await fetchKpiComparison(ac.signal)).toBeDefined();
    expect(await fetchTrailerPlan("T-1", ac.signal)).toBeNull();
    expect(await fetchTrailerHistory("T-1", ac.signal)).toEqual(entries);
    expect(await fetchPackageHistory("P-1", ac.signal)).toEqual(entries);
    expect(await setSimSpeed({ multiplier: 2 }, ac.signal)).toBeDefined();
  });
});
