import { describe, expect, it } from "vitest";
import { attachSnapshotSocket } from "../src/ws/snapshots.js";
import type { ApiDb } from "../src/routes/queries.js";
import type { SnapshotPayload, WsEnvelope, InductionEvent } from "../src/ws/envelope.js";
import type { SpeedController } from "../src/sim/speed-controller.js";

/**
 * VIZ-13 (Plan 20-05) — the WS broadcast attaches transient `inductionEvents` to
 * the tick payload, and NEVER to the initial snapshot payload (Pitfall 7).
 *
 * Pure unit test: a fake `FastifyInstance` captures the `/ws` handler; a fake
 * socket records every sent frame. No Postgres, no listening server.
 */

type WsHandler = (socket: FakeSocket) => void;

interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

function makeFakeSocket(): FakeSocket {
  return {
    readyState: 1, // OPEN
    bufferedAmount: 0,
    sent: [],
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      // The snapshot channel calls socket.close() only on an initial-snapshot
      // failure (the .catch path). A real ws/WebSocket has this; the fake must
      // too, or a stray error surfaces as an unhandled "socket.close is not a
      // function" rejection instead of the real cause.
      this.readyState = 3; // CLOSED
    },
    on() {
      /* no-op: we never fire close/error/message in this test */
    },
  };
}

/** A fake FastifyInstance capturing the `/ws` websocket handler. */
function makeFakeApp(): { app: unknown; getHandler: () => WsHandler } {
  let handler: WsHandler | undefined;
  const app = {
    get(_path: string, _opts: unknown, h: WsHandler) {
      handler = h;
    },
    log: { error: () => undefined },
  };
  return {
    app,
    getHandler: () => {
      if (handler === undefined) throw new Error("no /ws handler registered");
      return handler;
    },
  };
}

const EMPTY_SNAPSHOT: SnapshotPayload = {
  trailers: [],
  trailerStops: [],
  hubs: [],
  routes: [],
  exceptionsOpen: [],
};

const FAKE_SPEED: SpeedController = {
  snapshot: () => ({ multiplier: 1, paused: false }),
  noteSimMs: () => undefined,
  // VIZ-RESUME (9318ccc): the initial-snapshot/resync send path anchors the
  // envelope at the live sim clock via `getLastSimMs()`. Before the first tick
  // this is 0 (the legacy "snapshot at sim-start" behaviour). The mock MUST
  // provide it or the .then() throws, the snapshot is never sent, and the
  // Pitfall-7 precondition (`socket.sent.length > 0`) fails.
  getLastSimMs: () => 0,
} as unknown as SpeedController;

const INDUCTION: InductionEvent = {
  packageId: "EXT-P00001",
  inductionHubId: "MEM",
  destHubId: "DFW",
  slaClass: "express",
  slaDeadlineIso: "2026-06-24T12:00:00.000Z",
  occurredAt: "2026-06-24T08:00:00.000Z",
};

async function flush(): Promise<void> {
  // Let the fire-and-forget initial-snapshot promise resolve.
  await Promise.resolve();
  await Promise.resolve();
}

describe("WS induction wiring (VIZ-13)", () => {
  it("attaches inductionEvents to the tick payload when present", async () => {
    const { app, getHandler } = makeFakeApp();
    const broadcast = attachSnapshotSocket(
      app as never,
      undefined as unknown as ApiDb,
      FAKE_SPEED,
      { buildPayload: () => Promise.resolve(EMPTY_SNAPSHOT) },
    );

    const socket = makeFakeSocket();
    getHandler()(socket);
    await flush();

    const env = await broadcast(1_000, [INDUCTION]);
    expect(env.type).toBe("tick");
    if (env.type !== "tick") throw new Error("expected tick");
    expect(env.payload.inductionEvents).toEqual([INDUCTION]);
  });

  it("omits inductionEvents on a tick with no inductions", async () => {
    const { app, getHandler } = makeFakeApp();
    const broadcast = attachSnapshotSocket(
      app as never,
      undefined as unknown as ApiDb,
      FAKE_SPEED,
      { buildPayload: () => Promise.resolve(EMPTY_SNAPSHOT) },
    );

    const socket = makeFakeSocket();
    getHandler()(socket);
    await flush();

    const env = await broadcast(1_000);
    if (env.type !== "tick") throw new Error("expected tick");
    expect(env.payload.inductionEvents).toBeUndefined();
  });

  it("never places inductionEvents on the initial snapshot payload (Pitfall 7)", async () => {
    const { app, getHandler } = makeFakeApp();
    attachSnapshotSocket(
      app as never,
      undefined as unknown as ApiDb,
      FAKE_SPEED,
      { buildPayload: () => Promise.resolve(EMPTY_SNAPSHOT) },
    );

    const socket = makeFakeSocket();
    getHandler()(socket);
    await flush();

    expect(socket.sent.length).toBeGreaterThan(0);
    const snapshotEnv = JSON.parse(socket.sent[0]!) as WsEnvelope;
    expect(snapshotEnv.type).toBe("snapshot");
    expect(
      (snapshotEnv.payload as Record<string, unknown>)["inductionEvents"],
    ).toBeUndefined();
  });
});
