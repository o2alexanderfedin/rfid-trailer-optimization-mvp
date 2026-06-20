import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { driveSimulation, type ApiDb, type WsEnvelope } from "../src/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * Plan 05-01 / Plan 06 Task 2 (updated) — the versioned ws envelope channel
 * against a REAL Postgres + listening server.
 *
 * Updated from the legacy `{ t:'snapshot', trailers, hubs }` shape to the new
 * VIZ-04 versioned envelope:
 *   - connect → `{ v:1, type:"snapshot", seq, simMs, payload }`
 *   - broadcast(simMs) → `{ v:1, type:"tick", seq, simMs, payload }`
 * Messages are BATCHED PER TICK (Anti-Pattern 4), not per raw event.
 */

const SEED = 4242;
const DURATION = 35;

/** Decode a ws text frame to a UTF-8 string, handling each `RawData` shape. */
function decodeText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** Parse a ws text frame as a `WsEnvelope`. */
function parseEnvelope(data: RawData): WsEnvelope {
  return JSON.parse(decodeText(data)) as WsEnvelope;
}

/**
 * Open a buffered socket: collects messages from creation time so tests never
 * race between "open" resolving and the server's async initial-snapshot send.
 */
function openSocketBuffered(
  url: string,
): Promise<{ socket: WebSocket; next: () => Promise<WsEnvelope> }> {
  return new Promise((resolveOpen, rejectOpen) => {
    const socket = new WebSocket(url);
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
        const timer = setTimeout(
          () => reject(new Error("nextMessage timeout")),
          10_000,
        );
        waiters.push({
          resolve: (v) => { clearTimeout(timer); resolve(v); },
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

describe("ws snapshot channel: versioned envelope (VIZ-04) against real Postgres", () => {
  let fx: PgFixture;
  let built: BuiltServer;
  let port: number;

  beforeAll(async () => {
    fx = await startPgFixture();
    const db: ApiDb = fx.db;
    built = await buildServer({ db });
    // Populate the projections (geo keyframes + hubs) before any broadcast.
    await driveSimulation({ db, seed: SEED, durationTicks: DURATION, broadcast: undefined });
    await built.app.listen({ port: 0, host: "127.0.0.1" });
    const address = built.app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server did not bind a TCP port");
    }
    port = address.port;
  }, 180_000);

  afterAll(async () => {
    await built?.app.close();
    await fx?.stop();
  });

  it("pushes an initial snapshot envelope on connect with hubs and trailers in payload", async () => {
    const { socket, next } = await openSocketBuffered(`ws://127.0.0.1:${port}/ws`);
    try {
      const env = await next();
      expect(env.v).toBe(1);
      expect(env.type).toBe("snapshot");
      expect(typeof env.seq).toBe("number");
      expect(typeof env.simMs).toBe("number");
      if (env.type !== "snapshot") throw new Error("expected snapshot");

      expect(Array.isArray(env.payload.hubs)).toBe(true);
      expect(env.payload.hubs.length).toBeGreaterThanOrEqual(10);

      expect(Array.isArray(env.payload.trailers)).toBe(true);
      expect(env.payload.trailers.length).toBeGreaterThan(0);

      const trailer = env.payload.trailers[0]!;
      expect(typeof trailer.id).toBe("string");
      // New shape: routeId + departMs/etaMs (not lon/lat directly on the keyframe)
      expect(typeof trailer.routeId).toBe("string");
      expect(typeof trailer.departMs).toBe("number");
      expect(typeof trailer.etaMs).toBe("number");
      // state is one of the allowed values
      expect(["onTime", "slaRisk", "late", "idle"]).toContain(trailer.state);
    } finally {
      socket.close();
    }
  });

  it("broadcast(simMs) pushes exactly ONE tick envelope per tick (not per event)", async () => {
    const { socket, next } = await openSocketBuffered(`ws://127.0.0.1:${port}/ws`);
    try {
      const snap = await next(); // consume the initial-connect snapshot
      expect(snap.type).toBe("snapshot");
      const snapSeq = snap.seq;

      // One broadcast() == one tick == exactly one tick message.
      await built.broadcast!(0);
      const tick = await next();
      expect(tick.type).toBe("tick");
      expect(tick.v).toBe(1);
      expect(tick.seq).toBe(snapSeq + 1); // monotonic
    } finally {
      socket.close();
    }
  });

  it("each broadcast(simMs) sends exactly one message — N ticks → N messages", async () => {
    const { socket, next } = await openSocketBuffered(`ws://127.0.0.1:${port}/ws`);
    try {
      await next(); // consume the initial-connect snapshot

      // Three ticks → three tick messages, in order (one per tick, never a
      // per-event flood).
      await built.broadcast!(1000);
      await built.broadcast!(2000);
      await built.broadcast!(3000);

      const t1 = await next();
      const t2 = await next();
      const t3 = await next();

      expect(t1.type).toBe("tick");
      expect(t2.type).toBe("tick");
      expect(t3.type).toBe("tick");

      // seq is monotonically increasing
      expect(t2.seq).toBe(t1.seq + 1);
      expect(t3.seq).toBe(t2.seq + 1);

      // simMs matches what was passed to broadcast()
      expect(t1.simMs).toBe(1000);
      expect(t2.simMs).toBe(2000);
      expect(t3.simMs).toBe(3000);
    } finally {
      socket.close();
    }
  });
});
