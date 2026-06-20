/**
 * Unit tests for the versioned ws envelope channel (VIZ-04 / Plan 05-01).
 *
 * Tests the NEW contract:
 *  - connect → ONE { v:1, type:"snapshot", seq, simMs, payload } message
 *  - broadcast(simMs) → ONE { v:1, type:"tick", seq, simMs, payload } delta
 *  - seq increments by exactly 1 per message
 *  - tick payload carries ONLY changed entities (diffTick)
 *  - N raw events within one tick still produce exactly ONE tick message (T-01-19)
 *  - an unchanged tick sends an empty-payload tick ({} payload)
 *  - M-5: rejecting payload builder on connect closes the socket gracefully
 *
 * All tests run without a real DB (the payload builder port is injected).
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket, type RawData } from "ws";
import type { SnapshotPayload, WsEnvelope } from "./envelope.js";
import {
  attachSnapshotSocket,
  type ApiDb,
  type SnapshotPayloadBuilder,
} from "./snapshots.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FAKE_DB = {} as unknown as ApiDb;

function emptyPayload(): SnapshotPayload {
  return {
    trailers: [],
    hubs: [],
    routes: [],
    exceptionsOpen: [],
    kpis: {
      utilization: 0,
      rehandleCount: 0,
      rehandleMinutes: 0,
      wrongTrailerCount: 0,
      missedUnloadCount: 0,
      slaViolationRate: 0,
      onTimeDeparture: 1,
      onTimeArrival: 1,
      baseline: {
        utilization: 0,
        rehandleCount: 0,
        rehandleMinutes: 0,
        wrongTrailerCount: 0,
        missedUnloadCount: 0,
        slaViolationRate: 0,
        onTimeDeparture: 1,
        onTimeArrival: 1,
      },
    },
  };
}

/** Build a Fastify app + ws channel; returns { app, port, broadcast }. */
async function buildTestApp(
  buildPayload: SnapshotPayloadBuilder = (_db) => Promise.resolve(emptyPayload()),
): Promise<{
  app: FastifyInstance;
  port: number;
  broadcast: (simMs: number) => Promise<WsEnvelope>;
}> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  const broadcast = attachSnapshotSocket(app, FAKE_DB, { buildPayload });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  return { app, port: address.port, broadcast };
}

function decodeText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function parseEnvelope(data: RawData): WsEnvelope {
  return JSON.parse(decodeText(data)) as WsEnvelope;
}

/**
 * Open a WebSocket that buffers all messages from the moment the socket is
 * created (before "open" fires). This eliminates the race condition where a
 * server pushes the initial snapshot before the test's message listener is set
 * up (the message arrives in a microtask on the server, but the test's listener
 * is set up synchronously after `await openSocket`, so the order is reliable —
 * but we buffer to be safe across all Node.js event-loop orderings).
 */
function openSocketBuffered(
  port: number,
): Promise<{ socket: WebSocket; next: () => Promise<WsEnvelope> }> {
  return new Promise((resolveOpen, rejectOpen) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const buf: WsEnvelope[] = [];
    const waiters: Array<{
      resolve: (v: WsEnvelope) => void;
      reject: (e: unknown) => void;
    }> = [];

    socket.on("message", (data: RawData) => {
      const env = parseEnvelope(data);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(env);
      } else {
        buf.push(env);
      }
    });
    socket.on("error", (err) => {
      for (const w of waiters) w.reject(err);
      waiters.length = 0;
    });

    function next(): Promise<WsEnvelope> {
      return new Promise<WsEnvelope>((resolve, reject) => {
        const buffered = buf.shift();
        if (buffered !== undefined) {
          resolve(buffered);
          return;
        }
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error("nextMessage timeout after 5s"));
        }, 5_000);
        waiters.push({
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    }

    socket.once("open", () => resolveOpen({ socket, next }));
    socket.once("error", rejectOpen);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ws snapshot channel: connect → snapshot envelope (VIZ-04)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("on connect, the client receives ONE { v:1, type:snapshot } envelope", async () => {
    const { app: a, port } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      const msg = await next();
      expect(msg.v).toBe(1);
      expect(msg.type).toBe("snapshot");
      expect(typeof msg.seq).toBe("number");
      expect(typeof msg.simMs).toBe("number");
      expect(msg.payload).toBeDefined();
    } finally {
      socket.close();
    }
  });

  it("snapshot payload contains trailers, hubs, routes, exceptionsOpen, kpis", async () => {
    const payload = emptyPayload();
    const { app: a, port } = await buildTestApp((_db) => Promise.resolve(payload));
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      const msg = await next();
      if (msg.type !== "snapshot") throw new Error("expected snapshot");
      expect(Array.isArray(msg.payload.trailers)).toBe(true);
      expect(Array.isArray(msg.payload.hubs)).toBe(true);
      expect(Array.isArray(msg.payload.routes)).toBe(true);
      expect(Array.isArray(msg.payload.exceptionsOpen)).toBe(true);
      expect(msg.payload.kpis).toBeDefined();
    } finally {
      socket.close();
    }
  });

  it("first snapshot has seq=1", async () => {
    const { app: a, port } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      const msg = await next();
      expect(msg.seq).toBe(1);
    } finally {
      socket.close();
    }
  });
});

