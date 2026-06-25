/**
 * Unit tests for the `RunEpochFn` PORT on `RollingOptimizerService` (Task 5).
 *
 * The service gains an injectable `runEpochFn` (DIP) so the pure epoch compute
 * can run inline (default — byte-for-byte the current behavior) OR be offloaded
 * to a worker thread (Task 6) without changing the shell's memo/append logic.
 *
 * Verifies:
 *  (a) NO runEpochFn ⇒ `runOnce` produces the SAME EpochResult as calling the
 *      pure `runEpoch` directly (the inline default is unchanged);
 *  (b) an injected runEpochFn spy IS invoked and its result drives memo/append:
 *      a result with `accepted:null` ⇒ NO append; a result with an accept ⇒
 *      exactly one append (committed:true).
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OBJECTIVE_WEIGHTS,
  runEpoch,
  type Epoch,
  type EpochInput,
  type EpochResult,
  type TwinSnapshot,
} from "@mm/optimizer";
import type { DomainEvent } from "@mm/domain";
import type { Database } from "@mm/event-store";
import type { Kysely } from "kysely";
import { RollingOptimizerService, type RunEpochFn } from "./rolling-service.js";

const EMPTY_SNAPSHOT: TwinSnapshot = { hubs: [], routes: [], trailers: [] };

/** A snapshot with one feasible trailer (enough for a non-empty scope result). */
const SNAPSHOT: TwinSnapshot = {
  hubs: ["ATL", "CHI"],
  routes: [{ routeId: "r1", fromHubId: "ATL", toHubId: "CHI", travelMin: 30, capacity: 200 }],
  trailers: [
    {
      trailerId: "T001",
      currentHubId: "ATL",
      departureMin: 9999,
      capacity: 50,
      route: [{ hubId: "CHI", stopIndex: 0 }],
      blocks: [{ blockId: "pkg-01", nextUnloadHubId: "CHI", volume: 1 }],
    },
  ],
};

function trailerEvent(trailerId: string): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, tripId: "t", fromHubId: "ATL", toHubId: "CHI", packageIds: [] },
  };
}

/** A db handle whose `transaction` would throw if ever touched (no append wanted). */
function noWriteDb(): Kysely<Database> {
  return {} as Kysely<Database>;
}

/**
 * A minimal chainable fake Kysely for the ACCEPT path: the durable epoch claim
 * (`insertInto(optimizer_idempotency)…returning…executeTakeFirst` ⇒ a fresh row),
 * the prior-staged read (`selectFrom(trailer_state)…executeTakeFirst` ⇒ no row ⇒
 * `[]`), and the COMPLETED status update (`updateTable…execute`). `appendWithRetry`
 * is spied separately, so this only needs to satisfy the claim + staged + finish
 * calls. `claimReturns` controls the fresh-vs-duplicate claim outcome.
 */
function claimableDb(claimReturns: { scope_hash: string } | undefined): Kysely<Database> {
  const chain = {
    values: () => chain,
    onConflict: () => chain,
    returning: () => chain,
    select: () => chain,
    where: () => chain,
    set: () => chain,
    executeTakeFirst: async (): Promise<unknown> =>
      // The insert claim resolves to `claimReturns`; the trailer_state read
      // resolves to undefined (no row ⇒ staged = []). We disambiguate by the
      // presence of `scope_hash` on the canned claim row.
      claimReturns,
    execute: async (): Promise<unknown[]> => [],
  };
  const db = {
    insertInto: () => chain,
    updateTable: () => chain,
    selectFrom: () => ({ ...chain, executeTakeFirst: async () => undefined }),
  };
  return db as unknown as Kysely<Database>;
}

