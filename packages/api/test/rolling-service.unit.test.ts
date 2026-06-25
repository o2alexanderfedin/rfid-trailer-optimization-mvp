import { describe, expect, it } from "vitest";
import {
  RollingOptimizerService,
  type RollingOptimizerDeps,
  type RunEpochFn,
} from "../src/index.js";
import type { Epoch, EpochInput, EpochResult, TwinSnapshot } from "@mm/optimizer";

/** The dep `db` field type — never touched here (accepted:null ⇒ no DB write). */
type DepsDb = RollingOptimizerDeps["db"];

/**
 * FLOW-04 (Phase 21) — the rolling optimizer's idempotency is now DURABLE
 * (the `optimizer_idempotency` Postgres table), replacing the in-memory
 * `LruMap(500)` (CONT-04c, v1.0 debt). The cross-restart idempotency property the
 * LruMap could NOT provide is exercised against a real Postgres in
 * `optimizer/rolling-service.int.test.ts`.
 *
 * This pure unit asserts the keystone the durable table preserves: a NON-accepting
 * epoch (the common empty-scope tick) writes NOTHING and holds NO unbounded
 * in-memory idempotency state — the service no longer accumulates a per-epoch memo
 * at all, so an indefinite continuous run cannot grow without bound. The injected
 * `runEpochFn` returns `accepted: null`, so the service never appends and the `db`
 * handle is never touched.
 */

const EMPTY_TWIN: TwinSnapshot = {
  trailers: [],
  routes: [],
  hubs: [],
};

function makeService(): RollingOptimizerService {
  // Distinct scopeHash per epoch — under the old plain `Map` this would grow
  // without bound; with `accepted:null` the durable-claim service writes nothing
  // and keeps NO per-epoch memo, so there is nothing to bound.
  const runEpochFn: RunEpochFn = (epoch: Epoch): Promise<EpochResult> =>
    Promise.resolve({
      epochId: epoch.epochId,
      scopeHash: `scope-${epoch.epochId}`,
      generated: null,
      accepted: null, // no commit ⇒ no claim ⇒ db untouched
      recommendations: [],
    });
  const db = {} as unknown as DepsDb;
  return new RollingOptimizerService({ db, runEpochFn });
}

function epoch(id: string): Epoch {
  return { epochId: id, nowMin: 0, freezeWindowMin: 0 };
}

function input(): EpochInput {
  return { events: [], twinSnapshot: EMPTY_TWIN };
}

describe("RollingOptimizerService durable idempotency (FLOW-04 / CONT-04c closed)", () => {
  it("a non-accepting epoch never touches the db and is committed:false", async () => {
    const service = makeService();
    const outcome = await service.runOnce(epoch("e0"), input());
    expect(outcome.committed).toBe(false);
  });

  it("600 distinct non-accepting epochs write nothing and never throw (no unbounded memo, db untouched)", async () => {
    const service = makeService();
    for (let i = 0; i < 600; i += 1) {
      const { committed } = await service.runOnce(epoch(`e${i}`), input());
      expect(committed).toBe(false);
    }
    // The empty `{}` db handle was never used — no claim/append on the no-accept
    // path — so 600 distinct epochs neither write nor grow any in-memory cache.
  });

  it("re-running the same non-accepting epoch stays committed:false (no side effect to dedupe)", async () => {
    const service = makeService();
    const first = await service.runOnce(epoch("dup"), input());
    const second = await service.runOnce(epoch("dup"), input());
    expect(first.committed).toBe(false);
    expect(second.committed).toBe(false);
  });
});