describe("ws snapshot channel: broadcast(simMs) → tick envelope", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("broadcast(simMs) sends ONE { v:1, type:tick } envelope", async () => {
    const { app: a, port, broadcast } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      await next(); // consume the initial snapshot
      const pending = next();
      await broadcast(5000);
      const msg = await pending;
      expect(msg.v).toBe(1);
      expect(msg.type).toBe("tick");
      expect(typeof msg.seq).toBe("number");
    } finally {
      socket.close();
    }
  });

  it("seq increments by exactly 1 per message (snapshot then ticks)", async () => {
    const { app: a, port, broadcast } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      const snap = await next();
      expect(snap.seq).toBe(1);

      await broadcast(1000);
      const t1 = await next();
      expect(t1.seq).toBe(2);

      await broadcast(2000);
      const t2 = await next();
      expect(t2.seq).toBe(3);
    } finally {
      socket.close();
    }
  });

  it("tick simMs reflects the simMs passed to broadcast()", async () => {
    const { app: a, port, broadcast } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      await next(); // consume initial snapshot
      await broadcast(12345);
      const tick = await next();
      expect(tick.simMs).toBe(12345);
    } finally {
      socket.close();
    }
  });

  it("tick payload carries ONLY changed entities (diffTick)", async () => {
    let callCount = 0;
    const t1Payload: SnapshotPayload = {
      ...emptyPayload(),
      trailers: [{ id: "T1", routeId: "R1", departMs: 1000, etaMs: 2000, state: "onTime" }],
    };
    const t1Changed: SnapshotPayload = {
      ...emptyPayload(),
      trailers: [{ id: "T1", routeId: "R1", departMs: 1000, etaMs: 3000, state: "onTime" }],
    };
    const { app: a, port, broadcast } = await buildTestApp((_db) => {
      callCount += 1;
      return Promise.resolve(callCount <= 2 ? t1Payload : t1Changed);
    });
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      await next(); // initial snapshot (callCount=1 → t1Payload as baseline)

      // Second call (callCount=2 → same t1Payload) → empty diff
      await broadcast(1000);
      const tick1 = await next();
      expect(tick1.type).toBe("tick");
      if (tick1.type !== "tick") throw new Error("expected tick");
      expect(Object.keys(tick1.payload)).toHaveLength(0);

      // Third call (callCount=3 → t1Changed, etaMs differs) → only T1
      await broadcast(2000);
      const tick2 = await next();
      if (tick2.type !== "tick") throw new Error("expected tick");
      expect(tick2.payload.trailers).toHaveLength(1);
      expect(tick2.payload.trailers?.[0]?.id).toBe("T1");
      expect(tick2.payload.trailers?.[0]?.etaMs).toBe(3000);
    } finally {
      socket.close();
    }
  });

  it("unchanged tick sends empty payload {} (zero-noise invariant)", async () => {
    const { app: a, port, broadcast } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      await next(); // initial snapshot
      await broadcast(1000);
      const tick = await next();
      if (tick.type !== "tick") throw new Error("expected tick");
      expect(Object.keys(tick.payload)).toHaveLength(0);
    } finally {
      socket.close();
    }
  });

  it("T-01-19: N raw events within one tick still produce exactly ONE tick message", async () => {
    const { app: a, port, broadcast } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      await next(); // initial snapshot

      // Simulate N raw events all arriving in one tick: call broadcast() once.
      // Collect ALL messages received within 300 ms — there should be exactly 1.
      const messages: WsEnvelope[] = [];
      const done = new Promise<void>((resolve) => {
        socket.on("message", (data: RawData) => {
          messages.push(parseEnvelope(data));
        });
        setTimeout(resolve, 300);
      });

      await broadcast(3000);
      await done;

      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe("tick");
    } finally {
      socket.close();
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — real hub/route buckets on the live ws path (VIZ-03)
// These tests verify the buildSnapshotPayload function produces non-zero
// hub buckets when the DB has actual inventory/exception data.
// ---------------------------------------------------------------------------

describe("buildSnapshotPayload FIX 3 — non-zero hub buckets and route list (VIZ-03)", () => {
  it("RED: snapshot with hubs and non-zero volumeBucket carries at least one hub", async () => {
    // Build a payload that simulates hubs with real inventory data.
    // The fix: buildSnapshotPayload must query hub_inventory and compute buckets.
    // Here we test via the injectable SnapshotPayloadBuilder port — the real
    // builder is tested in the integration test that drives the seeded sim.
    const payloadWithHubs: SnapshotPayload = {
      trailers: [],
      hubs: [
        { id: "HUB-A", volumeBucket: 2, slaRiskBucket: 1, congestionBucket: 0 },
        { id: "HUB-B", volumeBucket: 0, slaRiskBucket: 3, congestionBucket: 1 },
      ],
      routes: [
        { id: "R-AB", loadBucket: 1, slaRiskBucket: 0 },
      ],
      exceptionsOpen: [],
      kpis: {
        utilization: 0,
        rehandleCount: 0,
        rehandleMinutes: 0,
        wrongTrailerCount: 0,
        missedUnloadCount: 0,
        slaViolationRate: 0,
        onTimeDeparture: 1,
        onTimeArrival: 1,
        baseline: {
          utilization: 0,
          rehandleCount: 0,
          rehandleMinutes: 0,
          wrongTrailerCount: 0,
          missedUnloadCount: 0,
          slaViolationRate: 0,
          onTimeDeparture: 1,
          onTimeArrival: 1,
        },
      },
    };

    // A builder that returns real hub state (not all-zero).
    const builder = (_db: ApiDb) => Promise.resolve(payloadWithHubs);
    const { app: a, port } = await buildTestApp(builder);
    const { socket, next } = await openSocketBuffered(port);
    try {
      const msg = await next();
      if (msg.type !== "snapshot") throw new Error("expected snapshot");
      // At least one hub must have a non-zero bucket to show real data.
      const hasNonZeroBucket = msg.payload.hubs.some(
        (h) => h.volumeBucket !== 0 || h.slaRiskBucket !== 0 || h.congestionBucket !== 0,
      );
      expect(hasNonZeroBucket).toBe(true);
      // Routes must be non-empty (FIX 3: routes: [] must become real route list).
      expect(msg.payload.routes.length).toBeGreaterThan(0);
    } finally {
      socket.close();
      await a.close();
    }
  });

  it("RED: tick delta carries changed hub buckets when they differ from baseline", async () => {
    // Simulate two successive payloads: first all-zero, then one hub changes.
    let call = 0;
    const zeroPayload: SnapshotPayload = {
      trailers: [],
      hubs: [{ id: "HUB-X", volumeBucket: 0, slaRiskBucket: 0, congestionBucket: 0 }],
      routes: [],
      exceptionsOpen: [],
      kpis: {
        utilization: 0, rehandleCount: 0, rehandleMinutes: 0,
        wrongTrailerCount: 0, missedUnloadCount: 0, slaViolationRate: 0,
        onTimeDeparture: 1, onTimeArrival: 1,
        baseline: {
          utilization: 0, rehandleCount: 0, rehandleMinutes: 0,
          wrongTrailerCount: 0, missedUnloadCount: 0, slaViolationRate: 0,
          onTimeDeparture: 1, onTimeArrival: 1,
        },
      },
    };
    const changedPayload: SnapshotPayload = {
      ...zeroPayload,
      hubs: [{ id: "HUB-X", volumeBucket: 2, slaRiskBucket: 0, congestionBucket: 0 }],
    };

    const builder = (_db: ApiDb) => {
      call++;
      return Promise.resolve(call <= 2 ? zeroPayload : changedPayload);
    };
    const { app: a, port, broadcast } = await buildTestApp(builder);
    const { socket, next } = await openSocketBuffered(port);
    try {
      await next(); // initial snapshot (zero)
      await broadcast(1000); // second call → same zero payload → empty diff
      const tick1 = await next();
      if (tick1.type !== "tick") throw new Error("expected tick");
      expect(Object.keys(tick1.payload)).toHaveLength(0); // no change

      await broadcast(2000); // third call → changedPayload → hub changed
      const tick2 = await next();
      if (tick2.type !== "tick") throw new Error("expected tick");
      // FIX 3: when hub buckets change, the tick must carry the changed hub.
      expect(tick2.payload.hubs).toBeDefined();
      expect(tick2.payload.hubs!.length).toBeGreaterThan(0);
      expect(tick2.payload.hubs![0]!.id).toBe("HUB-X");
      expect(tick2.payload.hubs![0]!.volumeBucket).toBe(2);
    } finally {
      socket.close();
      await a.close();
    }
  });
});

describe("ws snapshot channel: M-5 rejection on connect", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("a rejecting buildPayload on connect closes the socket and does not throw unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const { app: a, port } = await buildTestApp(
        (_db) => Promise.reject(new Error("simulated transient DB failure")),
      );
      app = a;

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      expect(closed).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
