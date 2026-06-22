import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * FND-06 read model: a trailer's current state and assignment.
 *
 * "What's on trailer T / where is it?" is answered by folding a trailer's
 * lifecycle events into one current row per trailer:
 *
 *   { trailerId, status, currentHubId|null, tripId|null, dockDoorId|null,
 *     assignedPackageIds, lastEventAt }
 *
 * Status transitions (Phase-1 trailer lifecycle):
 *   TrailerDeparted     -> "in_transit"  (left a hub on a trip; carries packages)
 *   TrailerArrivedAtHub -> "arrived"     (reached the next hub on the trip)
 *   TrailerDocked       -> "docked"      (pulled into a dock door at the hub)
 *
 * `assignedPackageIds` is the manifest captured at departure (the packages the
 * trailer carries for that trip). It is sorted by id so serialization is
 * order-stable regardless of the order ids arrived in the payload (P3).
 *
 * Purity (P3): all time comes from `occurredAt`; no wall clock, no RNG, no
 * order-dependent logic. Identical event sequence -> identical state.
 */

/** A trailer's lifecycle status in Phase-1. */
export type TrailerStatus = "in_transit" | "arrived" | "docked";

/** One trailer's current-state row (FND-06). */
export interface TrailerState {
  readonly trailerId: string;
  readonly status: TrailerStatus;
  /** Hub the trailer is currently at; `null` while in transit. */
  readonly currentHubId: string | null;
  /** The trip the trailer is currently serving; `null` if none active. */
  readonly tripId: string | null;
  /** The dock door the trailer is at; `null` unless docked. */
  readonly dockDoorId: string | null;
  /** Packages assigned to the trailer for the active trip, sorted by id. */
  readonly assignedPackageIds: readonly string[];
  /** Domain time of the latest event applied (`occurredAt`), ISO-8601. */
  readonly lastEventAt: string;
}

/**
 * The trailer-state read model: a map keyed by `trailerId`. Iteration order is
 * never relied upon for correctness (serializer/DB sort by `trailerId`).
 */
export type TrailerStateMap = ReadonlyMap<string, TrailerState>;

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyTrailerStateMap: TrailerStateMap = new Map();

/** Total, stable string comparator (code-unit order) — locale-independent (P3). */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Pure reducer for FND-06. Folds one event into the trailer-state map. */
export function trailerStateReducer(
  state: TrailerStateMap,
  { event, occurredAt }: OccurredEvent,
): TrailerStateMap {
  switch (event.type) {
    case "TrailerDeparted": {
      const next = new Map(state);
      next.set(event.payload.trailerId, {
        trailerId: event.payload.trailerId,
        status: "in_transit",
        currentHubId: null,
        tripId: event.payload.tripId,
        dockDoorId: null,
        assignedPackageIds: [...event.payload.packageIds].sort(compareIds),
        lastEventAt: occurredAt,
      });
      return next;
    }
    case "TrailerArrivedAtHub": {
      const next = new Map(state);
      const prior = state.get(event.payload.trailerId);
      next.set(event.payload.trailerId, {
        trailerId: event.payload.trailerId,
        status: "arrived",
        currentHubId: event.payload.hubId,
        tripId: event.payload.tripId,
        dockDoorId: null,
        // Manifest carries over from the trip the trailer is completing.
        assignedPackageIds: prior?.assignedPackageIds ?? [],
        lastEventAt: occurredAt,
      });
      return next;
    }
    case "TrailerDocked": {
      const next = new Map(state);
      const prior = state.get(event.payload.trailerId);
      next.set(event.payload.trailerId, {
        trailerId: event.payload.trailerId,
        status: "docked",
        currentHubId: event.payload.hubId,
        tripId: prior?.tripId ?? null,
        dockDoorId: event.payload.dockDoorId,
        assignedPackageIds: prior?.assignedPackageIds ?? [],
        lastEventAt: occurredAt,
      });
      return next;
    }
    // Phase-3 RFID/detection events are no-ops for trailer state — observed
    // evidence is projected separately (later Phase-3 plans), keeping the
    // scan-driven trailer read model independent of RFID fusion (anti-P6).
    // Phase-4 plan-lifecycle events (PlanGenerated/PlanAccepted, OPT-04) are
    // optimizer concerns with no physical trailer-state change, so they no-op.
    // Phase-9 (v1.2) driver-lifecycle + load/unload phase events likewise no-op
    // for trailer-state in this phase (driver↔trailer stamping is a later phase).
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
    case "PackageScanned":
    case "PackageArrivedAtHub":
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
      return state;
    default:
      return assertNeverEvent(event);
  }
}
