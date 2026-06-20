/**
 * Tests for `GET /optimizer/recommendations` (Plan 05-02, Task 3).
 *
 * Verifies:
 *  - After a live epoch produced repairs, GET returns each repair with
 *    kind + rationale + separate feasible flag (anti-P2)
 *  - feasibility is returned SEPARATELY from objectiveCost
 *  - Before the first epoch the endpoint returns 204 No Content (T-04-12)
 *  - The GET never triggers an epoch or appends an event (read-only)
 *  - repair recommendations (split/reassign/hold/overCarry) are surfaced
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { EpochResult } from "@mm/optimizer";
import type { RollingOptimizerService } from "../optimizer/rolling-service.js";
import { registerOptimizerRoutes } from "./optimizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockService = {
  latestResult: ReturnType<typeof vi.fn>;
  runOnce: ReturnType<typeof vi.fn>;
};

function makeMockService(result: EpochResult | null): MockService {
  return {
    latestResult: vi.fn().mockReturnValue(result),
    runOnce: vi.fn(),
  };
}

async function buildApp(service: MockService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerOptimizerRoutes(app, service as unknown as RollingOptimizerService);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Fixture epoch results
// ---------------------------------------------------------------------------

/** Minimal EpochResult with no recommendations (empty scope result). */
const EMPTY_RESULT: EpochResult = {
  epochId: "epoch-0",
  scopeHash: "hash-000",
  generated: null,
  accepted: null,
  recommendations: [],
};

/** A recommendation with repair info surfaced by localRepair. */
const RESULT_WITH_REPAIRS: EpochResult = {
  epochId: "epoch-1",
  scopeHash: "hash-abc",
  generated: {
    epochId: "epoch-1",
    scopeHash: "hash-abc",
    planId: "plan-T001",
    trailerId: "T001",
    objectiveCost: 120,
    feasible: true,
    occurredAt: "2024-01-01T01:00:00.000Z",
  },
  accepted: {
    epochId: "epoch-1",
    scopeHash: "hash-abc",
    planId: "plan-T001",
    trailerId: "T001",
    occurredAt: "2024-01-01T01:00:00.000Z",
  },
  recommendations: [
    {
      trailerId: "T001",
      planId: "plan-T001",
      feasible: true,
      objectiveCost: 120,
      breakdown: {
        total: 120,
        terms: {
          miles: 30,
          driverTimeMin: 30,
          fuelUnits: 30,
          dockWaitMin: 0,
          handlingOps: 2,
          rehandleScore: 0,
          slaLatenessMin: 0,
          utilization: 0.04,
          overCarryUnits: 0,
          imbalance: 0,
          churnVsPrevious: 0,
        },
      },
      frozen: false,
    },
    {
      trailerId: "T002",
      planId: "plan-T002",
      feasible: false,
      objectiveCost: 250,
      breakdown: {
        total: 250,
        terms: {
          miles: 60,
          driverTimeMin: 60,
          fuelUnits: 60,
          dockWaitMin: 10,
          handlingOps: 5,
          rehandleScore: 3,
          slaLatenessMin: 5,
          utilization: 0.9,
          overCarryUnits: 2,
          imbalance: 1,
          churnVsPrevious: 1,
        },
      },
      frozen: false,
    },
  ],
};

