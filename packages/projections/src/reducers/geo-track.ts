import type { LonLat } from "@mm/domain";
import type { StoredEventLike } from "./audit-timeline.js";

/**
 * Geo-track read model (catch-up / async): per-trailer-trip position keyframes
 * along the route geometry, for the live map (ARCHITECTURE "Realtime Map Geo
 * Data Flow"). It is deliberately SEPARATED from the operational twin: the map's
 * needs (positions over time + route LineStrings) differ from "current state"
 * queries and have a different write cadence.
 *
 * Keyframes (not per-second positions): the server stores, per trip, the
 * endpoints the trailer is known to be at —
 *   - on `TrailerDeparted`     : a `depart` keyframe at the route ORIGIN
 *     (`fromHubId` -> `toHubId` geometry, first vertex);
 *   - on `TrailerArrivedAtHub` : an `arrive` keyframe at the route DESTINATION
 *     (last vertex of the same leg geometry).
 * The client tweens between them along the LineString (no per-second push,
 * ARCHITECTURE Anti-Pattern 4).
 *
 * Determinism (P3): every coordinate comes from the `RouteRegistered` geometry
 * already in the log; every time comes from the event's `occurredAt`. No wall
 * clock, no RNG. The reducer carries an internal route index (hub-pair ->
 * geometry) folded as it sees `RouteRegistered`, so a single pass over the log
 * in `global_seq` order produces deterministic keyframes — and a rebuild from
 * `global_seq=0` produces byte-identical keyframes.
 *
 * Idempotency (P5a): each keyframe's identity is `(trailerId, tripId, kind)`
 * (one trip has one depart + one arrive). Re-applying the same stored event is a
 * keyed upsert onto the SAME row — a strict no-op.
 */

/**
 * Which point of a trip a keyframe marks. `depart`/`arrive` are the leg endpoints;
 * SP2 adds `rested`/`refueling` MID-LEG stop keyframes at interpolated positions
 * (spec §6).
 */
export type GeoKeyframeKind = "depart" | "arrive" | "rested" | "refueling";

/** One trailer-position keyframe along a trip's route geometry. */
export interface GeoKeyframe {
  readonly trailerId: string;
  readonly tripId: string;
  readonly kind: GeoKeyframeKind;
  /** Domain time of the keyframe (ISO-8601) — when the trailer was at this point. */
  readonly t: string;
  readonly lon: number;
  readonly lat: number;
  /**
   * SP2 (spec §6): for a `rested`/`refueling` STOP keyframe, how long (whole
   * minutes) the trailer parks here — the client holds the marker stationary for
   * this duration before resuming the tween. `undefined` for `depart`/`arrive`
   * (additive + back-compat — a leg endpoint has no dwell of its own).
   */
  readonly durationMinutes?: number;
}

/** A trip's in-flight leg context (M-4 + SP2 stop interpolation). */
interface InflightLeg {
  /** Directed hub-pair leg key (`from->to`) for the route geometry lookup. */
  readonly legKey: string;
  /** The `TrailerDeparted` occurredAt (ISO) — the anchor for stop interpolation. */
  readonly departAt: string;
}

/**
 * Internal fold state for geo-track:
 *  - `routes`   : the route geometry index, keyed by the directed hub pair
 *                 `from->to`. Replaced on each `RouteRegistered`.
 *  - `inflight` : the in-flight trip -> leg-key index (M-4). On `TrailerDeparted`
 *                 we record `tripId -> legKey(fromHubId,toHubId)`; on
 *                 `TrailerArrivedAtHub` we look up the trip's ACTUAL leg to place
 *                 the arrival keyframe (never a lexicographic guess), then drop
 *                 the entry. This makes arrival resolution correct when a hub has
 *                 2+ inbound legs with distinct terminal vertices.
 *
 * Both are immutable snapshots replaced on each fold step.
 */
export interface GeoTrackState {
  readonly routes: ReadonlyMap<string, readonly LonLat[]>;
  /**
   * In-flight trip → its leg context (leg key + depart time). The leg key
   * resolves the arrival leg (M-4); the depart time anchors SP2 mid-leg stop
   * interpolation (spec §6).
   */
  readonly inflight: ReadonlyMap<string, InflightLeg>;
}

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyGeoTrackState: GeoTrackState = {
  routes: new Map(),
  inflight: new Map(),
};

