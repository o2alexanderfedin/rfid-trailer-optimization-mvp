import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  type CatchupDb,
  type ProjectionDb,
  readGeoKeyframes,
  readOpenExceptions,
} from "@mm/projections";
import type { Kysely } from "kysely";
import { type ApiDb, readHubsFromLog } from "../routes/queries.js";
import {
  diffTick,
  type ExceptionItem,
  type HubState,
  type KpiSnapshot,
  type SnapshotPayload,
  type TickPayload,
  type TrailerKeyframe,
  type WsEnvelope,
} from "./envelope.js";

/**
 * The realtime ws channel (VIZ-04 versioned envelope).
 *
 * Wire protocol:
 *   - On connect: ONE `{ v:1, type:"snapshot", seq, simMs, payload }` with the
 *     full `SnapshotPayload` (trailers, hubs, routes, kpis, exceptionsOpen).
 *   - Per `broadcast(simMs)`: ONE `{ v:1, type:"tick", seq, simMs, payload }`
 *     carrying ONLY the entities that changed since the prior tick (`diffTick`).
 *     When nothing changed the tick payload is `{}` (zero-noise — Anti-Pattern 4 /
 *     T-01-19 / T-05-02 — never one message per raw domain event).
 *
 * `seq` is monotonic (drop-detector); `simMs` is the authoritative sim clock so
 * the client can resync its local tween clock (Q2/Q3 from 05-RESEARCH.md).
 *
 * Design (KISS/DIP): `attachSnapshotSocket` is decoupled from the data source via
 * the injectable `buildPayload` port. The sim driver calls `broadcast(simMs)` per
 * tick; it returns the `WsEnvelope` sent for inspection/testing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Port: builds the current `SnapshotPayload` from the read models.
 * Injected by tests; defaults to the real DB-backed builder.
 */
export type SnapshotPayloadBuilder = (db: ApiDb) => Promise<SnapshotPayload>;

/**
 * Broadcast one tick delta to all connected clients.
 * `simMs` is the authoritative sim-clock milliseconds for this tick.
 * Returns the `WsEnvelope` sent (type:"tick").
 */
export type Broadcast = (simMs: number) => Promise<WsEnvelope>;

/** Options for {@link attachSnapshotSocket} (dependency inversion / testing). */
export interface SnapshotSocketOptions {
  /**
   * Override the payload source. Defaults to the real {@link buildSnapshotPayload}
   * (geo-track keyframes + hubs + open exceptions; KPI baseline zeroed until
   * Plan 05-03 wires it). Injected by tests to avoid a live DB.
   */
  readonly buildPayload?: SnapshotPayloadBuilder;
}

// ---------------------------------------------------------------------------
// DB view helpers
// ---------------------------------------------------------------------------

function catchupView(db: ApiDb): Kysely<CatchupDb> {
  return db as unknown as Kysely<CatchupDb>;
}

function projView(db: ApiDb): Kysely<ProjectionDb> {
  return db as unknown as Kysely<ProjectionDb>;
}

// ---------------------------------------------------------------------------
// Default zeroed KPI baseline (Plan 05-03 fills this in)
// ---------------------------------------------------------------------------

const ZEROED_KPI_BASE: Omit<KpiSnapshot, "baseline"> = {
  utilization: 0,
  rehandleCount: 0,
  rehandleMinutes: 0,
  wrongTrailerCount: 0,
  missedUnloadCount: 0,
  slaViolationRate: 0,
  onTimeDeparture: 1,
  onTimeArrival: 1,
};

const ZEROED_KPIS: KpiSnapshot = { ...ZEROED_KPI_BASE, baseline: { ...ZEROED_KPI_BASE } };

// ---------------------------------------------------------------------------
// Default SnapshotPayload builder (real DB, injected in tests)
// ---------------------------------------------------------------------------

/**
 * Derive a `TrailerKeyframe` from the geo-track projection.
 * departMs/etaMs are approximated from keyframe ISO timestamps until Plan 05-03
 * wires the trip plan ETAs; state defaults to "onTime" as a placeholder.
 * The CRITICAL fields (id, routeId) come from the projection; timing/state are
 * refined by downstream plans.
 */