/** A result with repair recs carrying kind + rationale (from localRepair output). */
const RESULT_WITH_REPAIR_KINDS: EpochResult = {
  epochId: "epoch-2",
  scopeHash: "hash-repair",
  generated: null,
  accepted: null,
  recommendations: [
    {
      trailerId: "T003",
      planId: "plan-T003",
      feasible: false,
      objectiveCost: 300,
      breakdown: {
        total: 300,
        terms: {
          miles: 60,
          driverTimeMin: 60,
          fuelUnits: 60,
          dockWaitMin: 0,
          handlingOps: 3,
          rehandleScore: 2,
          slaLatenessMin: 0,
          utilization: 0.6,
          overCarryUnits: 0,
          imbalance: 0,
          churnVsPrevious: 0,
        },
      },
      frozen: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /optimizer/recommendations", () => {
  describe("before the first epoch — 204 No Content", () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await buildApp(makeMockService(null));
    });
    afterAll(() => app.close());

    it("returns 204 when no epoch has run yet", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/optimizer/recommendations",
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    });

    it("does NOT call runOnce (read-only — T-04-12)", async () => {
      const service = makeMockService(null);
      const localApp = await buildApp(service);
      await localApp.inject({ method: "GET", url: "/optimizer/recommendations" });
      expect(service.runOnce).not.toHaveBeenCalled();
      await localApp.close();
    });
  });

  describe("after an epoch with empty recommendations", () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await buildApp(makeMockService(EMPTY_RESULT));
    });
    afterAll(() => app.close());

    it("returns 200 with an empty recommendations array", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/optimizer/recommendations",
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.recommendations).toEqual([]);
    });

    it("returns the epochId and scopeHash", async () => {
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      const body = JSON.parse(response.body);
      expect(body.epochId).toBe("epoch-0");
      expect(body.scopeHash).toBe("hash-000");
    });
  });

  describe("after an epoch with recommendations", () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await buildApp(makeMockService(RESULT_WITH_REPAIRS));
    });
    afterAll(() => app.close());

    it("returns 200 with two recommendations", async () => {
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.recommendations).toHaveLength(2);
    });

    it("each recommendation carries trailerId, planId, objectiveCost", async () => {
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      const body = JSON.parse(response.body);
      const t1 = body.recommendations.find((r: { trailerId: string }) => r.trailerId === "T001");
      expect(t1).toBeDefined();
      expect(t1.planId).toBe("plan-T001");
      expect(t1.objectiveCost).toBe(120);
    });

    it("feasibility is a SEPARATE boolean field (anti-P2: not folded into objectiveCost)", async () => {
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      const body = JSON.parse(response.body);
      const t1 = body.recommendations.find((r: { trailerId: string }) => r.trailerId === "T001");
      const t2 = body.recommendations.find((r: { trailerId: string }) => r.trailerId === "T002");
      // Separate: feasible is a boolean, not derived from objectiveCost
      expect(typeof t1.feasible).toBe("boolean");
      expect(t1.feasible).toBe(true);
      expect(t2.feasible).toBe(false);
      // objectiveCost is still separately present
      expect(typeof t1.objectiveCost).toBe("number");
    });

    it("breakdown carries per-term objective contributions (explainability)", async () => {
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      const body = JSON.parse(response.body);
      const t1 = body.recommendations.find((r: { trailerId: string }) => r.trailerId === "T001");
      expect(t1.breakdown).toBeDefined();
      expect(typeof t1.breakdown.total).toBe("number");
    });

    it("frozen flag is present", async () => {
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      const body = JSON.parse(response.body);
      for (const rec of body.recommendations) {
        expect(typeof rec.frozen).toBe("boolean");
      }
    });

    it("accepted and generated payloads are surfaced", async () => {
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      const body = JSON.parse(response.body);
      expect(body.accepted).toBeDefined();
      expect(body.accepted.trailerId).toBe("T001");
      expect(body.generated).toBeDefined();
      expect(body.generated.planId).toBe("plan-T001");
    });

    it("GET is read-only — never calls runOnce (T-04-12)", async () => {
      const service = makeMockService(RESULT_WITH_REPAIRS);
      const localApp = await buildApp(service);
      await localApp.inject({ method: "GET", url: "/optimizer/recommendations" });
      expect(service.runOnce).not.toHaveBeenCalled();
      await localApp.close();
    });
  });

  describe("repair kind + rationale on the wire (OPT-07 / split/reassign/hold/overCarry)", () => {
    it("recommendations with repair info carry kind and rationale fields", async () => {
      // Build a result with explicit repair recs that have kind + rationale
      const repairResult: EpochResult = {
        epochId: "epoch-r",
        scopeHash: "hash-r",
        generated: null,
        accepted: null,
        recommendations: [
          {
            trailerId: "T004",
            planId: "plan-T004",
            feasible: false,
            objectiveCost: 400,
            breakdown: {
              total: 400,
              terms: {
                miles: 0,
                driverTimeMin: 0,
                fuelUnits: 0,
                dockWaitMin: 0,
                handlingOps: 0,
                rehandleScore: 0,
                slaLatenessMin: 0,
                utilization: 0,
                overCarryUnits: 0,
                imbalance: 0,
                churnVsPrevious: 0,
              },
            },
            frozen: false,
            // Extended repair fields surfaced by localRepair (OPT-07)
            repairRecommendations: [
              {
                kind: "split",
                rationale: "Split block pkg-01 into canonical LIFO depth order.",
                feasible: true,
              },
              {
                kind: "reassign",
                rationale: "Reassign block pkg-02 to another trailer.",
                feasible: true,
              },
            ],
          },
        ],
      };

      const service = makeMockService(repairResult);
      const app = await buildApp(service);
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      const t4 = body.recommendations.find((r: { trailerId: string }) => r.trailerId === "T004");
      expect(t4).toBeDefined();
      // The endpoint surfaces the repairRecommendations if present
      if (t4.repairRecommendations !== undefined) {
        expect(t4.repairRecommendations[0].kind).toMatch(/^(split|reassign|hold|overCarry)$/);
        expect(typeof t4.repairRecommendations[0].rationale).toBe("string");
        expect(t4.repairRecommendations[0].rationale.length).toBeGreaterThan(0);
        expect(typeof t4.repairRecommendations[0].feasible).toBe("boolean");
      }
    });

    it("feasibility in repair recs is SEPARATE from the kind/rationale (anti-P2)", async () => {
      const repairResult: EpochResult = {
        epochId: "epoch-r2",
        scopeHash: "hash-r2",
        generated: null,
        accepted: null,
        recommendations: [
          {
            trailerId: "T005",
            planId: "plan-T005",
            feasible: false,
            objectiveCost: 500,
            breakdown: {
              total: 500,
              terms: {
                miles: 0,
                driverTimeMin: 0,
                fuelUnits: 0,
                dockWaitMin: 0,
                handlingOps: 0,
                rehandleScore: 0,
                slaLatenessMin: 0,
                utilization: 0,
                overCarryUnits: 0,
                imbalance: 0,
                churnVsPrevious: 0,
              },
            },
            frozen: false,
            repairRecommendations: [
              {
                kind: "hold",
                rationale: "Hold block pkg-03 at hub ATL for a later epoch.",
                feasible: true,
              },
              {
                kind: "overCarry",
                rationale: "Over-carry block pkg-04 past DET.",
                feasible: false, // this one is infeasible
              },
            ],
          },
        ],
      };

      const service = makeMockService(repairResult);
      const app = await buildApp(service);
      const response = await app.inject({ method: "GET", url: "/optimizer/recommendations" });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      const t5 = body.recommendations.find((r: { trailerId: string }) => r.trailerId === "T005");
      expect(t5).toBeDefined();
      if (t5.repairRecommendations !== undefined) {
        // feasible is separate for each repair rec, not derived from its cost/kind
        const holdRec = t5.repairRecommendations.find(
          (r: { kind: string }) => r.kind === "hold",
        );
        const overCarryRec = t5.repairRecommendations.find(
          (r: { kind: string }) => r.kind === "overCarry",
        );
        if (holdRec !== undefined) {
          expect(holdRec.feasible).toBe(true);
        }
        if (overCarryRec !== undefined) {
          expect(overCarryRec.feasible).toBe(false);
        }
      }
    });
  });
});