describe("RollingOptimizerService — RunEpochFn port", () => {
  it("(a) inline default == runEpoch: same EpochResult as the pure core", async () => {
    const epoch: Epoch = { epochId: "e1", nowMin: 1, freezeWindowMin: 10 };
    const input: EpochInput = { events: [], twinSnapshot: SNAPSHOT };

    // Pure reference result.
    const ref = runEpoch(epoch, input, DEFAULT_OBJECTIVE_WEIGHTS);

    // Default service (no runEpochFn) — empty events ⇒ empty scope ⇒ no append.
    const service = new RollingOptimizerService({ db: noWriteDb() });
    const { result } = await service.runOnce(epoch, input);

    expect(result).toEqual(ref);
  });

  it("(b) injected runEpochFn is invoked; accepted:null ⇒ NO append (committed:false)", async () => {
    const cannedResult: EpochResult = {
      epochId: "e1",
      scopeHash: "h-canned",
      generated: null,
      accepted: null,
      recommendations: [],
    };
    const runEpochFn = vi.fn<RunEpochFn>().mockResolvedValue(cannedResult);

    const service = new RollingOptimizerService({ db: noWriteDb(), runEpochFn });
    const epoch: Epoch = { epochId: "e1", nowMin: 1, freezeWindowMin: 10 };
    const input: EpochInput = { events: [trailerEvent("T001")], twinSnapshot: SNAPSHOT };

    const { result, committed } = await service.runOnce(epoch, input);

    expect(runEpochFn).toHaveBeenCalledOnce();
    // The injected fn received (epoch, input, weights).
    const [gotEpoch, gotInput, gotWeights] = runEpochFn.mock.calls[0]!;
    expect(gotEpoch).toEqual(epoch);
    expect(gotInput).toEqual(input);
    expect(gotWeights).toEqual(DEFAULT_OBJECTIVE_WEIGHTS);
    // Its result drives the outcome; nothing accepted ⇒ no append.
    expect(result).toEqual(cannedResult);
    expect(committed).toBe(false);
  });

  it("(b') injected runEpochFn with an accept ⇒ exactly ONE append (committed:true)", async () => {
    // A result with both generated + accepted populated ⇒ the shell appends once.
    const accept = {
      planId: "plan-1",
      trailerId: "T001",
      occurredAt: "2026-01-01T00:00:00.000Z",
      epochId: "e1",
      objectiveCost: 1,
      summary: "test accept",
    };
    const generated = { ...accept, feasible: true };
    const acceptedResult: EpochResult = {
      epochId: "e1",
      scopeHash: "h-accept",
      // The payload shapes are plain data; structural typing is enough for the
      // append path (we intercept appendWithRetry below so no real schema runs).
      generated: generated as unknown as EpochResult["generated"],
      accepted: accept as unknown as EpochResult["accepted"],
      recommendations: [],
    };
    const runEpochFn = vi.fn().mockResolvedValue(acceptedResult);

    // Spy the OCC writer so we can count appends without a real DB.
    const eventStore = await import("@mm/event-store");
    const appendSpy = vi
      .spyOn(eventStore, "appendWithRetry")
      .mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof eventStore.appendWithRetry>>);

    // The ACCEPT path now durably claims the epoch (INSERT…ON CONFLICT…RETURNING)
    // before appending; a fresh claim row (`{ scope_hash }`) ⇒ the append fires once.
    const service = new RollingOptimizerService({
      db: claimableDb({ scope_hash: "h-accept" }),
      runEpochFn,
    });
    const epoch: Epoch = { epochId: "e1", nowMin: 1, freezeWindowMin: 10 };
    const input: EpochInput = { events: [trailerEvent("T001")], twinSnapshot: SNAPSHOT };

    const { committed } = await service.runOnce(epoch, input);

    expect(runEpochFn).toHaveBeenCalledOnce();
    expect(committed).toBe(true);
    expect(appendSpy).toHaveBeenCalledOnce();
    appendSpy.mockRestore();
  });

  it("inline default still returns committed=false for an empty scope", async () => {
    const service = new RollingOptimizerService({ db: noWriteDb() });
    const epoch: Epoch = { epochId: "e1", nowMin: 0, freezeWindowMin: 10 };
    const input: EpochInput = { events: [], twinSnapshot: EMPTY_SNAPSHOT };
    const { committed } = await service.runOnce(epoch, input);
    expect(committed).toBe(false);
  });
});
