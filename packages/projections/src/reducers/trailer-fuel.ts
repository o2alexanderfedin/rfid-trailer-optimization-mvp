import type { LonLat } from "@mm/domain";
import { type OccurredEvent, assertNeverEvent } from "./reducer.js";
import { legKey } from "./geo-track.js";

/**
 * SP2 (spec §6/§7) read model: a trailer's `milesSinceRefuel` for the planning
 * twin. The twin-snapshot builder reads it into `TwinTrailer.milesSinceRefuel` so
 * the optimizer is FUEL-AWARE (it folds the expected refuel time into leg timing
 * when a planned route would cross the refuel threshold).
 *
 * Fold rules (spec §6):
 *  - `RouteRegistered` : index the leg geometry (keyed by the directed hub pair),
 *    so the leg distance is derived from the SAME logged geometry the sim +
 *    optimizer use (DRY).
 *  - `TrailerDeparted` : record the trip's ACTUAL leg so the matching arrival
 *    resolves the right leg distance (mirrors the geo-track M-4 in-flight index).
 *  - `TrailerArrivedAtHub` : the trip's leg is complete → accrue its miles onto
 *    the trailer's odometer (`+= legMiles`), then drop the in-flight entry.
 *  - `TruckRefueled` : reset the trailer's odometer to 0.
 *
 * Purity (P3): all distance comes from logged geometry, no wall clock, no RNG, no
 * iteration-order dependence — so a rebuild-from-`global_seq=0` fold is
 * byte-identical to the live fold (FND-04). All distances are MILES.
 */

/** Degrees → radians. */
const DEG = Math.PI / 180;
/** Mean Earth radius (km), WGS84 — the haversine sphere radius (matches @mm/domain). */
const EARTH_RADIUS_KM = 6371.0088;
/** Kilometres → statute miles. */
const KM_TO_MILES = 0.621_371;

/** Great-circle (haversine) miles between two `[lon, lat]` points. Pure, symmetric. */
function haversineMiles(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  return km * KM_TO_MILES;
}

/** Total polyline length in miles (sum of consecutive-vertex haversine miles). */
export function geometryMiles(geometry: readonly LonLat[]): number {
  let miles = 0;
  for (let i = 1; i < geometry.length; i += 1) {
    miles += haversineMiles(geometry[i - 1]!, geometry[i]!);
  }
  return miles;
}

/** One trailer's fuel state for the twin. */
export interface TrailerFuel {
  readonly trailerId: string;
  /** Cumulative miles since the trailer's last refuel (≥ 0). Resets on TruckRefueled. */
  readonly milesSinceRefuel: number;
}

/**
 * The trailer-fuel read model + the internal fold indices (route geometry +
 * in-flight trip leg). Carried together so the reducer stays a pure
 * `(state, event) => state` function; the snapshot builder reads `fuel`.
 */
export interface TrailerFuelState {
  /** Per-trailer odometer (miles since last refuel). */
  readonly fuel: ReadonlyMap<string, TrailerFuel>;
  /** Route geometry index, keyed by the directed hub pair `from->to`. */
  readonly routes: ReadonlyMap<string, readonly LonLat[]>;
  /** In-flight trip → its leg key, so the arrival accrues the right distance (M-4). */
  readonly inflight: ReadonlyMap<string, string>;
  /** Convenience size accessor mirroring a Map (so tests can read `.size`). */
  readonly size: number;
}

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyTrailerFuelState: TrailerFuelState = {
  fuel: new Map(),
  routes: new Map(),
  inflight: new Map(),
  size: 0,
};

/** Rebuild the immutable state snapshot from its parts (keeps `size` in sync). */
function withFuel(
  fuel: ReadonlyMap<string, TrailerFuel>,
  routes: ReadonlyMap<string, readonly LonLat[]>,
  inflight: ReadonlyMap<string, string>,
): TrailerFuelState {
  return { fuel, routes, inflight, size: fuel.size };
}

/** Read a trailer's milesSinceRefuel via the state (Map-like `.get`). */
export function getTrailerMiles(state: TrailerFuelState, trailerId: string): number {
  return state.fuel.get(trailerId)?.milesSinceRefuel ?? 0;
}

/**
 * Pure reducer for the trailer-fuel read model. Folds ONE event into the
 * per-trailer odometer + the internal geometry/in-flight indices.
 */
export function trailerFuelReducer(
  state: TrailerFuelState,
  { event }: OccurredEvent,
): TrailerFuelState {
  switch (event.type) {
    case "RouteRegistered": {
      const routes = new Map(state.routes);
      routes.set(legKey(event.payload.fromHubId, event.payload.toHubId), event.payload.geometry);
      return withFuel(state.fuel, routes, state.inflight);
    }
    case "TrailerDeparted": {
      const inflight = new Map(state.inflight);
      inflight.set(event.payload.tripId, legKey(event.payload.fromHubId, event.payload.toHubId));
      return withFuel(state.fuel, state.routes, inflight);
    }
    case "TrailerArrivedAtHub": {
      const key = state.inflight.get(event.payload.tripId);
      const inflight = new Map(state.inflight);
      inflight.delete(event.payload.tripId);
      const geom = key === undefined ? undefined : state.routes.get(key);
      const legMiles = geom === undefined ? 0 : geometryMiles(geom);
      const fuel = new Map(state.fuel);
      const prior = fuel.get(event.payload.trailerId)?.milesSinceRefuel ?? 0;
      fuel.set(event.payload.trailerId, {
        trailerId: event.payload.trailerId,
        milesSinceRefuel: prior + legMiles,
      });
      return withFuel(fuel, state.routes, inflight);
    }
    case "TruckRefueled": {
      const fuel = new Map(state.fuel);
      fuel.set(event.payload.trailerId, {
        trailerId: event.payload.trailerId,
        milesSinceRefuel: 0,
      });
      return withFuel(fuel, state.routes, state.inflight);
    }
    // No fuel-state change for every other event (packages, docks, RFID, plan
    // lifecycle, driver lifecycle, load/unload phases, TruckRested). The closed
    // switch + assertNeverEvent makes adding a new event a compile error here.
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
    case "TruckRested":
    case "PackageInducted": // v2.0 IND-01: external induction is a no-op here
    case "PlanSuperseded": // FLOW-04: supersession is a hub-inventory-only concern
      return state;
    default:
      return assertNeverEvent(event);
  }
}
