import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  type CatchupDb,
  type ExceptionKind,
  type ProjectionDb,
  readGeoKeyframes,
  readOpenExceptions,
} from "@mm/projections";
import { assertNever, type Severity } from "@mm/domain";
import type { Kysely } from "kysely";
import { type ApiDb, readHubsFromLog } from "../routes/queries.js";
import {
  diffTick,
  type ExceptionItem,
  type HubState,
  type RouteState,
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
 * Normalize a JSONB string-array column to `string[]`.
 *
 * The `hub_inventory` inbound/outbound/staged columns are JSONB; the `pg` driver
 * deserializes them to a real array, so the value is normally already `string[]`
 * (its select type). Defensively, if a driver/mock hands back a raw JSON string
 * we parse it. We inspect via `unknown` so the runtime string fallback stays
 * type-safe (no `any`, no unnecessary assertion on the already-typed array path).
 */
function toStringArray(value: string[]): string[] {
  const v: unknown = value;
  if (typeof v === "string") {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  }
  return value;
}

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
   * (geo-track keyframes + hubs + open exceptions; KPIs are NOT carried over ws —
   * F-02: live KPIs are served by `GET /api/kpis`). Injected by tests to avoid a
   * live DB.
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
// Default SnapshotPayload builder (real DB, injected in tests)
// ---------------------------------------------------------------------------

/**
 * Derive a `TrailerKeyframe` from the geo-track projection.
 * departMs/etaMs are approximated from keyframe ISO timestamps until Plan 05-03
 * wires the trip plan ETAs. In-transit `state` is driven by the open-exceptions
 * read model (FIX 9 — {@link trailerStateFor}): a trailer the detector flagged
 * shows as `"slaRisk"`, otherwise `"onTime"`. The CRITICAL fields (id, routeId)
 * come from the projection.
 */
function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

// ---------------------------------------------------------------------------
// VIZ-03 bucket helpers (FIX 3 — real hub/route buckets from live projections)
// ---------------------------------------------------------------------------

/**
 * Quantize an integer count into 0-based buckets (0=empty, 1=low, 2=med, 3=high,
 * 4=very-high). The thresholds are demo-calibrated for a ~10-hub sim network.
 * Pure + deterministic: same count ⇒ same bucket (no Date.now/Math.random).
 */
function volumeBucketFor(count: number): number {
  if (count === 0) return 0;
  if (count <= 5) return 1;
  if (count <= 15) return 2;
  if (count <= 30) return 3;
  return 4;
}

/**
 * Quantize exception count per hub into 0-3 sla-risk buckets.
 * 0 = no open exceptions, 1 = low (1 exc), 2 = medium (2), 3 = high (≥3).
 */
function slaRiskBucketFor(exceptionCount: number): number {
  if (exceptionCount === 0) return 0;
  if (exceptionCount === 1) return 1;
  if (exceptionCount === 2) return 2;
  return 3;
}

/**
 * Quantize the number of in-transit trailers per route leg into 0-3 load buckets.
 * 0 = no trailers, 1 = light (1), 2 = medium (2), 3 = heavy (≥3).
 */
function loadBucketFor(trailerCount: number): number {
  if (trailerCount === 0) return 0;
  if (trailerCount === 1) return 1;
  if (trailerCount === 2) return 2;
  return 3;
}

/**
 * FIX 9 (VIZ-03 completeness) — REAL route-level SLA-risk bucket.
 *
 * Previously hardcoded `0` ("route-level SLA risk needs trip-plan data — future
 * plan"), so route SLA-risk coloring on the map was permanently dark. We DRIVE it
 * from the SAME signal that already drives per-hub `slaRiskBucket`: the open
 * exception count per hub (`exceptionsPerHub`). A directed leg `from→to` carries
 * freight that is exposed to disruption at BOTH endpoint hubs, so the honest,
 * DRY derivation is the **max** of the two endpoints' hub SLA-risk buckets
 * (reusing {@link slaRiskBucketFor} — ONE calibration source, no fabricated
 * constant). Pure + deterministic.
 *
 * Exported for unit testing (the production path calls it inside
 * {@link buildSnapshotPayload}).
 */
export function routeSlaRiskBucketFor(
  fromHubId: string,
  toHubId: string,
  exceptionsPerHub: ReadonlyMap<string, number>,
): number {
  const fromRisk = slaRiskBucketFor(exceptionsPerHub.get(fromHubId) ?? 0);
  const toRisk = slaRiskBucketFor(exceptionsPerHub.get(toHubId) ?? 0);
  return Math.max(fromRisk, toRisk);
}

/**
 * FIX 9 (VIZ-03 completeness) — REAL in-transit trailer SLA `state`.
 *
 * Previously every in-transit keyframe was hardcoded `"onTime"`, so trailer
 * SLA-state coloring was permanently dark. We DRIVE it from the open-exceptions
 * read model: the detector (`WrongTrailerDetected` / `MissedUnloadDetected`)
 * names the OBSERVED `trailerId` on every exception. A trailer whose id appears
 * in any open exception is genuinely at risk → `"slaRisk"`; otherwise it keeps
 * its base state. `"idle"` is positional (parked at a hub, not in transit) and is
 * never overridden — risk coloring applies to moving freight only. Pure.
 *
 * NOTE (honesty / F-03): we report `"slaRisk"`, NOT `"late"`. The MVP persists no
 * scheduled ETA to compare against (see `KpiSnapshot.onTimeArrival === null`),
 * so claiming a trailer is "late" would be fabricated. "At risk because flagged
 * by the detector" is the strongest claim the available signal supports.
 *
 * Exported for unit testing.
 */
export function trailerStateFor(
  trailerId: string,
  baseState: TrailerKeyframe["state"],
  implicatedTrailerIds: ReadonlySet<string>,
): TrailerKeyframe["state"] {
  // Idle trailers are positional, not a risk signal — never override.
  if (baseState === "idle") return baseState;
  return implicatedTrailerIds.has(trailerId) ? "slaRisk" : baseState;
}

/**
 * Translate a projection exception `kind` (hyphenated taxonomy) onto the wire
 * envelope `kind` (camelCase) the frontend `AlertFeed.kindLabel` map expects
 * (F-01). Exhaustive over `ExceptionKind`; adding a member without a case stops
 * compilation via {@link assertNever}.
 */
export function exceptionKindToWire(kind: ExceptionKind): ExceptionItem["kind"] {
  switch (kind) {
    case "wrong-trailer":
      return "wrongTrailer";
    case "missed-unload":
      return "missedUnload";
    default:
      return assertNever(kind);
  }
}

/**
 * Translate a projection exception `severity` (`info | warning | critical`) onto
 * the wire envelope `severity` (`low | med | high`) the frontend
 * `AlertFeed.severityClass` map expects (F-01). Exhaustive over `Severity`.
 */
export function exceptionSeverityToWire(
  severity: Severity,
): ExceptionItem["severity"] {
  switch (severity) {
    case "info":
      return "low";
    case "warning":
      return "med";
    case "critical":
      return "high";
    default:
      return assertNever(severity);
  }
}

/**
 * Build the current `SnapshotPayload` from:
 *   - geo-track keyframes → `TrailerKeyframe[]` (depart/arrive per trip)
 *   - hub list → `HubState[]` (FIX 3: real integer buckets from hub_inventory + exceptions)
 *   - open exceptions → `ExceptionItem[]`
 *   - routes → `RouteState[]` (FIX 3: real route list with load buckets from geo_route + geo_inflight_trip)
 *   - KPIs → omitted (F-02: live KPIs are served by `GET /api/kpis`, never over ws)
 */
export async function buildSnapshotPayload(db: ApiDb): Promise<SnapshotPayload> {
  const catchup = catchupView(db);
  const proj = projView(db);

  const [keyframes, hubList, openExceptions, hubInventoryRows, geoRouteRows, inflightTripRows] =
    await Promise.all([
      readGeoKeyframes(catchup),
      readHubsFromLog(db),
      readOpenExceptions(proj),
      // FIX 3: real hub inventory for volumeBucket + congestionBucket
      proj.selectFrom("hub_inventory").selectAll().execute(),
      // FIX 3: route leg list for RouteState[]
      proj.selectFrom("geo_route").selectAll().execute(),
      // FIX 3: in-transit trips for route loadBucket
      proj.selectFrom("geo_inflight_trip").selectAll().execute(),
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

  // FIX 9: the set of trailers implicated in any OPEN exception (the detector
  // names the observed trailerId on every wrong-trailer / missed-unload row).
  // This is the REAL signal that drives an in-transit trailer's SLA `state`.
  const implicatedTrailerIds = new Set<string>(
    openExceptions.map((ex) => ex.trailerId),
  );

  const trailers: TrailerKeyframe[] = [...allIds]
    .map((id): TrailerKeyframe => {
      const dep = departures.get(id);
      const arr = arrivals.get(id);
      if (dep !== undefined) {
        // FIX 9: base state is "onTime"; escalate to "slaRisk" when the detector
        // has flagged this trailer (real signal, not a hardcoded constant).
        return {
          id,
          routeId: dep.routeId,
          departMs: dep.ms,
          etaMs: arr !== undefined && arr.ms > dep.ms ? arr.ms : dep.ms + 3_600_000, // 1hr fallback
          state: trailerStateFor(id, "onTime", implicatedTrailerIds),
        };
      }
      // Only arrive keyframe → trailer is idle at a hub (positional, not risk).
      return {
        id,
        routeId: arr?.routeId ?? "",
        departMs: arr?.ms ?? 0,
        etaMs: arr?.ms ?? 0,
        state: "idle",
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // FIX 3 — Hub states: compute real integer buckets from hub_inventory + exceptions.
  // volumeBucket = quantized total package count (inbound+outbound+staged).
  // congestionBucket = quantized outbound+staged (work in progress at the dock).
  // slaRiskBucket = quantized open exception count per hub.

  // Index hub inventory by hubId for O(1) lookup.
  const invByHub = new Map<string, { inbound: string[]; outbound: string[]; staged: string[] }>();
  for (const row of hubInventoryRows) {
    invByHub.set(row.hub_id, {
      inbound: toStringArray(row.inbound),
      outbound: toStringArray(row.outbound),
      staged: toStringArray(row.staged),
    });
  }

  // Count open exceptions per hub (keyed by hubId from the exception row).
  const exceptionsPerHub = new Map<string, number>();
  for (const ex of openExceptions) {
    // exceptions carry hubId — use it to attribute risk to that hub.
    const hubId = ex.hubId;
    if (hubId !== null && hubId !== undefined) {
      exceptionsPerHub.set(hubId, (exceptionsPerHub.get(hubId) ?? 0) + 1);
    }
  }

  const hubs: HubState[] = hubList
    .map((h): HubState => {
      const inv = invByHub.get(h.hubId);
      const inboundCount = inv?.inbound.length ?? 0;
      const outboundCount = inv?.outbound.length ?? 0;
      const stagedCount = inv?.staged.length ?? 0;
      const totalCount = inboundCount + outboundCount + stagedCount;
      const excCount = exceptionsPerHub.get(h.hubId) ?? 0;
      return {
        id: h.hubId,
        volumeBucket: volumeBucketFor(totalCount),
        slaRiskBucket: slaRiskBucketFor(excCount),
        congestionBucket: volumeBucketFor(outboundCount + stagedCount),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // FIX 3 — Routes: build real RouteState[] from geo_route + in-transit trips.
  // Each directed hub pair in geo_route becomes a RouteState with a load bucket
  // derived from how many trips are currently in-flight on that leg.
  const inflightByLeg = new Map<string, number>();
  for (const trip of inflightTripRows) {
    const key = `${trip.from_hub_id}|${trip.to_hub_id}`;
    inflightByLeg.set(key, (inflightByLeg.get(key) ?? 0) + 1);
  }

  // Deduplicate (from_hub, to_hub) pairs; use them as the routeId.
  const seenLeg = new Set<string>();
  const routes: RouteState[] = [];
  for (const row of geoRouteRows) {
    const legKey = `${row.from_hub_id}|${row.to_hub_id}`;
    if (seenLeg.has(legKey)) continue;
    seenLeg.add(legKey);
    const inTransit = inflightByLeg.get(legKey) ?? 0;
    routes.push({
      id: legKey, // stable unique key for this directed leg
      loadBucket: loadBucketFor(inTransit),
      // FIX 9: REAL route SLA-risk — max of the two endpoint hubs' open-exception
      // risk (reuses the hub slaRisk plumbing, DRY). Was a hardcoded 0.
      slaRiskBucket: routeSlaRiskBucketFor(
        row.from_hub_id,
        row.to_hub_id,
        exceptionsPerHub,
      ),
    });
  }
  routes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Exceptions → ExceptionItem (map from OpenException)
  const exceptionsOpen: ExceptionItem[] = openExceptions.map(
    (ex): ExceptionItem => ({
      id: ex.exceptionId,
      kind: exceptionKindToWire(ex.kind),
      severity: exceptionSeverityToWire(ex.severity),
      entityId: ex.trailerId,
      reason: `${ex.kind} detected`,
      recommendedAction: ex.recommendedAction,
      simMs: isoToMs(ex.occurredAt),
    }),
  );

  return {
    trailers,
    hubs,
    routes, // FIX 3: real route metrics (was [])
    // F-02: live KPIs come from GET /api/kpis — do NOT carry a zeroed placeholder
    // here, it would clobber the REST-fetched values on the client.
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

    // FIX 14: handle client resync requests. When a client detects a seq-gap
    // (missed ticks), it sends `{ type: "resync" }`. Reply to THAT socket with
    // a fresh full snapshot envelope so it can re-anchor its local tween clock.
    socket.on("message", (data: RawData) => {
      let msg: unknown;
      try {
        const text =
          Array.isArray(data) ? Buffer.concat(data).toString("utf8")
          : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8")
          : data.toString("utf8");
        msg = JSON.parse(text);
      } catch {
        // Malformed message — ignore silently (not a security risk: no side effects).
        return;
      }
      if (
        typeof msg === "object" &&
        msg !== null &&
        "type" in msg &&
        msg.type === "resync"
      ) {
        // Client requested a full resync. Build a fresh snapshot and reply to
        // this socket only (not broadcast — only the requesting client needs it).
        fetchAndUpdateBaseline()
          .then((payload) => {
            seq += 1;
            const envelope: WsEnvelope = {
              v: 1,
              type: "snapshot",
              seq,
              simMs: 0, // resync resets the client's tween clock to the current state
              payload,
            };
            sendRawIfOpen(socket, JSON.stringify(envelope));
          })
          .catch((err: unknown) => {
            app.log.error(err, "ws resync snapshot failed");
          });
      }
    });

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
  // F-02: no `kpis` — the ws channel does not carry KPIs (GET /api/kpis is the
  // single source of truth). Omitting it keeps `diffTick` from emitting a delta.
  return {
    trailers: [],
    hubs: [],
    routes: [],
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
