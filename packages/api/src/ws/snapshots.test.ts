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

function emptyPayload(simMs = 0): SnapshotPayload {
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
  void simMs; // simMs will be supplied via broadcast() not the payload builder
}

/** Build a Fastify app + ws channel; returns { app, port, broadcast }. */
async function buildTestApp(
  buildPayload: SnapshotPayloadBuilder = () => Promise.resolve(emptyPayload()),
): Promise<{ app: FastifyInstance; port: number; broadcast: (simMs: number) => Promise<WsEnvelope> }> {
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

function openSocket(port: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function decodeText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function parseEnvelope(data: RawData): WsEnvelope {
  return JSON.parse(decodeText(data)) as WsEnvelope;
}

function nextMessage(socket: WebSocket): Promise<WsEnvelope> {
  return new Promise<WsEnvelope>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nextMessage timeout")), 5_000);
    socket.once("message", (data: RawData) => {
      clearTimeout(timer);
      try {
        resolve(parseEnvelope(data));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.once("error", reject);
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
    const socket = await openSocket(port);
    try {
      const msg = await nextMessage(socket);
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
    const { app: a, port } = await buildTestApp(() => Promise.resolve(payload));
    app = a;
    const socket = await openSocket(port);
    try {
      const msg = await nextMessage(socket);
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
    const socket = await openSocket(port);
    try {
      const msg = await nextMessage(socket);
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
    const socket = await openSocket(port);
    try {
      await nextMessage(socket); // consume the initial snapshot
      const pending = nextMessage(socket);
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
    const socket = await openSocket(port);
    try {
      const snap = await nextMessage(socket);
      expect(snap.seq).toBe(1);

      const p1 = nextMessage(socket);
      await broadcast(1000);
      const t1 = await p1;
      expect(t1.seq).toBe(2);

      const p2 = nextMessage(socket);
      await broadcast(2000);
      const t2 = await p2;
      expect(t2.seq).toBe(3);
    } finally {
      socket.close();
    }
  });

  it("tick simMs reflects the simMs passed to broadcast()", async () => {
    const { app: a, port, broadcast } = await buildTestApp();
    app = a;
    const socket = await openSocket(port);
    try {
      await nextMessage(socket); // consume initial snapshot
      const p = nextMessage(socket);
      await broadcast(12345);
      const tick = await p;
      expect(tick.simMs).toBe(12345);
    } finally {
      socket.close();
    }
  });

  it("tick payload carries ONLY changed entities (diffTick)", async () => {
    // First broadcast: payload with one trailer
    let callCount = 0;
    const t1Payload: SnapshotPayload = {
      ...emptyPayload(),
      trailers: [{
        id: "T1", routeId: "R1", departMs: 1000, etaMs: 2000, state: "onTime",
      }],
    };
    const t1Changed: SnapshotPayload = {
      ...emptyPayload(),
      trailers: [{
        id: "T1", routeId: "R1", departMs: 1000, etaMs: 3000, state: "onTime", // etaMs changed
      }],
    };
    const { app: a, port, broadcast } = await buildTestApp(() => {
      callCount += 1;
      return Promise.resolve(callCount <= 2 ? t1Payload : t1Changed);
    });
    app = a;
    const socket = await openSocket(port);
    try {
      await nextMessage(socket); // initial snapshot

      // First tick: same payload as connect snapshot → empty diff
      const p1 = nextMessage(socket);
      await broadcast(1000);
      const tick1 = await p1;
      expect(tick1.type).toBe("tick");
      if (tick1.type !== "tick") throw new Error("expected tick");
      expect(Object.keys(tick1.payload)).toHaveLength(0);

      // Second tick: etaMs changed → only T1 in trailers array
      const p2 = nextMessage(socket);
      await broadcast(2000);
      const tick2 = await p2;
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
    const socket = await openSocket(port);
    try {
      await nextMessage(socket); // initial snapshot
      const p = nextMessage(socket);
      await broadcast(1000);
      const tick = await p;
      if (tick.type !== "tick") throw new Error("expected tick");
      expect(Object.keys(tick.payload)).toHaveLength(0);
    } finally {
      socket.close();
    }
  });

  it("T-01-19: N raw events within one tick still produce exactly ONE tick message", async () => {
    const { app: a, port, broadcast } = await buildTestApp();
    app = a;
    const socket = await openSocket(port);
    try {
      await nextMessage(socket); // initial snapshot

      // Simulate N raw events all arriving in one tick: call broadcast() once.
      // Collect ALL messages received within 200 ms — there should be exactly 1.
      const messages: WsEnvelope[] = [];
      const done = new Promise<void>((resolve) => {
        socket.on("message", (data: RawData) => {
          messages.push(parseEnvelope(data));
        });
        setTimeout(resolve, 200);
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

describe("ws snapshot channel: M-5 rejection on connect", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("a rejecting buildPayload on connect closes the socket and does not throw unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      const { app: a, port } = await buildTestApp(
        () => Promise.reject(new Error("simulated transient DB failure")),
      );
      app = a;

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        socket.once("close", () => { clearTimeout(timer); resolve(true); });
        socket.once("error", () => { clearTimeout(timer); resolve(true); });
      });

      expect(closed).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
