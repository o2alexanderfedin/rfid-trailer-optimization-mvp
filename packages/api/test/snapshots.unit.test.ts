import { beforeAll, describe, expect, it } from "vitest";

/**
 * CONT-04b — WS backpressure guard unit tests.
 *
 * Wave 0 stub: RED until plan-05 adds the `BACKPRESSURE_BYTES` constant + a pure
 * `shouldSendToSocket(socket)` predicate to `../src/ws/snapshots.ts` (the guard
 * extracted as a testable pure function used by `sendRawIfOpen`).
 *
 * The guard skips a tick delta ONLY when the socket's `bufferedAmount` exceeds
 * the threshold (a backgrounded/saturated client) — never for the initial
 * snapshot (where `bufferedAmount` is 0 on a fresh connect, so the guard is a
 * no-op there; Pitfall 4).
 *
 * Loaded via dynamic import so the file compiles before plan-05 exports exist.
 */
const WS_OPEN = 1;

interface MockSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
}

let shouldSendToSocket: (socket: MockSocket) => boolean;
let BACKPRESSURE_BYTES: number;

beforeAll(async () => {
  const mod = (await import("../src/ws/snapshots.js")) as {
    shouldSendToSocket?: (socket: MockSocket) => boolean;
    BACKPRESSURE_BYTES?: number;
  };
  if (mod.shouldSendToSocket === undefined || mod.BACKPRESSURE_BYTES === undefined) {
    throw new Error(
      "snapshots.ts must export shouldSendToSocket + BACKPRESSURE_BYTES (plan-05)",
    );
  }
  shouldSendToSocket = mod.shouldSendToSocket;
  BACKPRESSURE_BYTES = mod.BACKPRESSURE_BYTES;
});

describe("WS backpressure guard (CONT-04b)", () => {
  it("BACKPRESSURE_BYTES is 256 KB", () => {
    expect(BACKPRESSURE_BYTES).toBe(256 * 1024);
  });

  it("skips send when bufferedAmount exceeds the threshold (saturated client)", () => {
    const socket: MockSocket = { readyState: WS_OPEN, bufferedAmount: 300 * 1024 };
    expect(shouldSendToSocket(socket)).toBe(false);
  });

  it("sends when bufferedAmount is at or below the threshold", () => {
    const atZero: MockSocket = { readyState: WS_OPEN, bufferedAmount: 0 };
    const atThreshold: MockSocket = { readyState: WS_OPEN, bufferedAmount: BACKPRESSURE_BYTES };
    expect(shouldSendToSocket(atZero)).toBe(true);
    expect(shouldSendToSocket(atThreshold)).toBe(true);
  });

  it("never sends to a non-open socket regardless of buffer", () => {
    const closed: MockSocket = { readyState: 3, bufferedAmount: 0 };
    expect(shouldSendToSocket(closed)).toBe(false);
  });

  it("initial-connect buffer (0 bytes) is not skipped (Pitfall 4)", () => {
    const freshConnect: MockSocket = { readyState: WS_OPEN, bufferedAmount: 0 };
    expect(shouldSendToSocket(freshConnect)).toBe(true);
  });
});
