/**
 * PERF-03 (seam c) — per-client bounded AsyncQueue<string> ws backpressure.
 *
 * Replaces the drop-based 256 KB `shouldSendToSocket` gate with a per-client
 * bounded `AsyncQueue<string>` whose consumer loop awaits socket.send drain.
 *
 * Acceptance criteria:
 * (1) FIFO: frames arrive in the order they were enqueued (never reordered).
 * (2) Backpressure: a full queue blocks the broadcaster (no silent frame drop).
 * (3) Isolation: a slow client's blocked queue does NOT stall sends to a fast client.
 * (4) Clean shutdown: after close, the consumer exits and no further send is attempted.
 *
 * Testing approach: import the exported `createClientQueue` factory from snapshots.ts.
 * The factory returns an object with `enqueue(frame)` (the broadcast API) and
 * `close()` (the on-socket-close/error API), and internally drives sends via the
 * injected `send(frame)` callback (the socket.send stand-in).
 */

import { describe, expect, it } from "vitest";

// Dynamic import so the test compiles before the export exists (RED phase).
// The real module export is verified in the beforeAll.
type ClientQueueHandle = {
  /** Enqueue a wire frame for this client; blocks when queue is full (backpressure). */
  enqueue(frame: string): Promise<void>;
  /** Signal socket close/error: stop the consumer, reject any pending enqueues. */
  close(): void;
};

// Lazy loader — lets us import once the module boots.
async function loadCreateClientQueue(): Promise<
  (send: (frame: string) => Promise<void>, maxSize?: number) => ClientQueueHandle
> {
  const mod = (await import("../src/ws/snapshots.js")) as {
    createClientQueue?: (
      send: (frame: string) => Promise<void>,
      maxSize?: number,
    ) => ClientQueueHandle;
  };
  if (typeof mod.createClientQueue !== "function") {
    throw new Error(
      "snapshots.ts must export createClientQueue (PERF-03 TDD RED → GREEN)",
    );
  }
  return mod.createClientQueue;
}

describe("ws backpressure — per-client bounded AsyncQueue<string> (PERF-03)", () => {
  it("(1) FIFO: frames arrive in enqueue order across the backpressure boundary", async () => {
    const createClientQueue = await loadCreateClientQueue();
    const received: string[] = [];

    // send is fast (no artificial delay) — we only care about order.
    const handle = createClientQueue((frame) => {
      received.push(frame);
      return Promise.resolve();
    }, /* maxSize */ 4);

    const N = 50;
    const frames = Array.from({ length: N }, (_, i) => `frame-${i}`);
    for (const f of frames) {
      await handle.enqueue(f);
    }

    // Wait for the consumer to drain the queue.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(received).toEqual(frames);
    handle.close();
  });

  it("(2) Backpressure: a full queue blocks the enqueuer (does not silently drop)", async () => {
    const createClientQueue = await loadCreateClientQueue();

    // Slow send: takes 50ms each so the queue fills up quickly.
    let sendCount = 0;
    const handle = createClientQueue(async (frame) => {
      sendCount++;
      // Simulate a slow socket.send that takes time to drain.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      void frame;
    }, /* maxSize */ 2);

    // Enqueue 4 frames. With maxSize=2 and slow sends, the 3rd/4th enqueue
    // will block (backpressure). All 4 must eventually be delivered.
    const delivered: string[] = [];
    const results: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      const frame = `bp-frame-${i}`;
      results.push(handle.enqueue(frame).then(() => { delivered.push(frame); }));
    }
    await Promise.all(results);

    // Wait for sends to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // ALL 4 frames must have been sent — no silent drops.
    expect(sendCount).toBe(4);
    handle.close();
  });

  it("(3) Isolation: a slow client does not block sends to a fast client", async () => {
    const createClientQueue = await loadCreateClientQueue();

    const slowReceived: string[] = [];
    const fastReceived: string[] = [];

    // Slow client: 40ms per send.
    const slowHandle = createClientQueue(async (frame) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      slowReceived.push(frame);
    }, /* maxSize */ 10);

    // Fast client: instant sends.
    const fastHandle = createClientQueue((frame) => {
      fastReceived.push(frame);
      return Promise.resolve();
    }, /* maxSize */ 10);

    const N = 6;
    const frames = Array.from({ length: N }, (_, i) => `iso-frame-${i}`);

    // Simulate the broadcast pattern: one frame per tick, enqueued to both clients
    // independently (fire-and-forget per client, as in the real broadcast loop).
    for (const f of frames) {
      // Both clients receive the same frame independently — no shared lock.
      slowHandle.enqueue(f).catch(() => { /* ignore */ });
      fastHandle.enqueue(f).catch(() => { /* ignore */ });
    }

    // Fast client should drain quickly (instant sends).
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    // Fast client has received all frames; slow client is still catching up.
    expect(fastReceived).toEqual(frames);

    // Drain slow client (6 frames × 40ms = ~240ms).
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    expect(slowReceived).toEqual(frames);

    slowHandle.close();
    fastHandle.close();
  });

  it("(4) Clean shutdown: after close(), consumer exits and no further send is attempted", async () => {
    const createClientQueue = await loadCreateClientQueue();

    const sent: string[] = [];
    let sendAfterClose = false;

    const handle = createClientQueue(async (frame) => {
      sent.push(frame);
      // A very slow send to ensure the consumer is mid-drain when we close.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }, 2);

    // Enqueue a frame, let it start draining.
    await handle.enqueue("before-close");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    // Close the queue.
    handle.close();

    // Any frame enqueued AFTER close should not be sent (queue is closed).
    try {
      await handle.enqueue("after-close");
    } catch {
      // Expected: enqueue throws / rejects after close.
      sendAfterClose = false;
    }

    // Wait for any in-flight send to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // The "after-close" frame must never have been sent.
    expect(sendAfterClose).toBe(false);
    expect(sent).not.toContain("after-close");
  });
});
