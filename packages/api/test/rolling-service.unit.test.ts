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
 * CONT-04c — the rolling optimizer's idempotency memo stays bounded over an
 * indefinite (continuous-operation) run.
 *
 * With distinct `(epochId, scopeHash)` keys for every run, the in-memory memo
 * would grow without bound under the old plain `Map`. Backed by `LruMap(500)` it
 * must cap at exactly 500 entries no matter how many epochs run.
 *
 * Pure unit (no Postgres): the injected `runEpochFn` returns a minimal result
 * with `accepted: null`, so the service never appends to the event store — the
 * `db` handle is never touched.
 */

const EMPTY_TWIN: TwinSnapshot = {
  trailers: [],
  routes: [],
  hubs: [],
};

function makeService(): RollingOptimizerService {
  // Distinct scopeHash per epoch so each runOnce creates a NEW memo entry.
  const runEpochFn: RunEpochFn = (epoch: Epoch): Promise<EpochResult> =>
    Promise.resolve({
      epochId: epoch.epochId,
      scopeHash: `scope-${epoch.epochId}`,
      generated: null,
      accepted: null, // no commit ⇒ no DB write ⇒ db untouched
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

describe("RollingOptimizerService memo LRU cap (CONT-04c)", () => {
  it("memo stays bounded at 500 entries after 600 distinct runOnce calls", async () => {
    const service = makeService();
    for (let i = 0; i < 600; i += 1) {
      await service.runOnce(epoch(`e${i}`), input());
    }
    expect(service.memoSize()).toBe(500);
  });

  it("re-running an already-memoized epoch does not grow the memo", async () => {
    const service = makeService();
    await service.runOnce(epoch("dup"), input());
    const sizeAfterFirst = service.memoSize();
    // Same epochId ⇒ same memo key ⇒ memoized hit, no growth.
    const outcome = await service.runOnce(epoch("dup"), input());
    expect(outcome.committed).toBe(false);
    expect(service.memoSize()).toBe(sizeAfterFirst);
  });
});
