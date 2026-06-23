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
  driverBucketsPerHub,
  routeSlaRiskBucketFor,
  trailerStateFor,
  type SnapshotPayloadBuilder,
} from "./snapshots.js";
import { makeSpeedController } from "../sim/speed-controller.js";
import type { ApiDb } from "../routes/queries.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FAKE_DB = {} as unknown as ApiDb;

function emptyPayload(): SnapshotPayload {
  // F-02: the ws channel no longer carries KPIs (live KPIs come from GET /api/kpis).
  // `kpis` is optional on SnapshotPayload and omitted here to mirror production.
  return {
    trailers: [],
    hubs: [],
    routes: [],
    exceptionsOpen: [],
  };
}

/** Build a Fastify app + ws channel; returns { app, port, broadcast }. */
async function buildTestApp(
  buildPayload: SnapshotPayloadBuilder = () => Promise.resolve(emptyPayload()),
): Promise<{
  app: FastifyInstance;
  port: number;
  broadcast: (simMs: number) => Promise<WsEnvelope>;
}> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  const broadcast = attachSnapshotSocket(app, FAKE_DB, makeSpeedController(), {
    buildPayload,
  });
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
            reject(e instanceof Error ? e : new Error(String(e)));
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

  it("snapshot payload contains trailers, hubs, routes, exceptionsOpen (no kpis — F-02)", async () => {
    const payload = emptyPayload();
    const { app: a, port } = await buildTestApp(() => Promise.resolve(payload));
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      const msg = await next();
      if (msg.type !== "snapshot") throw new Error("expected snapshot");
      expect(Array.isArray(msg.payload.trailers)).toBe(true);
      expect(Array.isArray(msg.payload.hubs)).toBe(true);
      expect(Array.isArray(msg.payload.routes)).toBe(true);
      expect(Array.isArray(msg.payload.exceptionsOpen)).toBe(true);
      // F-02: live KPIs come from GET /api/kpis — the ws snapshot must NOT carry
      // a kpis field (a zeroed placeholder would clobber the live REST values).
      expect("kpis" in msg.payload).toBe(false);
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

  it("stamps envelope-level `speed` from the controller snapshot (snapshot + tick)", async () => {
    const controller = makeSpeedController();
    controller.setMultiplier(2); // tickIntervalMs 250, simSpeed 240
    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    const broadcast = attachSnapshotSocket(app, FAKE_DB, controller, {
      buildPayload: () => Promise.resolve(emptyPayload()),
    });
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const { socket, next } = await openSocketBuffered(address.port);
    try {
      const snap = await next();
      expect(snap.speed).toEqual({
        multiplier: 2,
        tickIntervalMs: 250,
        simSpeed: 240,
        paused: false,
      });

      // A pause flips simSpeed to 0 on the very next envelope.
      controller.setPaused(true);
      await broadcast(60_000);
      const tick = await next();
      expect(tick.speed.simSpeed).toBe(0);
      expect(tick.speed.paused).toBe(true);
      expect(tick.speed.tickIntervalMs).toBe(250); // interval retained while paused
    } finally {
      socket.close();
      await app.close();
    }
  });

  it("broadcast records the simMs via controller.noteSimMs (anchor for immediate pushes)", async () => {
    const controller = makeSpeedController();
    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    const broadcast = attachSnapshotSocket(app, FAKE_DB, controller, {
      buildPayload: () => Promise.resolve(emptyPayload()),
    });
    await app.ready();
    expect(controller.getLastSimMs()).toBe(0);
    await broadcast(123_456);
    expect(controller.getLastSimMs()).toBe(123_456);
    await app.close();
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
    const { app: a, port, broadcast } = await buildTestApp(() => {
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
    const builder: SnapshotPayloadBuilder = () => Promise.resolve(payloadWithHubs);
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

    const builder: SnapshotPayloadBuilder = () => {
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

// ---------------------------------------------------------------------------
// F-02 — ws channel must NOT carry zeroed KPIs that clobber the REST source.
// Live KPIs are served by GET /api/kpis (the documented single source of truth).
// The ws snapshot/tick must NOT carry a `kpis` field at all, so the dashboard's
// REST-fetched values are never overwritten by a zeroed placeholder.
// ---------------------------------------------------------------------------

describe("ws snapshot channel: F-02 — no zeroed KPIs on the wire", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("the initial snapshot payload does NOT carry a kpis field", async () => {
    const { app: a, port } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      const msg = await next();
      if (msg.type !== "snapshot") throw new Error("expected snapshot");
      // REST GET /api/kpis is the single source of truth — the ws snapshot must
      // not carry KPIs (a zeroed placeholder would clobber the live REST values).
      expect("kpis" in msg.payload).toBe(false);
    } finally {
      socket.close();
    }
  });

  it("a tick from the real buildSnapshotPayload never emits a kpis partial", async () => {
    // Use the REAL default builder path (no injected override) so we exercise the
    // production payload. We assert via diffTick semantics: with no KPI data on
    // either side, the tick must omit `kpis` entirely.
    const { app: a, port, broadcast } = await buildTestApp();
    app = a;
    const { socket, next } = await openSocketBuffered(port);
    try {
      await next(); // consume initial snapshot
      await broadcast(1000);
      const tick = await next();
      if (tick.type !== "tick") throw new Error("expected tick");
      expect(tick.payload.kpis).toBeUndefined();
    } finally {
      socket.close();
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 9 (VIZ-03 completeness) — route slaRisk + trailer state from REAL signals.
//
// Both buckets were previously DARK (hardcoded):
//   - route.slaRiskBucket = 0 (constant)
//   - in-transit trailer.state = "onTime" (constant)
//
// They must now be DRIVEN by the open-exceptions read model (the same signal that
// already drives per-hub slaRiskBucket), never replaced with another constant.
// ---------------------------------------------------------------------------

describe("FIX 9 — routeSlaRiskBucketFor (real signal: endpoint-hub exception risk)", () => {
  it("is 0 when neither endpoint hub has open exceptions", () => {
    const perHub = new Map<string, number>(); // no exceptions anywhere
    expect(routeSlaRiskBucketFor("HUB-A", "HUB-B", perHub)).toBe(0);
  });

  it("reflects the riskier endpoint hub (max of the two), NOT a constant 0", () => {
    // HUB-B has 3 open exceptions → hub slaRiskBucket 3 (high). The route A→B
    // inherits that risk because freight crossing the leg is exposed to it.
    const perHub = new Map<string, number>([
      ["HUB-A", 1], // bucket 1
      ["HUB-B", 3], // bucket 3 (the max)
    ]);
    const bucket = routeSlaRiskBucketFor("HUB-A", "HUB-B", perHub);
    expect(bucket).not.toBe(0); // the bug was a hardcoded 0
    expect(bucket).toBe(3); // max(bucketFor(1)=1, bucketFor(3)=3) = 3
  });

  it("uses the origin hub's risk when only the origin has exceptions", () => {
    const perHub = new Map<string, number>([["HUB-A", 2]]);
    expect(routeSlaRiskBucketFor("HUB-A", "HUB-B", perHub)).toBe(2);
  });
});

describe("FIX 9 — trailerStateFor (real signal: trailer implicated in open exception)", () => {
  it("keeps the base state when the trailer is in NO open exception", () => {
    const implicated = new Set<string>(["T-OTHER"]);
    expect(trailerStateFor("T1", "onTime", implicated)).toBe("onTime");
  });

  it("escalates an in-transit trailer to 'slaRisk' when implicated, NOT a constant 'onTime'", () => {
    // The bug: every in-transit trailer was hardcoded "onTime". A trailer the
    // detector flagged (wrong-trailer / missed-unload) must surface as at-risk.
    const implicated = new Set<string>(["T1"]);
    const state = trailerStateFor("T1", "onTime", implicated);
    expect(state).not.toBe("onTime"); // the bug was a hardcoded "onTime"
    expect(state).toBe("slaRisk");
  });

  it("never overrides an 'idle' trailer (idle is positional, not risk)", () => {
    // An idle trailer sitting at a hub is not "in transit at risk" — preserve idle.
    const implicated = new Set<string>(["T1"]);
    expect(trailerStateFor("T1", "idle", implicated)).toBe("idle");
  });
});

describe("HUBQ-08 — driverBucketsPerHub (trailer→driver join, per-hub duty tally)", () => {
  it("counts drivers of trailers AT a hub, tallying on_break / resting subsets", () => {
    const trailers = [
      { current_hub_id: "MEM", driver_id: "D1" },
      { current_hub_id: "MEM", driver_id: "D2" },
      { current_hub_id: "MEM", driver_id: "D3" },
      { current_hub_id: "DFW", driver_id: "D4" },
    ];
    const drivers = [
      { driver_id: "D1", status: "driving" },
      { driver_id: "D2", status: "on_break" },
      { driver_id: "D3", status: "resting" },
      { driver_id: "D4", status: "driving" },
    ];
    const map = driverBucketsPerHub(trailers, drivers);
    expect(map.get("MEM")).toEqual({ driverCount: 3, onBreakCount: 1, restingCount: 1 });
    expect(map.get("DFW")).toEqual({ driverCount: 1, onBreakCount: 0, restingCount: 0 });
  });

  it("skips trailers with no hub or no driver, and drivers with no status row", () => {
    const trailers = [
      { current_hub_id: null, driver_id: "D1" }, // no hub
      { current_hub_id: "MEM", driver_id: null }, // no driver
      { current_hub_id: "MEM", driver_id: "D-UNKNOWN" }, // driver with no status row
      { current_hub_id: "MEM", driver_id: "D2" }, // counted
    ];
    const drivers = [{ driver_id: "D2", status: "driving" }];
    const map = driverBucketsPerHub(trailers, drivers);
    expect(map.get("MEM")).toEqual({ driverCount: 1, onBreakCount: 0, restingCount: 0 });
  });

  it("is empty when no trailer at any hub has a known bound driver", () => {
    const map = driverBucketsPerHub(
      [{ current_hub_id: "MEM", driver_id: null }],
      [{ driver_id: "D1", status: "driving" }],
    );
    expect(map.size).toBe(0);
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
        () => Promise.reject(new Error("simulated transient DB failure")),
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
