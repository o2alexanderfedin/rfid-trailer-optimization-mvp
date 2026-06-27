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
import { EPOCH_MS, MEMPHIS } from "@mm/simulation";
import type { Kysely } from "kysely";
import { type ApiDb, readHubsFromLog } from "../routes/queries.js";
import {
  diffTick,
  type DeliveryEvent,
  type ExceptionItem,
  type HubState,
  type InductionEvent,
  type RouteState,
  type SimSpeedState,
  type SnapshotPayload,
  type TickPayload,
  type TrailerKeyframe,
  type TrailerStop,
  type WsEnvelope,
} from "./envelope.js";
import type { SpeedController } from "../sim/speed-controller.js";

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
 * `inductionEvents` (VIZ-13) are the packages inducted during this tick/frame —
 * TRANSIENT, attached to the tick payload to drive the pulsing-marker animation
 * (never persisted, never on a snapshot). Returns the `WsEnvelope` sent.
 */
export type Broadcast = (
  simMs: number,
  inductionEvents?: readonly InductionEvent[],
  deliveryEvents?: readonly DeliveryEvent[],
) => Promise<WsEnvelope>;

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
 * The `/api/routes` DTO id for a directed leg (`route-FROM-TO`).
 *
 * VIZ-02 LIVE-PATH CONTRACT: this MUST equal the routeId the client keys its
 * route LineString geometry by (`fetchRoutes()` → `routeDtos.get(routeId)` in
 * `MapView._upsertTrailerAnim`). A trailer keyframe whose `routeId` is anything
 * else (e.g. the tripId) fails that lookup, so the trailer never gets a route to
 * tween along and stays frozen at its `[0,0]` stub geometry — invisible on the map.
 */
export function legRouteId(fromHubId: string, toHubId: string): string {
  return `route-${fromHubId}-${toHubId}`;
}

