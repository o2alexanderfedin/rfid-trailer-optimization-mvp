import { isoToEpochMinutes } from "@mm/domain";
import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * PERF-02 (IND-03): per-package SLA induction deadline, folded incrementally
 * from `PackageInducted` events (last-write-wins keyed by `packageId`).
 *
 * Previously `buildInductionDeadlines` in `twin-snapshot.ts` scanned the
 * ENTIRE event log on every optimizer epoch — O(events) per epoch, growing
 * without bound. This reducer persists the same LWW map to
 * `induction_deadline(package_id PK, deadline_min INTEGER)` so twin-snapshot
 * reads it as a single bounded `SELECT * FROM induction_deadline` instead of a
 * full `readAll(0n)` scan.
 *
 * State: `Map<packageId, deadlineMin>` — epoch-minutes (the same integer unit
 * the optimizer's `TwinBlock.deadlineMin` carries, computed by
 * `isoToEpochMinutes` from `@mm/domain`).
 *
 * Fold rules:
 *  - `PackageInducted` : set `packageId → isoToEpochMinutes(slaDeadlineIso)`
 *    (last-write-wins; the same LWW the old log-scan used for duplicate ids).
 *  - Every other event type : no-op (return the same reference).
 *
 * Purity (P3): pure `(state, event) => state`; no clock reads, no RNG, no
 * iteration-order dependence — so a rebuild-from-`global_seq=0` fold is
 * byte-identical to the live fold (FND-04). The closed switch + `assertNeverEvent`
 * ensures adding a new event type is a compile error.
 */

/** The induction-deadline read model: packageId → epoch-minutes (LWW). */
export type InductionDeadlineState = ReadonlyMap<string, number>;

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyInductionDeadlineState: InductionDeadlineState = new Map();

/**
 * Pure reducer for the induction-deadline read model. Folds ONE event into
 * the per-package deadline map (LWW semantics on `PackageInducted`).
 */
export function inductionDeadlineReducer(
  state: InductionDeadlineState,
  { event }: OccurredEvent,
): InductionDeadlineState {
  switch (event.type) {
    case "PackageInducted": {
      const next = new Map(state);
      next.set(event.payload.packageId, isoToEpochMinutes(event.payload.slaDeadlineIso));
      return next;
    }
    // No deadline change for every other event type. The closed switch +
    // assertNeverEvent makes adding a new event type a compile error here.
    case "HubRegistered":
    case "RouteRegistered":
    case "PackageCreated":
    case "PackageScanned":
    case "PackageArrivedAtHub":
    case "TrailerDocked":
    case "TrailerDeparted":
    case "TrailerArrivedAtHub":
    case "TruckRefueled":
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
    case "PlanSuperseded": // FLOW-04: supersession is a hub-inventory-only concern
    case "PackageDelivered": // Phase-22 OUT-01: terminal delivery; the deadline row stays (the optimizer may still read it)
    case "TrailerDiverted": // Phase-24 OODA-01: diversion does not change deadlines
    case "ActionSuggested": // Phase-25 COORD-02: advisory suggestion events do not change deadlines
    case "SuggestionAccepted":
    case "SuggestionRejected":
      return state; // same reference → applier detects no-op via id === state
    default:
      return assertNeverEvent(event);
  }
}
