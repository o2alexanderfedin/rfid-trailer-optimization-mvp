/**
 * Unit tests for the `optimizerExecution` seam on `buildServer` (Task 7).
 *
 * Default (`inline`) ⇒ NO worker is spawned (every existing test/integration
 * runs the inline path unchanged). `worker` ⇒ `BuiltServer` carries a closable
 * `WorkerOptimizer` that the shutdown path can terminate.
 *
 * Hermetic: ws is disabled and the DB handle is a fake — `buildServer` does no
 * DB I/O at construction (routes only call the DB on request), so no Postgres is
 * needed to exercise the composition seam.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ApiDb } from "./routes/queries.js";
import { buildServer } from "./server.js";
import type { BuiltServer } from "./server.js";

/** A fake ApiDb covering only the no-op fluent surface buildServer touches. */
function fakeDb(): ApiDb {
  const builder = {
    select: () => builder,
    selectAll: () => builder,
    where: () => builder,
    orderBy: () => builder,
    execute: () => Promise.resolve([]),
    executeTakeFirst: () => Promise.resolve(undefined),
  };
  return {
    selectFrom: () => builder,
    transaction: () => ({
      execute: (fn: (trx: unknown) => Promise<unknown>) => fn({}),
    }),
  } as unknown as ApiDb;
}

describe("buildServer — optimizerExecution seam", () => {
  let built: BuiltServer | undefined;

  afterEach(async () => {
    await built?.worker?.close();
    await built?.app.close();
    built = undefined;
  });

  it("defaults to inline: no worker on the BuiltServer", async () => {
    built = await buildServer({ db: fakeDb(), enableWs: false });
    expect(built.worker).toBeUndefined();
  });

  it("optimizerExecution:'inline' explicitly ⇒ no worker", async () => {
    built = await buildServer({ db: fakeDb(), enableWs: false, optimizerExecution: "inline" });
    expect(built.worker).toBeUndefined();
  });

  it("optimizerExecution:'worker' ⇒ BuiltServer carries a closable worker", async () => {
    built = await buildServer({ db: fakeDb(), enableWs: false, optimizerExecution: "worker" });
    expect(built.worker).toBeDefined();
    expect(typeof built.worker?.run).toBe("function");
    expect(typeof built.worker?.close).toBe("function");
  });
});