function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Build the current `SnapshotPayload` from:
 *   - geo-track keyframes → `TrailerKeyframe[]` (depart/arrive per trip)
 *   - hub list → `HubState[]` (placeholder integer buckets; VIZ-03 fills them)
 *   - open exceptions → `ExceptionItem[]`
 *   - KPI baseline → zeroed (Plan 05-03 fills it)
 *   - routes → empty (Plan 05-02/05-03 fills route metrics)
 */
export async function buildSnapshotPayload(db: ApiDb): Promise<SnapshotPayload> {
  const [keyframes, hubList, openExceptions] = await Promise.all([
    readGeoKeyframes(catchupView(db)),
    readHubsFromLog(db),
    readOpenExceptions(projView(db)),
  ]);

  // Build TrailerKeyframes: one per trailer, from the LATEST depart + earliest
  // arrive keyframe so we have a departMs/etaMs leg range for tweening.
  // Trailers with only an "arrive" keyframe (already at a hub) are shown as idle.
  const departures = new Map<string, { routeId: string; ms: number }>();
  const arrivals = new Map<string, { routeId: string; ms: number }>();

  for (const k of keyframes) {
    const ms = isoToMs(k.t);
    if (k.kind === "depart") {
      const prev = departures.get(k.trailerId);
      if (prev === undefined || ms > prev.ms) {
        departures.set(k.trailerId, { routeId: k.tripId, ms });
      }
    } else {
      const prev = arrivals.get(k.trailerId);
      if (prev === undefined || ms < prev.ms) {
        arrivals.set(k.trailerId, { routeId: k.tripId, ms });
      }
    }
  }

  // Collect all trailer ids (from both depart + arrive keyframes)
  const allIds = new Set<string>(keyframes.map((k) => k.trailerId));

  const trailers: TrailerKeyframe[] = [...allIds]
    .map((id): TrailerKeyframe => {
      const dep = departures.get(id);
      const arr = arrivals.get(id);
      if (dep !== undefined) {
        return {
          id,
          routeId: dep.routeId,
          departMs: dep.ms,
          etaMs: arr !== undefined && arr.ms > dep.ms ? arr.ms : dep.ms + 3_600_000, // 1hr fallback
          state: "onTime", // VIZ-03 refines this via hub/route metrics in later plans
        };
      }
      // Only arrive keyframe → trailer is idle at a hub
      return {
        id,
        routeId: arr?.routeId ?? "",
        departMs: arr?.ms ?? 0,
        etaMs: arr?.ms ?? 0,
        state: "idle",
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Hub states: placeholder integer buckets (all 0; VIZ-03 refines in Plan 05-02)
  const hubs: HubState[] = hubList
    .map(
      (h): HubState => ({
        id: h.hubId,
        volumeBucket: 0,
        slaRiskBucket: 0,
        congestionBucket: 0,
      }),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Exceptions → ExceptionItem (map from OpenException)
  const exceptionsOpen: ExceptionItem[] = openExceptions.map(
    (ex): ExceptionItem => ({
      id: ex.exceptionId,
      kind: ex.kind as ExceptionItem["kind"],
      severity: ex.severity as ExceptionItem["severity"],
      entityId: ex.trailerId,
      reason: `${ex.kind} detected`,
      recommendedAction: ex.recommendedAction,
      simMs: isoToMs(ex.occurredAt),
    }),
  );

  return {
    trailers,
    hubs,
    routes: [], // Plan 05-03 adds route metrics
    kpis: ZEROED_KPIS,
    exceptionsOpen,
  };
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

const WS_OPEN = 1; // ws.OPEN
const WS_CONNECTING = 0; // ws.CONNECTING

function sendRawIfOpen(socket: WebSocket, payload: string): void {
  if (socket.readyState === WS_OPEN) socket.send(payload);
}

function closeIfOpen(socket: WebSocket): void {
  if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
    socket.close();
  }
}

// ---------------------------------------------------------------------------
// attachSnapshotSocket: the channel
// ---------------------------------------------------------------------------

/**
 * Attach the `/ws` snapshot channel to `app` (requires `@fastify/websocket`
 * registered).
 *
 *   - On connect: client receives ONE `{ v:1, type:"snapshot" }` envelope.
 *   - Per `broadcast(simMs)`: ONE `{ v:1, type:"tick" }` delta per sim tick.
 *
 * Returns the `broadcast(simMs)` function the sim driver calls per tick.
 * `seq` is monotonic across both snapshot and tick messages.
 */
export function attachSnapshotSocket(
  app: FastifyInstance,
  db: ApiDb,
  options: SnapshotSocketOptions = {},
): Broadcast {
  const clients = new Set<WebSocket>();
  const build = options.buildPayload ?? buildSnapshotPayload;

  // Channel state: current seq counter and the baseline payload for diffTick.
  let seq = 0;
  let baseline: SnapshotPayload | undefined;

  /** Build the current payload, update baseline, return the new payload. */
  async function fetchAndUpdateBaseline(): Promise<SnapshotPayload> {
    const current = await build(db);
    baseline = current;
    return current;
  }

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));

    // Send the initial full snapshot envelope. Fire-and-forget with catch (M-5):
    // a transient DB failure must NOT produce an unhandled rejection that crashes
    // the process under `--unhandled-rejections=throw`.
    fetchAndUpdateBaseline()
      .then((payload) => {
        seq += 1;
        const envelope: WsEnvelope = {
          v: 1,
          type: "snapshot",
          seq,
          simMs: 0, // initial snapshot: sim clock starts at 0
          payload,
        };
        sendRawIfOpen(socket, JSON.stringify(envelope));
      })
      .catch((err: unknown) => {
        app.log.error(err, "initial ws snapshot failed");
        clients.delete(socket);
        closeIfOpen(socket);
      });
  });

  /** Broadcast one tick delta to all connected clients. */
  return async (simMs: number): Promise<WsEnvelope> => {
    const current = await build(db);
    const prev = baseline ?? emptySnapshotPayload();
    baseline = current;

    const delta: TickPayload = diffTick(prev, current);
    seq += 1;
    const envelope: WsEnvelope = {
      v: 1,
      type: "tick",
      seq,
      simMs,
      payload: delta,
    };
    const wire = JSON.stringify(envelope);
    for (const socket of clients) sendRawIfOpen(socket, wire);
    return envelope;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshotPayload(): SnapshotPayload {
  return {
    trailers: [],
    hubs: [],
    routes: [],
    kpis: ZEROED_KPIS,
    exceptionsOpen: [],
  };
}

// ---------------------------------------------------------------------------
// Legacy re-export shims (kept so existing consumers compile during migration)
// Phase-5 consumers should import from envelope.ts directly.
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `WsEnvelope` from `./envelope.js` instead.
 * Kept for backward compatibility during Phase-5 migration.
 */
export interface TrailerSnapshot {
  readonly trailerId: string;
  readonly tripId: string;
  readonly kind: string;
  readonly lon: number;
  readonly lat: number;
  readonly t: string;
}

/** @deprecated Use `HubState` from `./envelope.js` instead. */
export interface HubSnapshot {
  readonly hubId: string;
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
}

/** @deprecated The new wire format is `WsEnvelope` from `./envelope.js`. */
export interface SnapshotMessage {
  readonly t: "snapshot";
  readonly trailers: readonly TrailerSnapshot[];
  readonly hubs: readonly HubSnapshot[];
}

/** @deprecated Use `SnapshotPayloadBuilder` instead. */
export type SnapshotBuilder = (db: ApiDb) => Promise<SnapshotMessage>;

/** @deprecated Use `SnapshotPayloadBuilder` in new code. */
export interface LegacySnapshotSocketOptions {
  readonly buildSnapshot?: SnapshotBuilder;
}