/**
 * Directed hub-pair key for the route index. Uses `->` as the separator; hub ids
 * are IATA-style codes (no `->`), so the key is collision-free AND readable. The
 * SAME function is reused by the catch-up runner's persisted route index so the
 * two can never drift on the separator.
 */
export function legKey(fromHubId: string, toHubId: string): string {
  return `${fromHubId}->${toHubId}`;
}

/** The result of folding one stored event: next state + any emitted keyframes. */
export interface GeoTrackStep {
  readonly state: GeoTrackState;
  readonly keyframes: readonly GeoKeyframe[];
}

/**
 * Pure reducer for geo-track. Folds one stored event into the route index and
 * emits the keyframes it implies (0..1 per event). Deterministic: positions come
 * from logged route geometry, time from `occurredAt`.
 */
export function geoTrackReducer(
  state: GeoTrackState,
  stored: StoredEventLike,
): GeoTrackStep {
  const { event, occurredAt } = stored;
  switch (event.type) {
    case "RouteRegistered": {
      const routes = new Map(state.routes);
      routes.set(
        legKey(event.payload.fromHubId, event.payload.toHubId),
        event.payload.geometry,
      );
      return { state: { ...state, routes }, keyframes: [] };
    }
    case "TrailerDeparted": {
      const key = legKey(event.payload.fromHubId, event.payload.toHubId);
      // Record the trip's ACTUAL leg + depart time so (a) the matching arrival
      // resolves the leg exactly (M-4) and (b) SP2 mid-leg stops interpolate
      // against the depart anchor (spec §6).
      const inflight = new Map(state.inflight);
      inflight.set(event.payload.tripId, { legKey: key, departAt: occurredAt });
      const nextState = { ...state, inflight };

      const point = endpoint(state.routes.get(key), "first");
      if (point === null) return { state: nextState, keyframes: [] };
      return {
        state: nextState,
        keyframes: [
          {
            trailerId: event.payload.trailerId,
            tripId: event.payload.tripId,
            kind: "depart",
            t: occurredAt,
            lon: point[0],
            lat: point[1],
          },
        ],
      };
    }
    case "TrailerArrivedAtHub": {
      // Resolve the arrival keyframe from the trip's ACTUAL leg (recorded at
      // departure), taking that leg's terminal vertex — correct even when the
      // arrival hub has 2+ inbound legs with distinct endpoints (M-4). The leg is
      // then dropped from the in-flight index (the trip's leg is complete).
      const leg = state.inflight.get(event.payload.tripId);
      const inflight = new Map(state.inflight);
      inflight.delete(event.payload.tripId);
      const nextState = { ...state, inflight };

      const geom = leg === undefined ? undefined : state.routes.get(leg.legKey);
      const point = endpoint(geom, "last");
      if (point === null) return { state: nextState, keyframes: [] };
      return {
        state: nextState,
        keyframes: [
          {
            trailerId: event.payload.trailerId,
            tripId: event.payload.tripId,
            kind: "arrive",
            t: occurredAt,
            lon: point[0],
            lat: point[1],
          },
        ],
      };
    }
    // SP2 (spec §6): a mid-leg STOP keyframe at the INTERPOLATED route position
    // for the stop's `occurredAt`. The fraction along the in-flight leg is the
    // elapsed (depart→stop) minutes over the leg's NOMINAL transit (derived from
    // the SAME logged geometry the sim/optimizer use), clamped to [0,1]. NO clock,
    // NO RNG — a pure function of the geometry + the two ISO times — so a rebuild
    // is byte-identical. A stop for an unknown/uninflight trip yields no keyframe.
    case "TruckRested":
      return stopKeyframe(state, event.payload.trailerId, event.payload.tripId, "rested", occurredAt, event.payload.durationMin);
    case "TruckRefueled":
      return stopKeyframe(state, event.payload.trailerId, event.payload.tripId, "refueling", occurredAt, event.payload.durationMin);
    // Phase-3 RFID/detection events do not move the map track — handled by the
    // dedicated zone-estimate/exception projections (later Phase-3 plans).
    // Phase-4 plan-lifecycle events (PlanGenerated/PlanAccepted, OPT-04) carry
    // no position, so they produce no keyframe. Phase-9 (v1.2) driver-lifecycle +
    // load/unload phase events carry no map position either, so no keyframe.
    case "HubRegistered":
    case "PackageCreated":
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerDocked":
    case "RfidObserved":
    case "WrongTrailerDetected":
    case "MissedUnloadDetected":
    case "PlanGenerated":
    case "PlanAccepted":
    case "DriverRegistered":
    case "DriverAssignedToTrip":
    case "DriverDutyStateChanged":
    case "DriverSwappedAtHub":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
      return { state, keyframes: [] };
    default:
      return assertNeverGeo(event);
  }
}

