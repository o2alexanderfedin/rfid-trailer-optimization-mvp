import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { type CatchupDb, readGeoKeyframes } from "@mm/projections";
import type { Kysely } from "kysely";
import { type ApiDb, readHubsFromLog } from "../routes/queries.js";

/**
 * The realtime ws channel: pushes ONE batched snapshot per sim tick (never a
 * message per raw event — ARCHITECTURE Anti-Pattern 4 / threat T-01-19). Clients
 * (the OpenLayers map) tween trailer motion between snapshots along the route
 * LineString, so the server only emits the keyframe positions it knows.
 *
 * Design (KISS/DIP): `attachSnapshotSocket` registers the `/ws` route and
 * returns a `broadcast()` the caller invokes per tick. The transport (the set of
 * live sockets) is decoupled from the data source (geo-track + hubs read once
 * per tick), so the sim driver simply calls `broadcast()` after each tick and
 * every connected client gets the same bounded snapshot.
 */

/** One trailer's latest known position in a snapshot. */
export interface TrailerSnapshot {
  readonly trailerId: string;
  readonly tripId: string;
  /** "depart" | "arrive" — which keyframe this position is. */
  readonly kind: string;
  readonly lon: number;
  readonly lat: number;
  readonly t: string;
}

/** One hub's static position in a snapshot. */
export interface HubSnapshot {
  readonly hubId: string;
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
}

/** The batched per-tick snapshot message pushed to every ws client. */
export interface SnapshotMessage {
  readonly t: "snapshot";
  readonly trailers: readonly TrailerSnapshot[];
  readonly hubs: readonly HubSnapshot[];
}

/** Broadcast one snapshot to all connected clients; returns the message sent. */
export type Broadcast = () => Promise<SnapshotMessage>;

/** Builds the current snapshot from the read models (injectable for testing). */
export type SnapshotBuilder = (db: ApiDb) => Promise<SnapshotMessage>;

/** Options for {@link attachSnapshotSocket} (dependency inversion / testing). */
export interface SnapshotSocketOptions {
  /**
   * Override the snapshot source. Defaults to the real {@link buildSnapshot}
   * (geo-track keyframes + hubs). Injected by tests to exercise the failure path
   * (M-5) without a live DB.
   */
  readonly buildSnapshot?: SnapshotBuilder;
}

/** View the API handle as the catch-up read schema (same runtime instance). */
function catchupView(db: ApiDb): Kysely<CatchupDb> {
  return db as unknown as Kysely<CatchupDb>;
}

/**
 * Build the current snapshot from the geo-track keyframes + hubs. Each trailer
 * contributes its LATEST keyframe (highest `t`, then `kind`) so the map shows
 * where each trailer most recently was.
 */
async function buildSnapshot(db: ApiDb): Promise<SnapshotMessage> {
  const [keyframes, hubList] = await Promise.all([
    readGeoKeyframes(catchupView(db)),
    readHubsFromLog(db),
  ]);

  // Latest keyframe per trailer (by time, then kind for a stable tie-break).
  const latest = new Map<string, TrailerSnapshot>();
  for (const k of keyframes) {
    const prev = latest.get(k.trailerId);
    if (prev === undefined || k.t > prev.t || (k.t === prev.t && k.kind > prev.kind)) {
      latest.set(k.trailerId, {
        trailerId: k.trailerId,
        tripId: k.tripId,
        kind: k.kind,
        lon: k.lon,
        lat: k.lat,
        t: k.t,
      });
    }
  }
  const trailers = [...latest.values()].sort((a, b) =>
    a.trailerId < b.trailerId ? -1 : a.trailerId > b.trailerId ? 1 : 0,
  );
  const hubs: HubSnapshot[] = hubList.map((h) => ({
    hubId: h.hubId,
    name: h.name,
    lon: h.lon,
    lat: h.lat,
  }));
  return { t: "snapshot", trailers, hubs };
}

/**
 * Attach the `/ws` snapshot channel to `app` (requires `@fastify/websocket`
 * registered). On connect, a client immediately receives the current snapshot;
 * thereafter it receives one snapshot per `broadcast()` (one per sim tick).
 *
 * Returns the `broadcast` function the sim driver calls per tick.
 */
export function attachSnapshotSocket(
  app: FastifyInstance,
  db: ApiDb,
  options: SnapshotSocketOptions = {},
): Broadcast {
  const clients = new Set<WebSocket>();
  const build = options.buildSnapshot ?? buildSnapshot;

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    // Send an initial snapshot so a fresh client paints immediately. This is
    // fire-and-forget, so it MUST handle rejection (M-5): a transient DB read
    // failure here would otherwise become an unhandled promise rejection and,
    // under Node's default `--unhandled-rejections=throw`, crash the whole
    // server. On failure we log and close the socket so the client reconnects.
    build(db)
      .then((snap) => sendIfOpen(socket, snap))
      .catch((err: unknown) => {
        app.log.error(err, "initial ws snapshot failed");
        clients.delete(socket);
        closeIfOpen(socket);
      });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  return async (): Promise<SnapshotMessage> => {
    const snap = await build(db);
    const payload = JSON.stringify(snap);
    for (const socket of clients) sendRawIfOpen(socket, payload);
    return snap;
  };
}

const WS_OPEN = 1; // ws.OPEN — avoid importing the value to keep the module light.

function sendIfOpen(socket: WebSocket, snap: SnapshotMessage): void {
  sendRawIfOpen(socket, JSON.stringify(snap));
}

function sendRawIfOpen(socket: WebSocket, payload: string): void {
  if (socket.readyState === WS_OPEN) socket.send(payload);
}

const WS_CONNECTING = 0; // ws.CONNECTING

/** Gracefully close a socket that is still connecting/open (M-5 failure path). */
function closeIfOpen(socket: WebSocket): void {
  if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
    socket.close();
  }
}
