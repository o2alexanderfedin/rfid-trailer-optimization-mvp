import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { driveSimulation, type ApiDb, type SnapshotMessage } from "../src/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * Plan 06 Task 2 — the ws snapshot channel against a REAL Postgres + listening
 * server. Connecting a ws client and ticking the sim pushes
 * `{ t:'snapshot', trailers:[...], hubs:[...] }` with trailer positions from
 * geo-track; messages are BATCHED PER TICK (Anti-Pattern 4), not per raw event.
 */

const SEED = 4242;
const DURATION = 35;

/** Decode a ws text frame to a UTF-8 string, handling each `RawData` shape. */
function decodeText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** Parse a ws text frame as a `SnapshotMessage`. */
function parseSnapshot(data: RawData): SnapshotMessage {
  return JSON.parse(decodeText(data)) as SnapshotMessage;
}

/** Resolve once the socket receives its next text message (parsed). */
function nextMessage(socket: WebSocket): Promise<SnapshotMessage> {
  return new Promise<SnapshotMessage>((resolve, reject) => {
    socket.once("message", (data: RawData) => {
      try {
        resolve(parseSnapshot(data));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.once("error", reject);
  });
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("ws snapshot channel: batched per-tick trailer + hub snapshots", () => {
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

  it("pushes an initial snapshot on connect with hubs and trailer positions", async () => {
    const socket = await openSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      const snap = await nextMessage(socket);
      expect(snap.t).toBe("snapshot");
      expect(Array.isArray(snap.hubs)).toBe(true);
      expect(snap.hubs.length).toBeGreaterThanOrEqual(10);
      expect(Array.isArray(snap.trailers)).toBe(true);
      expect(snap.trailers.length).toBeGreaterThan(0);
      const trailer = snap.trailers[0]!;
      expect(typeof trailer.trailerId).toBe("string");
      expect(typeof trailer.lon).toBe("number");
      expect(typeof trailer.lat).toBe("number");
      // Trailer position is a real WGS84 coordinate from the route geometry.
      expect(trailer.lat).toBeGreaterThanOrEqual(-90);
      expect(trailer.lat).toBeLessThanOrEqual(90);
    } finally {
      socket.close();
    }
  });

  it("broadcast() pushes exactly ONE batched snapshot per tick (not per event)", async () => {
    const socket = await openSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      await nextMessage(socket); // consume the initial-connect snapshot.

      // One broadcast() == one tick == exactly one snapshot message.
      const received = nextMessage(socket);
      const sent = await built.broadcast!();
      const got = await received;

      expect(got.t).toBe("snapshot");
      expect(got.trailers.length).toBe(sent.trailers.length);
      expect(got.hubs.length).toBe(sent.hubs.length);
      // Trailers are sorted by id (deterministic, bounded message).
      const ids = got.trailers.map((t) => t.trailerId);
      expect([...ids].sort()).toEqual(ids);
    } finally {
      socket.close();
    }
  });

  it("each tick (broadcast) sends exactly one snapshot — N ticks -> N messages", async () => {
    const socket = await openSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      await nextMessage(socket); // consume the initial-connect snapshot.

      // Three ticks -> three snapshot messages, in order (one per tick, never a
      // per-event flood). Collect exactly three then assert the count + shape.
      const got: SnapshotMessage[] = [];
      const collected = new Promise<void>((resolve, reject) => {
        const onMessage = (data: RawData): void => {
          try {
            got.push(parseSnapshot(data));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          if (got.length === 3) {
            socket.off("message", onMessage);
            resolve();
          }
        };
        socket.on("message", onMessage);
      });

      await built.broadcast!();
      await built.broadcast!();
      await built.broadcast!();
      await collected;

      expect(got).toHaveLength(3);
      expect(got.every((m) => m.t === "snapshot")).toBe(true);
      expect(got.every((m) => m.trailers.length > 0 && m.hubs.length >= 10)).toBe(true);
    } finally {
      socket.close();
    }
  });
});