/** Great-circle km between two `[lon, lat]` points (haversine). */
function haversineKm(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Estimated transit minutes for a leg from its route polyline length / an average
 * HGV speed. Used to set a realistic `etaMs` for an IN-TRANSIT trailer (one with a
 * depart keyframe but no arrive keyframe yet), so the client tween glides the truck
 * across the WHOLE route over the real leg duration instead of snapping it to the
 * destination after a flat 1-hour guess (which left trucks parked on top of the hub
 * markers for most of each leg). When the arrive keyframe arrives, the real arrival
 * time supersedes this estimate. Pure + deterministic.
 */
export function legTransitMinutes(
  geometry: readonly (readonly [number, number])[],
  avgSpeedKmh = 80,
): number {
  let km = 0;
  for (let i = 1; i < geometry.length; i++) {
    const prev = geometry[i - 1];
    const cur = geometry[i];
    if (prev !== undefined && cur !== undefined) km += haversineKm(prev, cur);
  }
  return avgSpeedKmh > 0 ? (km / avgSpeedKmh) * 60 : 0;
}

/** Geo keyframe fields used to bound a tween leg (structural subset of GeoKeyframe). */
interface LegKeyframe {
  readonly trailerId: string;
  readonly tripId: string;
  readonly kind: "depart" | "arrive";
  readonly t: string;
}

/** An in-flight trip's directed leg (structural subset of the geo_inflight_trip row). */
interface InflightLeg {
  readonly trip_id: string;
  readonly from_hub_id: string;
  readonly to_hub_id: string;
}

/**
 * Assemble one `TrailerKeyframe` per trailer from geo-track keyframes, using the
 * LATEST depart + earliest arrive to bound the tween leg (idle when only an
 * arrive keyframe exists).
 *
 * CRITICAL VIZ-02 live-path fix: `routeId` is resolved to the `/api/routes`
 * geometry key (`route-FROM-TO`) via the trip's in-flight leg — NOT the tripId.
 * Emitting the tripId (the prior behaviour) made every client route lookup miss,
 * so trailers stayed frozen at `[0,0]` and never appeared on the map. The
 * hermetic e2e fed fixtures where routeId already matched, so it never exercised
 * this live mismatch.
 *
 * Pure + deterministic (no I/O, no Date.now) — unit-tested.
 */
export function buildTrailerKeyframes(
  keyframes: readonly LegKeyframe[],
  inflightTrips: readonly InflightLeg[],
  implicatedTrailerIds: ReadonlySet<string>,
  /** routeId → estimated leg transit MINUTES (from route length), for in-transit etaMs. */
  legMinutesByRoute: ReadonlyMap<string, number> = new Map(),
): TrailerKeyframe[] {
  // tripId → `route-FROM-TO` for every currently in-flight leg.
  const routeIdByTrip = new Map<string, string>();
  // VIZ-12: tripId → flow direction. A leg from the center (MEMPHIS) is an
  // outbound distribution leg; any other origin (a spoke) is a spoke→center
  // consolidation leg. Derived purely from the leg origin — deterministic.
  const directionByTrip = new Map<string, "outbound" | "consolidation">();
  for (const trip of inflightTrips) {
    routeIdByTrip.set(trip.trip_id, legRouteId(trip.from_hub_id, trip.to_hub_id));
    directionByTrip.set(
      trip.trip_id,
      trip.from_hub_id === MEMPHIS.hubId ? "outbound" : "consolidation",
    );
  }

  const departures = new Map<string, { tripId: string; ms: number }>();
  const arrivals = new Map<string, { tripId: string; ms: number }>();
  for (const k of keyframes) {
    const ms = isoToMs(k.t);
    if (k.kind === "depart") {
      const prev = departures.get(k.trailerId);
      if (prev === undefined || ms > prev.ms) departures.set(k.trailerId, { tripId: k.tripId, ms });
    } else {
      const prev = arrivals.get(k.trailerId);
      if (prev === undefined || ms < prev.ms) arrivals.set(k.trailerId, { tripId: k.tripId, ms });
    }
  }

  const allIds = new Set<string>(keyframes.map((k) => k.trailerId));
  return [...allIds]
    .map((id): TrailerKeyframe => {
      const dep = departures.get(id);
      const arr = arrivals.get(id);
      if (dep !== undefined) {
        const routeId = routeIdByTrip.get(dep.tripId) ?? "";
        // In-transit ETA: prefer a real arrive keyframe; else estimate the leg
        // duration from its route length so the truck glides the WHOLE route
        // (falls back to 1h only when the leg length is unknown).
        const estMinutes = legMinutesByRoute.get(routeId);
        const fallbackEtaMs =
          dep.ms + (estMinutes !== undefined && estMinutes > 0 ? estMinutes * 60_000 : 3_600_000);
        const direction = directionByTrip.get(dep.tripId);
        return {
          id,
          routeId,
          departMs: dep.ms,
          etaMs: arr !== undefined && arr.ms > dep.ms ? arr.ms : fallbackEtaMs,
          state: trailerStateFor(id, "onTime", implicatedTrailerIds),
          ...(direction !== undefined ? { direction } : {}),
        };
      }
      // Only an arrive keyframe → trailer is idle at a hub (positional, not risk).
      return {
        id,
        routeId: arr !== undefined ? routeIdByTrip.get(arr.tripId) ?? "" : "",
        departMs: arr?.ms ?? 0,
        etaMs: arr?.ms ?? 0,
        state: "idle",
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Per-hub driver-duty tally (HUBQ-08): total + the on_break / resting subsets. */
export interface DriverDutyBuckets {
  readonly driverCount: number;
  readonly onBreakCount: number;
  readonly restingCount: number;
}

/**
 * HUBQ-08 — derive each hub's driver-duty buckets from the trailers AT that hub
 * and their bound drivers' duty status. A driver is counted at the hub its
 * trailer currently sits at; the `on_break` / `resting` subsets are tallied from
 * `driver_status`. Trailers with no `current_hub_id` or no `driver_id`, and
 * drivers with no `driver_status` row, are skipped. Pure + deterministic — same
 * rows ⇒ same map (no clock/RNG), so the snapshot replays identically (P3).
 *
 * The SAME join the REST `/hubs/:id/detail` performs, reduced here to small
 * integer counts for map coloring (the ws envelope carries counts, never lists).
 *
 * Exported for unit testing.
 */
export function driverBucketsPerHub(
  trailerRows: readonly { current_hub_id: string | null; driver_id: string | null }[],
  driverRows: readonly { driver_id: string; status: string }[],
): Map<string, DriverDutyBuckets> {
  const statusById = new Map<string, string>();
  for (const d of driverRows) statusById.set(d.driver_id, d.status);

  const out = new Map<string, { driverCount: number; onBreakCount: number; restingCount: number }>();
  for (const t of trailerRows) {
    const hubId = t.current_hub_id;
    const driverId = t.driver_id;
    if (hubId === null || driverId === null) continue;
    const status = statusById.get(driverId);
    if (status === undefined) continue; // unknown driver → not counted
    const acc = out.get(hubId) ?? { driverCount: 0, onBreakCount: 0, restingCount: 0 };
    acc.driverCount += 1;
    if (status === "on_break") acc.onBreakCount += 1;
    else if (status === "resting") acc.restingCount += 1;
    out.set(hubId, acc);
  }
  return out;
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
    // Phase-25 COORD-03: a coordination reject (an agent honestly declining a
    // re-route, e.g. "won't divert: HOS/fuel") REUSES the existing `blockedFreight`
    // wire kind in the alert feed (CONTEXT decision: no new UI panel). The
    // human-readable reason/label travels in the `reason`/`recommendedAction` fields.
    case "coordination-rejected":
      return "blockedFreight";
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

  const [
    keyframes,
    hubList,
    openExceptions,
    hubInventoryRows,
    geoRouteRows,
    inflightTripRows,
    trailerStateRows,
    driverStatusRows,
  ] = await Promise.all([
    readGeoKeyframes(catchup),
    readHubsFromLog(db),
    readOpenExceptions(proj),
    // FIX 3: real hub inventory for volumeBucket + congestionBucket
    proj.selectFrom("hub_inventory").selectAll().execute(),
    // FIX 3: route leg list for RouteState[]
    proj.selectFrom("geo_route").selectAll().execute(),
    // FIX 3: in-transit trips for route loadBucket
    proj.selectFrom("geo_inflight_trip").selectAll().execute(),
    // HUBQ-08: trailers-at-hub + their bound driver, for per-hub driver buckets.
    proj
      .selectFrom("trailer_state")
      .select(["current_hub_id", "driver_id"])
      .execute(),
    // HUBQ-08: each driver's current duty status (driving / on_break / resting).
    proj.selectFrom("driver_status").select(["driver_id", "status"]).execute(),
  ]);

  // FIX 9: the set of trailers implicated in any OPEN exception (the detector
  // names the observed trailerId on every wrong-trailer / missed-unload row).
  // This is the REAL signal that drives an in-transit trailer's SLA `state`.
  const implicatedTrailerIds = new Set<string>(
    openExceptions.map((ex) => ex.trailerId),
  );

  // Estimated transit minutes per leg (from each route's polyline length) so an
  // in-transit trailer's etaMs reflects the real leg duration and the client tween
  // glides it across the WHOLE route rather than snapping to the destination.
  const legMinutesByRoute = new Map<string, number>();
  for (const row of geoRouteRows) {
    legMinutesByRoute.set(
      legRouteId(row.from_hub_id, row.to_hub_id),
      legTransitMinutes(row.geometry),
    );
  }

  // Build TrailerKeyframes (one per trailer). routeId is resolved to the
  // `/api/routes` geometry key (`route-FROM-TO`) from the in-flight leg so the
  // client can tween the trailer along its route polyline. See buildTrailerKeyframes.
  // SP2: the LEG-bounding tween reads only `depart`/`arrive` keyframes; the new
  // mid-leg `rested`/`refueling` STOP keyframes are surfaced separately (stops[])
  // so the client can park the marker without disturbing the tween bounds.
  const legKeyframes: LegKeyframe[] = keyframes.flatMap((k) =>
    k.kind === "depart" || k.kind === "arrive"
      ? [{ trailerId: k.trailerId, tripId: k.tripId, kind: k.kind, t: k.t }]
      : [],
  );
  const trailers: TrailerKeyframe[] = buildTrailerKeyframes(
    legKeyframes,
    inflightTripRows,
    implicatedTrailerIds,
    legMinutesByRoute,
  );

  // SP2 (spec §8): the mid-leg stop keyframes for the live map — the client renders
  // a stationary parked/refueling marker at each stop's interpolated position for
  // `durationMinutes`. Sorted deterministically (trailer, trip, t) for byte-stable
  // diffs. Carried on the snapshot payload as `trailerStops`.
  const trailerStops: TrailerStop[] = keyframes
    .flatMap((k) =>
      k.kind === "rested" || k.kind === "refueling"
        ? [
            {
              trailerId: k.trailerId,
              tripId: k.tripId,
              kind: k.kind,
              lon: k.lon,
              lat: k.lat,
              startMs: isoToMs(k.t),
              durationMinutes: k.durationMinutes ?? 0,
            },
          ]
        : [],
    )
    .sort((a, b) =>
      a.trailerId !== b.trailerId
        ? a.trailerId < b.trailerId
          ? -1
          : 1
        : a.tripId !== b.tripId
          ? a.tripId < b.tripId
            ? -1
            : 1
          : a.startMs - b.startMs,
    );

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

  // HUBQ-08 — per-hub driver-duty buckets (the same trailer→driver join the REST
  // /hubs/:id/detail performs, reduced to small integer counts for map coloring).
  const driversPerHub = driverBucketsPerHub(trailerStateRows, driverStatusRows);

  const hubs: HubState[] = hubList
    .map((h): HubState => {
      const inv = invByHub.get(h.hubId);
      const inboundCount = inv?.inbound.length ?? 0;
      const outboundCount = inv?.outbound.length ?? 0;
      const stagedCount = inv?.staged.length ?? 0;
      const totalCount = inboundCount + outboundCount + stagedCount;
      const excCount = exceptionsPerHub.get(h.hubId) ?? 0;
      const drv =
        driversPerHub.get(h.hubId) ?? { driverCount: 0, onBreakCount: 0, restingCount: 0 };
      return {
        id: h.hubId,
        volumeBucket: volumeBucketFor(totalCount),
        slaRiskBucket: slaRiskBucketFor(excCount),
        congestionBucket: volumeBucketFor(outboundCount + stagedCount),
        // HUBQ-08: driver-duty buckets (small integer counts).
        driverCount: drv.driverCount,
        onBreakCount: drv.onBreakCount,
        restingCount: drv.restingCount,
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

  // Exceptions → ExceptionItem (map from OpenException). Phase-25 COORD-03: a
  // coordination-rejected row surfaces its honest "won't divert: HOS/fuel" label as
  // the `reason` (the demo moment) and falls back to the suggestionId for entityId
  // (a reject names no trailer in its payload — the agent is on the event stream).
  const exceptionsOpen: ExceptionItem[] = openExceptions.map(
    (ex): ExceptionItem => ({
      id: ex.exceptionId,
      kind: exceptionKindToWire(ex.kind),
      severity: exceptionSeverityToWire(ex.severity),
      entityId:
        ex.kind === "coordination-rejected"
          ? ex.suggestionId ?? ex.exceptionId
          : ex.trailerId,
      reason:
        ex.kind === "coordination-rejected"
          ? ex.label ?? ex.recommendedAction
          : `${ex.kind} detected`,
      recommendedAction: ex.recommendedAction,
      simMs: isoToMs(ex.occurredAt),
    }),
  );

  return {
    trailers,
    // SP2 (spec §8): the mid-leg parked/refueling stops the client renders.
    trailerStops,
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

/**
 * CONT-04b: WS backpressure threshold. When a client's OS-managed send buffer
 * (`socket.bufferedAmount`) exceeds this, the broadcast SKIPS that client's tick
 * delta for the frame — keeping a backgrounded/saturated client's buffer bounded
 * over an indefinite run (instead of growing without bound). 256 KB.
 */
export const BACKPRESSURE_BYTES = 256 * 1024;

// Plan 19-08 Task D: `EPOCH_MS` is imported from `@mm/simulation` (the SINGLE
// source of truth) — no duplicated `"2026-04-01…"` literal that could drift.
/** Milliseconds per sim day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * CONT-03: derive the sim-day counter from the deterministic virtual-clock
 * `simMs` — NEVER `Date.now()` — so it is replay-stable. Clamped to `>= 0` so the
 * initial-connect snapshot (`simMs = 0`, which predates the epoch) shows "Sim
 * Day 0" rather than a large negative number. Pure + exported for unit testing.
 */
export function deriveSimDay(simMs: number): number {
  return Math.max(0, Math.floor((simMs - EPOCH_MS) / MS_PER_DAY));
}

/**
 * CONT-04b: the pure send-gate predicate. A tick delta is sent to a socket only
 * when it is OPEN and its buffered amount is at/below the backpressure threshold.
 * Exported (pure, no I/O) for unit testing; `sendRawIfOpen` applies it.
 *
 * NOTE: this guard is intended for TICK deltas only. The initial-connect snapshot
 * sends at `bufferedAmount === 0` (a fresh socket), so the guard is a harmless
 * no-op there — but a client MUST receive its first snapshot to initialize, so
 * that path does not depend on this gate (Pitfall 4).
 */
export function shouldSendToSocket(socket: {
  readonly readyState: number;
  readonly bufferedAmount: number;
}): boolean {
  if (socket.readyState !== WS_OPEN) return false;
  if (socket.bufferedAmount > BACKPRESSURE_BYTES) return false;
  return true;
}

function sendRawIfOpen(socket: WebSocket, payload: string): void {
  if (shouldSendToSocket(socket)) socket.send(payload);
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
  speedController: SpeedController,
  options: SnapshotSocketOptions = {},
): Broadcast {
  const clients = new Set<WebSocket>();
  const build = options.buildPayload ?? buildSnapshotPayload;

  /** The effective speed state stamped on every envelope (snapshot/resync/tick). */
  function currentSpeed(): SimSpeedState {
    return speedController.snapshot();
  }

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
            // VIZ-RESUME (v2.1): stamp the snapshot with the CURRENT authoritative
            // sim clock (`getLastSimMs()` — the simMs of the most recent broadcast),
            // NOT 0. The trailer keyframes carry absolute-epoch departMs/etaMs, so a
            // 0 anchor made the client compute fraction (0 − departMs)/span ⇒ clamp
            // to 0 ⇒ EVERY in-flight trailer re-rendered at its leg origin and
            // re-animated the whole leg from t=0 (the "east→west restart" on every
            // refresh/resync). Anchoring at the real clock places each trailer at its
            // TRUE current progress immediately.
            const simMs = speedController.getLastSimMs();
            const envelope: WsEnvelope = {
              v: 1,
              type: "snapshot",
              seq,
              simMs, // re-anchor the client's tween clock at the live sim time
              simDay: deriveSimDay(simMs),
              speed: currentSpeed(),
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
        // VIZ-RESUME (v2.1): anchor the initial-connect snapshot at the CURRENT
        // authoritative sim clock (`getLastSimMs()` — the simMs of the most recent
        // broadcast), NOT 0. Trailer keyframes carry absolute-epoch departMs/etaMs;
        // a 0 anchor made the client place every in-flight trailer at its leg origin
        // and re-animate the whole leg from t=0 on every page refresh. With the real
        // clock the client computes the correct fraction = (simNow − departMs)/span
        // and each trailer resumes at its TRUE current position. Before the first
        // broadcast `getLastSimMs()` is 0 (no ticks yet) — the legacy behaviour — so
        // a connect at sim-start is unchanged.
        const simMs = speedController.getLastSimMs();
        const envelope: WsEnvelope = {
          v: 1,
          type: "snapshot",
          seq,
          simMs, // anchor the client's tween clock at the live sim time
          simDay: deriveSimDay(simMs),
          speed: currentSpeed(),
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
  return async (
    simMs: number,
    inductionEvents?: readonly InductionEvent[],
    deliveryEvents?: readonly DeliveryEvent[],
  ): Promise<WsEnvelope> => {
    const current = await build(db);
    const prev = baseline ?? emptySnapshotPayload();
    baseline = current;

    // Record the authoritative sim time so a later pause/speed POST can push an
    // immediate envelope at the right clock anchor (controller.getLastSimMs()).
    speedController.noteSimMs(simMs);

    const diff: TickPayload = diffTick(prev, current);
    // VIZ-13 / VIZ-14: attach the tick's transient induction + delivery events
    // onto the delta when present — never persisted, never on a snapshot (the
    // Pitfall-7 guard: these fields exist ONLY on a TickPayload).
    const withInduction: TickPayload =
      inductionEvents !== undefined && inductionEvents.length > 0
        ? { ...diff, inductionEvents }
        : diff;
    const delta: TickPayload =
      deliveryEvents !== undefined && deliveryEvents.length > 0
        ? { ...withInduction, deliveryEvents }
        : withInduction;
    seq += 1;
    const envelope: WsEnvelope = {
      v: 1,
      type: "tick",
      seq,
      simMs,
      // CONT-03: derived from the virtual-clock simMs (never Date.now()).
      simDay: deriveSimDay(simMs),
      speed: currentSpeed(),
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
    trailerStops: [],
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
