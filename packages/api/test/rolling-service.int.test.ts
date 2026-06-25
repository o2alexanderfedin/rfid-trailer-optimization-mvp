import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readStream } from "@mm/event-store";
import type { Epoch, EpochInput, EpochResult, TwinSnapshot } from "@mm/optimizer";
import type { DomainEvent } from "@mm/domain";
import {
  RollingOptimizerService,
  type RunEpochFn,
} from "../src/optimizer/rolling-service.js";
import { eventStoreView, startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * FLOW-04 (Phase 21) — the DURABLE `optimizer_idempotency` claim, against a REAL
 * Postgres (Testcontainers), replacing the in-memory memo (CONT-04c, v1.0 debt).
 *
 * BOUNDED (GATE-HYGIENE): ONE accepting epoch + ONE simulated restart — no loop
 * over many epochs. Proves the property the in-memory memo could NOT: a
 * `(horizon_start, horizon_end, scope_hash)` epoch claimed once is NOT re-claimed
 * after a process restart (a fresh service over the SAME db), so the plan is
 * never double-committed. Also asserts the `PlanSuperseded` co-commit carries the
 * prior plan's exact staged package set (the set the hub-inventory delete-then-
 * apply reducer wipes), and that scopeHash is stable across the restart.
 */

const STREAM = "optimizer-T001";

/** A single in-scope trailer event so `detectAffectedScope` yields a real horizon. */
function trailerEvent(): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId: "T001", tripId: "trip-1", fromHubId: "ATL", toHubId: "CHI", packageIds: [] },
  };
}

const SNAPSHOT: TwinSnapshot = { hubs: ["ATL", "CHI"], routes: [], trailers: [] };

const EPOCH: Epoch = { epochId: "e1", nowMin: 100, freezeWindowMin: 15 };
const INPUT: EpochInput = { events: [trailerEvent()], twinSnapshot: SNAPSHOT };

/**
 * A canned accept for trailer T001 with a FIXED scopeHash, so the test controls
 * the idempotency key deterministically (no dependency on the full optimizer).
 */
function acceptingFn(scopeHash: string, planId: string): RunEpochFn {
  const accepted = {
    epochId: EPOCH.epochId,
    scopeHash,
    planId,
    trailerId: "T001",
    occurredAt: "2026-06-24T08:00:00.000Z",
  };
  const generated = {
    epochId: EPOCH.epochId,
    scopeHash,
    planId,
    trailerId: "T001",
    feasible: true,
    objectiveCost: 1,
    occurredAt: "2026-06-24T08:00:00.000Z",
  };
  const result: EpochResult = {
    epochId: EPOCH.epochId,
    scopeHash,
    generated: generated,
    accepted: accepted,
    recommendations: [],
  };
  return () => Promise.resolve(result);
}

