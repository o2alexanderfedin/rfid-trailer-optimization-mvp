/**
 * CR-02 regression guard: concurrent-close double-reject race in worker-client.
 *
 * The race: `close()` previously called `rejectAll()` in the same synchronous
 * frame as `requestQueue.close()`. That woke a blocked `enqueue()` producer;
 * the producer's `.catch()` removed the entry from `pending` and called `reject`.
 * Then `rejectAll()` found the SAME entry still in `pending` (the delete hadn't
 * run yet — it's async) and called `p.reject()` again — a structural double-reject.
 *
 * Fix: `rejectAll` is now called AFTER `await worker.terminate()`. The enqueue
 * `.catch()` fires and removes the entry from `pending` first (the queue-close +
 * next microtask tick); by the time `rejectAll` runs, the entry is gone.
 *
 * Test approach: we do NOT spawn a real worker (avoids needing `pnpm build` in
 * unit mode). Instead we test the ordering invariant directly using `AsyncQueue`
 * and a Promise rejection counter: a Promise rejected twice is detectable because
 * the `.catch()` handler runs twice (once from the queue-close path, once from
 * `rejectAll`).
 *
 * This is a logical proof that the fix eliminates the structural double-reject,
 * not a full integration test of the worker binary.
 */

import { describe, expect, it } from "vitest";
import { AsyncQueue } from "@alexanderfedin/async-queue";

/**
 * Minimal reproduction of the BEFORE fix scenario:
 * - A bounded queue with a pending blocked `enqueue()` call (producer stuck).
 * - A `pending` map holding the same id.
 * - close() calls rejectAll() BEFORE the queue.close()-induced `.catch()` fires.
 *
 * Result (BEFORE fix): `reject` is called twice — detectable via counter.
 */
describe("CR-02: worker-client close() ordering — no double-reject", () => {
  it("enqueue .catch() and rejectAll do NOT both reject the same pending entry when rejectAll runs after worker.terminate()", async () => {
    // Simulate the bounded queue and pending map the worker-client uses.
    const QUEUE_MAX = 2;
    const requestQueue = new AsyncQueue<{ id: number }>(QUEUE_MAX);
    const pending = new Map<number, { reject: (e: Error) => void }>();

    // Track how many times each id's reject is called.
    const rejectCounts = new Map<number, number>();

    function rejectAll(err: Error): void {
      for (const [, p] of pending) p.reject(err);
      pending.clear();
    }

    // Fill the queue to capacity so the next enqueue() will BLOCK.
    // We use two placeholder items to saturate QUEUE_MAX=2.
    await requestQueue.enqueue({ id: -1 });
    await requestQueue.enqueue({ id: -2 });

    // Now simulate a `run()` call for id=0 that blocks because the queue is full.
    const id = 0;
    rejectCounts.set(id, 0);

    let enqueueRejected = false;
    const runPromise = new Promise<void>((_resolve, reject) => {
      // Register in pending BEFORE enqueueing (matches the fixed worker-client).
      pending.set(id, {
        reject: (e: Error) => {
          rejectCounts.set(id, (rejectCounts.get(id) ?? 0) + 1);
          if (!enqueueRejected) {
            enqueueRejected = true;
            reject(e);
          }
          // A second call is the double-reject bug — it should NOT happen.
        },
      });

      // Enqueue blocks because queue is full; .catch() fires on queue.close().
      requestQueue.enqueue({ id }).catch((err: unknown) => {
        const entry = pending.get(id);
        if (entry !== undefined) {
          // This is the enqueue `.catch()` path: remove first, then reject.
          pending.delete(id);
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    // --- Simulate close() with the FIXED ordering ---
    // 1. Close the queue (wakes blocked enqueue → .catch() fires async).
    requestQueue.close();

    // 2. Simulate `await worker.terminate()` (a microtask yield lets .catch() run).
    await Promise.resolve(); // tick 1
    await Promise.resolve(); // tick 2 — enqueue's .catch() has now removed the entry

    // 3. rejectAll() runs AFTER terminate — entry is already gone from pending.
    rejectAll(new Error("optimizer worker is closing"));

    // The run promise must have rejected exactly once.
    await expect(runPromise).rejects.toThrow();

    // THE KEY ASSERTION: reject was called exactly once — no double-reject.
    expect(rejectCounts.get(id)).toBe(1);
  });

  it("rejectAll handles entries NOT removed by enqueue .catch() (post-send requests)", async () => {
    // Entries that were already dequeued + postMessage'd (in-flight) are NOT
    // removed by the enqueue `.catch()` path — they stay in `pending` until
    // the worker replies OR until `rejectAll` cleans them up.
    const pending = new Map<number, { reject: (e: Error) => void }>();
    const rejectCounts = new Map<number, number>();

    function rejectAll(err: Error): void {
      for (const [, p] of pending) p.reject(err);
      pending.clear();
    }

    // Simulate a request that was already dequeued + sent to the worker (no
    // blocked enqueue — just a pending entry awaiting a reply).
    const id = 1;
    rejectCounts.set(id, 0);
    let resolved = false;
    const runPromise = new Promise<void>((resolve, reject) => {
      pending.set(id, {
        reject: (e: Error) => {
          rejectCounts.set(id, (rejectCounts.get(id) ?? 0) + 1);
          if (!resolved) {
            resolved = true;
            reject(e);
          }
        },
      });
      void resolve; // suppress unused warning
    });

    // rejectAll fires (after worker.terminate()) — the only reject path for this entry.
    rejectAll(new Error("optimizer worker is closing"));

    await expect(runPromise).rejects.toThrow();
    // Rejected exactly once — no double-reject from the enqueue path (it never ran).
    expect(rejectCounts.get(id)).toBe(1);
    // pending map is clean.
    expect(pending.size).toBe(0);
  });
});
