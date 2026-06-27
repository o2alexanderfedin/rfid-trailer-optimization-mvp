import { describe, expect, it } from "vitest";
import { AsyncQueue } from "@alexanderfedin/async-queue";

/**
 * PERF-03 / T-27-03 — append-order == generation-order FIFO guarantee.
 *
 * The async-queue is runtime plumbing (banned from the deterministic core by
 * DET-03 ESLint guard). Before any seam wires it, we must prove it NEVER
 * reorders the event stream — even when backpressure engages repeatedly.
 *
 * Contract (CONTEXT Area 2 "Order guarantee"):
 *   - A circular-buffer FIFO enqueues items in producer order.
 *   - With maxSize K < N, the producer blocks on backpressure for every K-th
 *     item — the buffer wraps around many times. Dequeue order must still
 *     equal enqueue order exactly (FIFO; never reordered).
 *   - After close() + drain, dequeue() returns undefined (clean shutdown).
 *
 * This test lives in @mm/api (NOT in @mm/simulation — the core is banned
 * from importing async-queue, so the test must live outside it).
 */

describe("AsyncQueue — append-order == generation-order (PERF-03)", () => {
  it("dequeues in enqueue order across the backpressure boundary (N >> maxSize)", async () => {
    // K is the bounded buffer size; N >> K so backpressure fires many times.
    const K = 4;
    const N = 1000;

    const queue = new AsyncQueue<{ seq: number }>(K);
    const received: number[] = [];

    // Consumer: drain until close + empty (dequeue returns undefined).
    const consumer = (async () => {
      while (true) {
        const item = await queue.dequeue();
        if (item === undefined) break; // closed + drained
        received.push(item.seq);
      }
    })();

    // Producer: enqueue N monotonically-tagged items; close when done.
    const producer = (async () => {
      for (let i = 0; i < N; i++) {
        await queue.enqueue({ seq: i });
      }
      queue.close();
    })();

    await Promise.all([producer, consumer]);

    // FIFO: dequeue order must equal enqueue order exactly.
    const expected = Array.from({ length: N }, (_, i) => i);
    expect(received).toEqual(expected);
    expect(received).toHaveLength(N);
  });

  it("post-close dequeue returns undefined (clean shutdown)", async () => {
    const queue = new AsyncQueue<{ seq: number }>(4);

    // Enqueue a single item, close, drain it, then confirm undefined.
    await queue.enqueue({ seq: 0 });
    queue.close();

    const item0 = await queue.dequeue();
    expect(item0).toEqual({ seq: 0 });

    // Queue is now closed + empty — dequeue must return undefined.
    const sentinel = await queue.dequeue();
    expect(sentinel).toBeUndefined();
  });

  it("FIFO ordering holds with a very small buffer (maxSize=1)", async () => {
    // maxSize=1 maximizes backpressure: every enqueue blocks until the consumer
    // drains the single slot. FIFO must still be exact.
    const N = 50;
    const queue = new AsyncQueue<{ seq: number }>(1);
    const received: number[] = [];

    const consumer = (async () => {
      while (true) {
        const item = await queue.dequeue();
        if (item === undefined) break;
        received.push(item.seq);
      }
    })();

    const producer = (async () => {
      for (let i = 0; i < N; i++) {
        await queue.enqueue({ seq: i });
      }
      queue.close();
    })();

    await Promise.all([producer, consumer]);

    const expected = Array.from({ length: N }, (_, i) => i);
    expect(received).toEqual(expected);
  });
});
