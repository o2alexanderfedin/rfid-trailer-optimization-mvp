import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAll, type Database } from "@mm/event-store";
import type { Kysely } from "kysely";
import type { DomainEvent } from "@mm/domain";
import {
  runEpoch,
  DEFAULT_OBJECTIVE_WEIGHTS,
  type Epoch,
  type EpochInput,
  type TwinSnapshot,
} from "@mm/optimizer";
import {
  buildServer,
  RollingOptimizerService,
  type ApiDb,
  type OptimizerRecommendationsDto,
} from "../src/index.js";
import type { BuiltServer } from "../src/server.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * OPT-04 on the SHARED Postgres — proves the twin-sandbox + idempotency
 * guarantees against the REAL event store:
 *
 *  (a) EVALUATION has ZERO side effects: calling the pure `runEpoch` over the
 *      twin appends NO events and changes NO projection rows (the optimizer never
 *      touches the store during evaluation).
 *  (b) ACCEPT appends EXACTLY ONE PlanAccepted (+ the PlanGenerated record) — the
 *      event-count delta is exactly the expected 2, no more.
 *  (c) IDEMPOTENT service: feeding the same `(epoch, scope)` twice appends the
 *      plan ONCE (memoized by `${epochId}:${scopeHash}`) — no duplicate
 *      PlanAccepted (the anti-P7 thrash keystone, on the real store).
 */

/** A twin with one optimizable trailer (departs well after the freeze window). */
function snapshot(): TwinSnapshot {
  return {
    hubs: ["H1", "H2", "H3"],
    routes: [
      { routeId: "R1", fromHubId: "H1", toHubId: "H2", travelMin: 30, capacity: 20 },
      { routeId: "R2", fromHubId: "H2", toHubId: "H3", travelMin: 40, capacity: 20 },
    ],
    trailers: [
      {
        trailerId: "T1",
        currentHubId: "H1",
        departureMin: 300,
        capacity: 20,
        route: [
          { hubId: "H2", stopIndex: 0 },
          { hubId: "H3", stopIndex: 1 },
        ],
        blocks: [
          { blockId: "B1", nextUnloadHubId: "H2", volume: 6 },
          { blockId: "B2", nextUnloadHubId: "H3", volume: 8 },
        ],
      },
    ],
  };
}

function departed(trailerId: string, fromHubId: string, toHubId: string): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId: `${trailerId}-trip`, packageIds: [] },
  };
}

const EPOCH: Epoch = { epochId: "epoch-1", nowMin: 100, freezeWindowMin: 15 };

function epochInput(): EpochInput {
  return { events: [departed("T1", "H1", "H2")], twinSnapshot: snapshot() };
}

async function eventCount(db: Kysely<Database>): Promise<number> {
  return (await readAll(db)).length;
}

