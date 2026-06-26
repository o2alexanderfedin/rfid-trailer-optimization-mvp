import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * FND-06 read model: a trailer's current state and assignment.
 *
 * "What's on trailer T / where is it?" is answered by folding a trailer's
 * lifecycle events into one current row per trailer:
 *
 *   { trailerId, status, currentHubId|null, tripId|null, dockDoorId|null,
 *     assignedPackageIds, driverId|null, lastEventAt }
 *
 * Status transitions (Phase-1 trailer lifecycle):
 *   TrailerDeparted     -> "in_transit"  (left a hub on a trip; carries packages)
 *   TrailerArrivedAtHub -> "arrived"     (reached the next hub on the trip)
 *   TrailerDocked       -> "docked"      (pulled into a dock door at the hub)
 *
 * Driver stamping (PRJ-02, v1.2): `driverId` is the driver currently bound to the
 * trailer's trip, stamped from `DriverAssignedToTrip` and re-stamped on a
 * `DriverSwappedAtHub` relay handoff (incoming driver). This makes the assigned
 * driver queryable join-free for the hub-detail panel; it carries across the
 * later lifecycle events and is `null` until a driver is assigned.
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
  /** The driver currently bound to the trailer's trip (PRJ-02); `null` if none. */
  readonly driverId: string | null;
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
      const prior = state.get(event.payload.trailerId);
      next.set(event.payload.trailerId, {
        trailerId: event.payload.trailerId,
        status: "in_transit",
        currentHubId: null,
        tripId: event.payload.tripId,
        dockDoorId: null,
        assignedPackageIds: [...event.payload.packageIds].sort(compareIds),
        // The driver assignment (if any) carries with the trailer's trip.
        driverId: prior?.driverId ?? null,
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
        driverId: prior?.driverId ?? null,
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
        driverId: prior?.driverId ?? null,
        lastEventAt: occurredAt,
      });
      return next;
    }
    // PRJ-02 (v1.2): stamp the assigned driver onto the trailer row so the
    // hub-detail panel can read "who is driving trailer T" join-free. A trailer
    // row may not exist yet (assignment can precede the first lifecycle event),
    // so create a minimal one when absent (status defaults to in_transit — a
    // driver is assigned at dispatch).
    case "DriverAssignedToTrip": {
      const next = new Map(state);
      const prior = state.get(event.payload.trailerId);
      next.set(event.payload.trailerId, {
        trailerId: event.payload.trailerId,
        status: prior?.status ?? "in_transit",
        currentHubId: prior?.currentHubId ?? null,
        tripId: prior?.tripId ?? event.payload.tripId,
        dockDoorId: prior?.dockDoorId ?? null,
        assignedPackageIds: prior?.assignedPackageIds ?? [],
        driverId: event.payload.driverId,
        lastEventAt: occurredAt,
      });
      return next;
    }
    case "DriverSwappedAtHub": {
      const next = new Map(state);
      const prior = state.get(event.payload.trailerId);
      // A relay handoff re-stamps the trailer with the FRESH incoming driver.
      next.set(event.payload.trailerId, {
        trailerId: event.payload.trailerId,
        status: prior?.status ?? "arrived",
        currentHubId: prior?.currentHubId ?? event.payload.hubId,
        tripId: prior?.tripId ?? event.payload.tripId,
        dockDoorId: prior?.dockDoorId ?? null,
        assignedPackageIds: prior?.assignedPackageIds ?? [],
        driverId: event.payload.incomingDriverId,
        lastEventAt: occurredAt,
      });
      return next;
    }
    // Phase-3 RFID/detection events are no-ops for trailer state — observed
    // evidence is projected separately (later Phase-3 plans), keeping the
    // scan-driven trailer read model independent of RFID fusion (anti-P6).
    // Phase-4 plan-lifecycle events (PlanGenerated/PlanAccepted, OPT-04) are
    // optimizer concerns with no physical trailer-state change, so they no-op.
    // Phase-9 (v1.2) `DriverAssignedToTrip` / `DriverSwappedAtHub` are handled
    // ABOVE (driver↔trailer stamping, PRJ-02). The remaining driver-lifecycle +
    // load/unload phase events do not change trailer state, so they no-op.
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
    case "DriverDutyStateChanged":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
    case "TruckRested":
    case "TruckRefueled":
    case "PackageInducted": // v2.0 IND-01: external induction is a no-op here
    case "PlanSuperseded": // FLOW-04: supersession is a hub-inventory-only concern
    case "PackageDelivered": // Phase-22 OUT-01: terminal delivery is package-only, not a trailer-state concern
    case "TrailerDiverted": // Phase-24 OODA-01: a re-route does not change current-hub trailer state (no-op until 24-02 wires it)
    // Phase-25 COORD-02: advisory suggestion events do not change trailer state.
    case "ActionSuggested":
    case "SuggestionAccepted":
    case "SuggestionRejected":
      return state;
    default:
      return assertNeverEvent(event);
  }
}