/** Mean Earth radius (km), WGS84 — the haversine sphere radius (matches @mm/domain). */
const EARTH_RADIUS_KM = 6371.0088;
/** Degrees → radians. */
const DEG = Math.PI / 180;
/** Average highway HGV cruise speed (km/h) — the SAME constant the sim/optimizer use. */
const HGV_AVG_KMH = 80;

/** Great-circle (haversine) km between two `[lon, lat]` points. */
function haversineKmLonLat(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Per-segment cumulative km along a polyline, plus the total (for fraction → point). */
function cumulativeKm(geometry: readonly LonLat[]): { cum: number[]; total: number } {
  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < geometry.length; i += 1) {
    total += haversineKmLonLat(geometry[i - 1]!, geometry[i]!);
    cum.push(total);
  }
  return { cum, total };
}

/**
 * The `[lon, lat]` point at `fraction` (0..1) of the polyline's total arc length —
 * the geometry-aware analogue of OpenLayers' `LineString.getCoordinateAt`, so the
 * server-computed stop position matches the client tween's positioning model.
 * Pure: a function of the geometry + fraction only.
 */
function pointAtFraction(geometry: readonly LonLat[], fraction: number): LonLat | null {
  if (geometry.length === 0) return null;
  if (geometry.length === 1) return geometry[0]!;
  const f = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  const { cum, total } = cumulativeKm(geometry);
  if (total === 0) return geometry[0]!; // zero-length leg → the origin vertex
  const target = f * total;
  // Find the segment containing `target` (cum is non-decreasing).
  for (let i = 1; i < cum.length; i += 1) {
    if (target <= cum[i]!) {
      const segStart = cum[i - 1]!;
      const segLen = cum[i]! - segStart;
      const t = segLen === 0 ? 0 : (target - segStart) / segLen;
      const p0 = geometry[i - 1]!;
      const p1 = geometry[i]!;
      return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    }
  }
  return geometry[geometry.length - 1]!;
}

/**
 * Build a `rested`/`refueling` STOP keyframe at the interpolated route position for
 * `stopAt`. The fraction is `elapsed(depart→stop) / nominalLegTransitMin`, clamped
 * to [0,1], where the nominal transit is `geometryKm / 80 km/h` (the SAME HGV speed
 * the sim/optimizer derive transit from — DRY). Returns no keyframe when the trip
 * is not in flight or its leg geometry is missing/empty (fail-soft). Pure: no clock,
 * no RNG — a function of the logged geometry + the depart/stop ISO times.
 */
function stopKeyframe(
  state: GeoTrackState,
  trailerId: string,
  tripId: string,
  kind: "rested" | "refueling",
  stopAt: string,
  durationMin: number,
): GeoTrackStep {
  const leg = state.inflight.get(tripId);
  if (leg === undefined) return { state, keyframes: [] };
  const geom = state.routes.get(leg.legKey);
  if (geom === undefined || geom.length === 0) return { state, keyframes: [] };

  const departMs = Date.parse(leg.departAt);
  const stopMs = Date.parse(stopAt);
  const elapsedMin = (stopMs - departMs) / 60_000;
  const { total } = cumulativeKm(geom);
  const nominalTransitMin = total > 0 ? (total / HGV_AVG_KMH) * 60 : 0;
  const fraction = nominalTransitMin > 0 ? elapsedMin / nominalTransitMin : 0;
  const point = pointAtFraction(geom, fraction);
  if (point === null) return { state, keyframes: [] };

  return {
    state,
    keyframes: [
      {
        trailerId,
        tripId,
        kind,
        t: stopAt,
        lon: point[0],
        lat: point[1],
        durationMinutes: durationMin,
      },
    ],
  };
}

/** First/last vertex of a geometry, or `null` if the geometry is missing/empty. */
function endpoint(
  geom: readonly LonLat[] | undefined,
  which: "first" | "last",
): LonLat | null {
  if (geom === undefined || geom.length === 0) return null;
  return which === "first" ? geom[0]! : geom[geom.length - 1]!;
}

function assertNeverGeo(event: never): never {
  throw new Error(
    `Unhandled DomainEvent in geoTrackReducer: ${JSON.stringify(event)}`,
  );
}