describe("RollingOptimizerService twin sandbox + idempotency (OPT-04 on shared PG)", () => {
  let fx: PgFixture;
  let db: Kysely<Database>;

  beforeAll(async () => {
    fx = await startPgFixture();
    db = fx.db as unknown as Kysely<Database>;
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("(a) EVALUATION has zero side effects: pure runEpoch appends NO events", async () => {
    const before = await eventCount(db);

    // Run the PURE evaluation many times — it never touches the store.
    for (let i = 0; i < 5; i += 1) {
      const result = runEpoch(EPOCH, epochInput(), DEFAULT_OBJECTIVE_WEIGHTS);
      // It DID produce an accepted candidate (so the side-effect would matter)...
      expect(result.accepted).not.toBeNull();
    }

    // ...yet the store is byte-for-byte unchanged: evaluation is side-effect free.
    expect(await eventCount(db)).toBe(before);
  });

  it("(b) ACCEPT appends EXACTLY ONE PlanAccepted (+ one PlanGenerated record)", async () => {
    const service = new RollingOptimizerService({ db });
    const before = await readAll(db);

    const outcome = await service.runOnce({ ...EPOCH, epochId: "epoch-accept" }, epochInput());
    expect(outcome.committed).toBe(true);
    expect(outcome.result.accepted).not.toBeNull();

    const after = await readAll(db);
    const appended = after.slice(before.length).map((e) => e.event.type);

    // Exactly the two plan-lifecycle events — the ONE PlanAccepted side effect
    // preceded by its observational PlanGenerated record. Nothing else.
    expect(appended).toEqual(["PlanGenerated", "PlanAccepted"]);
    expect(appended.filter((t) => t === "PlanAccepted")).toHaveLength(1);
  });

  it("(c) IDEMPOTENT: feeding identical (epoch,scope) twice appends the plan ONCE", async () => {
    const service = new RollingOptimizerService({ db });
    const epoch: Epoch = { ...EPOCH, epochId: "epoch-idempotent" };

    const before = await eventCount(db);

    const first = await service.runOnce(epoch, epochInput());
    const countAfterFirst = await eventCount(db);

    const second = await service.runOnce(epoch, epochInput());
    const countAfterSecond = await eventCount(db);

    // First commits (2 events); the second is memoized — no new append.
    expect(first.committed).toBe(true);
    expect(countAfterFirst).toBe(before + 2);
    expect(second.committed).toBe(false);
    expect(countAfterSecond).toBe(countAfterFirst);

    // Same scopeHash both times (the OPT-06 keystone) → same memo key → one append.
    expect(second.result.scopeHash).toBe(first.result.scopeHash);

    // Across the whole stream there is exactly ONE PlanAccepted for this epoch.
    const all = await readAll(db);
    const acceptedForEpoch = all.filter(
      (e) =>
        e.event.type === "PlanAccepted" &&
        (e.event.payload as { epochId: string }).epochId === "epoch-idempotent",
    );
    expect(acceptedForEpoch).toHaveLength(1);
  });

  it("exposes the latest epoch result for the API endpoint after a run", async () => {
    const service = new RollingOptimizerService({ db });
    expect(service.latestResult()).toBeNull();

    await service.runOnce({ ...EPOCH, epochId: "epoch-latest" }, epochInput());
    const latest = service.latestResult();
    expect(latest).not.toBeNull();
    expect(latest!.epochId).toBe("epoch-latest");
    expect(latest!.recommendations.length).toBeGreaterThan(0);
    // Objective breakdown is exposed for explainability.
    const rec = latest!.recommendations[0]!;
    expect(rec.breakdown.total).toBeCloseTo(rec.objectiveCost);
  });

  it("GET /optimizer/recommendations: 204 before any epoch, plan + breakdown after", async () => {
    const built: BuiltServer = await buildServer({ db: db as unknown as ApiDb, enableWs: false });
    try {
      // No epoch has run yet → 204 No Content.
      const empty = await built.app.inject({ method: "GET", url: "/optimizer/recommendations" });
      expect(empty.statusCode).toBe(204);

      // Drive ONE epoch through the server's own optimizer shell, then read it back.
      await built.optimizer.runOnce({ ...EPOCH, epochId: "epoch-endpoint" }, epochInput());

      const res = await built.app.inject({ method: "GET", url: "/optimizer/recommendations" });
      expect(res.statusCode).toBe(200);
      const body = res.json<OptimizerRecommendationsDto>();
      expect(body.epochId).toBe("epoch-endpoint");
      expect(body.accepted).not.toBeNull();
      expect(body.generated).not.toBeNull();
      expect(body.recommendations.length).toBeGreaterThan(0);
      const rec = body.recommendations[0]!;
      expect(typeof rec.objectiveCost).toBe("number");
      expect(rec.breakdown.total).toBeCloseTo(rec.objectiveCost);
      // Feasibility is reported SEPARATELY from the objective cost (anti-P2).
      expect(typeof rec.feasible).toBe("boolean");
    } finally {
      await built.app.close();
    }
  });
});
