import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * OUT-05 (P2) / D-22-3 — the EVENT-DERIVED delivery KPI read model.
 *
 * The delivered-out count and on-time count are accumulated PER `PackageDelivered`
 * event (monotonic counters), NOT a `COUNT(*)` over the `packageLocation` /
 * `hubInventory` tables — those rows are DELETE-purged on delivery (OUT-04), so a
 * row-count would UNDERCOUNT. This reducer is the SOLE source of truth for the
 * delivered totals; the fact lives in the event log, the aggregate lives here.
 *
 * Purity (PITFALLS P3): a pure function of `(state, event)`. No wall clock, no
 * RNG, no Map-iteration-order dependence — so the live fold and a
 * rebuild-from-zero fold produce identical counters (FND-04).
 */

/** The event-derived delivery KPI counters (D-22-3). */
export interface DeliveryKpiState {
  /** Total `PackageDelivered` events folded (monotonic). */
  readonly deliveredCount: number;
  /** Subset of `deliveredCount` whose `onTime` flag was true (monotonic). */
  readonly onTimeCount: number;
}

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyDeliveryKpiState: DeliveryKpiState = {
  deliveredCount: 0,
  onTimeCount: 0,
};

/**
 * Pure reducer for OUT-05 (D-22-3). Increments `deliveredCount` on every
 * `PackageDelivered` event and `onTimeCount` only when the event's `onTime` flag
 * is true. Every other event type is a no-op (the same state reference returned).
 */
export function deliveryKpiReducer(
  state: DeliveryKpiState,
  { event }: OccurredEvent,
): DeliveryKpiState {
  switch (event.type) {
    case "PackageDelivered":
      // D-22-3: event-derived increment — NEVER a COUNT(*) over the purged tables.
      return {
        deliveredCount: state.deliveredCount + 1,
        onTimeCount: state.onTimeCount + (event.payload.onTime ? 1 : 0),
      };
    // Every other DomainEvent member is a no-op for the delivery KPI. The full
    // enumeration + `default: assertNeverEvent` is the compile gate: a new event
    // member without a case here STOPS COMPILING.
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
    case "DriverRegistered":
    case "DriverAssignedToTrip":
    case "DriverDutyStateChanged":
    case "DriverSwappedAtHub":
    case "UnloadStarted":
    case "LoadStarted":
    case "UnloadCompleted":
    case "TruckRested":
    case "TruckRefueled":
    case "PackageInducted":
    case "PlanSuperseded":
    case "TrailerDiverted": // Phase-24 OODA-01: a re-route is not a delivery-KPI event
    case "ActionSuggested": // Phase-25 COORD-02: advisory suggestion events are not delivery-KPI events
    case "SuggestionAccepted":
    case "SuggestionRejected":
      return state;
    default:
      return assertNeverEvent(event);
  }
}