describe("RollingOptimizerService durable optimizer_idempotency (FLOW-04, bounded)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  beforeEach(async () => {
    // Reset the durable + plan state between cases (bounded, deterministic).
    await fx.db.deleteFrom("optimizer_idempotency").execute();
    await fx.db.deleteFrom("events").execute();
    await fx.db.deleteFrom("streams").execute();
    await fx.db.deleteFrom("trailer_state").execute();
  });

  it("claims an epoch once (PROCESSING→COMPLETED) and appends the plan", async () => {
    const db = eventStoreView(fx.db);
    const service = new RollingOptimizerService({
      db,
      runEpochFn: acceptingFn("hash-A", "plan-1"),
    });

    const { committed } = await service.runOnce(EPOCH, INPUT);
    expect(committed).toBe(true);

    // The claim row exists and is COMPLETED.
    const row = await fx.db
      .selectFrom("optimizer_idempotency")
      .selectAll()
      .where("scope_hash", "=", "hash-A")
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("COMPLETED");
    expect(row.plan_id).toBe("plan-1");
    expect(row.completed_at).not.toBeNull();

    // The first plan for a trailer has NO prior ⇒ only PlanGenerated + PlanAccepted.
    const events = await readStream(db, STREAM);
    expect(events.map((e) => e.event.type)).toEqual(["PlanGenerated", "PlanAccepted"]);
  });

  it("a duplicate claim for the same (horizon, scope_hash) returns 0 rows ⇒ no re-append (committed:false)", async () => {
    const db = eventStoreView(fx.db);
    const service = new RollingOptimizerService({
      db,
      runEpochFn: acceptingFn("hash-A", "plan-1"),
    });

    const first = await service.runOnce(EPOCH, INPUT);
    expect(first.committed).toBe(true);

    // Same epoch + same scopeHash ⇒ the durable row already exists ⇒ skip.
    const second = await service.runOnce(EPOCH, INPUT);
    expect(second.committed).toBe(false);

    // Still exactly ONE plan append on the stream (no double-commit).
    const events = await readStream(db, STREAM);
    expect(events.filter((e) => e.event.type === "PlanAccepted")).toHaveLength(1);
  });

  it("survives a simulated restart: a NEW service over the SAME db does NOT re-claim or re-append", async () => {
    const db = eventStoreView(fx.db);
    const serviceA = new RollingOptimizerService({
      db,
      runEpochFn: acceptingFn("hash-A", "plan-1"),
    });
    const a = await serviceA.runOnce(EPOCH, INPUT);
    expect(a.committed).toBe(true);

    // Simulate a process restart: the in-memory state is gone, but the durable row
    // persists in Postgres. A fresh service over the SAME db must NOT re-commit.
    const serviceB = new RollingOptimizerService({
      db,
      runEpochFn: acceptingFn("hash-A", "plan-1"),
    });
    const b = await serviceB.runOnce(EPOCH, INPUT);
    expect(b.committed).toBe(false);

    // scopeHash is stable across the restart (same logical epoch ⇒ same key) — the
    // claim row is unique on (horizon_start, horizon_end, scope_hash).
    const rows = await fx.db
      .selectFrom("optimizer_idempotency")
      .selectAll()
      .where("scope_hash", "=", "hash-A")
      .execute();
    expect(rows).toHaveLength(1);

    // Still exactly ONE PlanAccepted on the stream after the restart.
    const events = await readStream(db, STREAM);
    expect(events.filter((e) => e.event.type === "PlanAccepted")).toHaveLength(1);
  });

  it("co-commits PlanSuperseded carrying the prior plan's exact staged set on a second accept", async () => {
    const db = eventStoreView(fx.db);

    // Two sequential accepts on ONE service instance over the SAME trailer stream,
    // with DISTINCT scopes (call index drives scopeHash) so BOTH claim. Call 1 has
    // no prior ⇒ no PlanSuperseded and records the trailer's staged set; call 2
    // supersedes plan-1 carrying its EXACT prior staged set (the set 21-03 wipes).
    let call = 0;
    const twoScopeFn: RunEpochFn = () => {
      call += 1;
      const scopeHash = call === 1 ? "hash-A" : "hash-B";
      const planId = call === 1 ? "plan-1" : "plan-2";
      const accepted = {
        epochId: EPOCH.epochId,
        scopeHash,
        planId,
        trailerId: "T001",
        occurredAt: "2026-06-24T08:00:00.000Z",
      };
      return Promise.resolve<EpochResult>({
        epochId: EPOCH.epochId,
        scopeHash,
        generated: { ...accepted, feasible: true, objectiveCost: 1 },
        accepted: accepted,
        recommendations: [],
      });
    };

    // The first plan stages exactly [P1, P2] for T001 (its assigned_package_ids).
    await fx.db
      .insertInto("trailer_state")
      .values({
        trailer_id: "T001",
        status: "in_transit",
        current_hub_id: "ATL",
        assigned_package_ids: JSON.stringify(["P1", "P2"]),
        last_event_at: "2026-06-24T08:00:00.000Z",
      })
      .execute();

    const service = new RollingOptimizerService({ db, runEpochFn: twoScopeFn });

    // Call 1 (scope A): stages [P1,P2], recorded as the prior; NO PlanSuperseded.
    await service.runOnce(EPOCH, INPUT);

    // The trailer re-stages a different set for the NEXT plan.
    await fx.db
      .updateTable("trailer_state")
      .set({ assigned_package_ids: JSON.stringify(["P3"]) })
      .where("trailer_id", "=", "T001")
      .execute();

    // Call 2 (scope B): supersedes plan-1, co-committing PlanSuperseded([P1,P2]).
    await service.runOnce(EPOCH, INPUT);

    const events = await readStream(db, STREAM);
    // The stream now holds: [Generated, Accepted] (plan-1) then
    // [Generated, Accepted, Superseded] (plan-2) — supersession is co-committed.
    const superseded = events.find((e) => e.event.type === "PlanSuperseded");
    expect(superseded).toBeDefined();
    const payload = superseded!.event.payload as {
      supersededPackageIds: string[];
      priorPlanId: string;
    };
    expect([...payload.supersededPackageIds].sort()).toEqual(["P1", "P2"]);
    expect(payload.priorPlanId).toBe("plan-1");
    // Exactly TWO PlanAccepted (one per plan), ONE PlanSuperseded (the second only).
    expect(events.filter((e) => e.event.type === "PlanAccepted")).toHaveLength(2);
    expect(events.filter((e) => e.event.type === "PlanSuperseded")).toHaveLength(1);
  });
});
