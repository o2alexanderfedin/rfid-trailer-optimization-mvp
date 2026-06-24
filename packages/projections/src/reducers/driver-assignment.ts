import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * PRJ-02 read model: the driver↔trip/trailer assignment, one row per driver.
 *
 * The hub-detail panel (Phase 14) needs "which driver is on which trailer/trip,
 * and at which hub" without joining across the driver-status and trailer-state
 * tables. This projection folds the driver-lifecycle events into one assignment
 * row per driver — a sibling of {@link driverStatusReducer} that additionally
 * carries the `trailerId` (which the status row does not track):
 *
 *   { driverId, tripId|null, trailerId|null, hubId|null, lastEventAt }
 *
 * Event handling:
 *   DriverRegistered      -> free row at the home hub (no trip/trailer)
 *   DriverAssignedToTrip  -> bind trip + trailer
 *   DriverSwappedAtHub    -> bind trip + trailer to the INCOMING driver at the
 *                            swap hub; RELEASE the OUTGOING driver from the trip
 *   DriverDutyStateChanged-> no assignment change (a duty transition only)
 *
 * Purity (P3): all time comes from `occurredAt`; no wall clock, no RNG, no
 * order-dependent logic. Identical event sequence -> identical state.
 */

/** One driver's current trip/trailer assignment (PRJ-02). */
export interface DriverAssignment {
  readonly driverId: string;
  /** The trip the driver is bound to; `null` when free. */
  readonly tripId: string | null;
  /** The trailer the driver is bound to; `null` when free. */
  readonly trailerId: string | null;
  /** The hub the driver is currently at (home hub at registration / swap hub). */
  readonly hubId: string | null;
  /** Domain time of the latest event applied (`occurredAt`), ISO-8601. */
  readonly lastEventAt: string;
}

/** The driver-assignment read model: a map keyed by `driverId`. */
export type DriverAssignmentState = ReadonlyMap<string, DriverAssignment>;

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyDriverAssignmentState: DriverAssignmentState = new Map();

/** Pure reducer for PRJ-02. Folds one event into the driver-assignment map. */
export function driverAssignmentReducer(
  state: DriverAssignmentState,
  { event, occurredAt }: OccurredEvent,
): DriverAssignmentState {
  switch (event.type) {
    case "DriverRegistered": {
      const next = new Map(state);
      next.set(event.payload.driverId, {
        driverId: event.payload.driverId,
        tripId: null,
        trailerId: null,
        hubId: event.payload.homeHubId,
        lastEventAt: occurredAt,
      });
      return next;
    }
    case "DriverAssignedToTrip": {
      const next = new Map(state);
      const prior = state.get(event.payload.driverId);
      next.set(event.payload.driverId, {
        driverId: event.payload.driverId,
        tripId: event.payload.tripId,
        trailerId: event.payload.trailerId,
        hubId: prior?.hubId ?? null,
        lastEventAt: occurredAt,
      });
      return next;
    }
    case "DriverSwappedAtHub": {
      const next = new Map(state);
      // The relay handoff: the incoming driver takes the trip + trailer at the
      // swap hub; the outgoing driver is released from the trip/trailer.
      next.set(event.payload.incomingDriverId, {
        driverId: event.payload.incomingDriverId,
        tripId: event.payload.tripId,
        trailerId: event.payload.trailerId,
        hubId: event.payload.hubId,
        lastEventAt: occurredAt,
      });
      next.set(event.payload.outgoingDriverId, {
        driverId: event.payload.outgoingDriverId,
        tripId: null,
        trailerId: null,
        hubId: event.payload.hubId,
        lastEventAt: occurredAt,
      });
      return next;
    }
    // A duty-state transition does not change the trip/trailer assignment, and
    // every non-driver event is irrelevant to this projection — all no-op.
    case "DriverDutyStateChanged":
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TrailerDocked":
    case "RfidObserved":
    case "WrongTrailerDetected":
    case "MissedUnloadDetected":
    case "PlanGenerated":
    case "PlanAccepted":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
    case "TruckRested":
    case "TruckRefueled":
      return state;
    default:
      return assertNeverEvent(event);
  }
}
