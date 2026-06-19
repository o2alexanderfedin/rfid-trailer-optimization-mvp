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

/** Which end of a leg a keyframe marks. */
export type GeoKeyframeKind = "depart" | "arrive";

/** One trailer-position keyframe along a trip's route geometry. */
export interface GeoKeyframe {
  readonly trailerId: string;
  readonly tripId: string;
  readonly kind: GeoKeyframeKind;
  /** Domain time of the keyframe (ISO-8601) — when the trailer was at this point. */
  readonly t: string;
  readonly lon: number;
  readonly lat: number;
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
  readonly inflight: ReadonlyMap<string, string>;
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
      // Record the trip's ACTUAL leg so the matching arrival resolves it exactly
      // (M-4) — never by a lexicographic guess over all legs into the hub.
      const inflight = new Map(state.inflight);
      inflight.set(event.payload.tripId, key);
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
      const key = state.inflight.get(event.payload.tripId);
      const inflight = new Map(state.inflight);
      inflight.delete(event.payload.tripId);
      const nextState = { ...state, inflight };

      const geom = key === undefined ? undefined : state.routes.get(key);
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
    // No geometry change. Plan-lifecycle events (PlanGenerated/PlanAccepted,
    // OPT-04) carry no position, so they produce no keyframe.
    case "HubRegistered":
    case "PackageCreated":
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerDocked":
    case "PlanGenerated":
    case "PlanAccepted":
      return { state, keyframes: [] };
    default:
      return assertNeverGeo(event);
  }
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
