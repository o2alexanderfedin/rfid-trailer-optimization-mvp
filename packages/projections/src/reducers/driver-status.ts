import {
  DEFAULT_HOS_CONFIG,
  type DutyStatus,
  type HosClock,
  epochMinutesToIso,
  isoToEpochMinutes,
  remainingLegalDriveMinutes,
} from "@mm/domain";
import { type OccurredEvent, assertNeverEvent } from "./reducer.js";

/**
 * PRJ-01 read model: a driver's current duty status + Hours-of-Service summary.
 *
 * "What is driver D doing / how much legal drive time is left?" is answered by
 * folding a driver's lifecycle events into ONE current row per driver — the
 * direct analog of {@link trailerStateReducer} (one-row-per-entity):
 *
 *   { driverId, status, remainingDriveMinutes, dutyWindowDeadline,
 *     totalDrivenMinutes, weeklyOnDutyMin, currentHubId, currentTripId,
 *     lastEventAt }
 *
 * Event handling (Phase-9 driver lifecycle):
 *   DriverRegistered      -> create row, status "off_duty", currentHubId=homeHubId
 *   DriverAssignedToTrip  -> bind currentTripId (+ trailer via trailer_state)
 *   DriverDutyStateChanged-> set status + derive the HOS-clock fields (below)
 *   DriverSwappedAtHub    -> move the trip to the incoming driver at the swap hub,
 *                            release the outgoing driver from the trip
 *
 * HOS derivation (REUSE, never reimplement): `DriverDutyStateChanged` carries a
 * SNAPSHOT of the driver's {@link HosClock}. `remainingDriveMinutes` and
 * `dutyWindowDeadline` are computed from that snapshot with the Phase-10
 * `@mm/domain` engine (`remainingLegalDriveMinutes` + the absolute-deadline
 * formula). `now` is read from the event `occurredAt` — never the wall clock —
 * so the 14h ELAPSED-wall-clock window is evaluated exactly at the transition.
 *
 * Purity (P3): all time comes from `occurredAt` / the carried clock snapshot; no
 * wall clock, no RNG, no order-dependent logic. Identical event sequence ->
 * identical state. Iteration order is never relied upon (the serializer / DB
 * sort by `driverId`).
 */

/** One driver's current-state row (PRJ-01). */
export interface DriverStatus {
  readonly driverId: string;
  /** The FMCSA four-state duty status; `off_duty` at registration. */
  readonly status: DutyStatus;
  /**
   * Headline remaining legal drive minutes (HOS-03), clamped >= 0. Known only
   * once a `DriverDutyStateChanged` has carried an {@link HosClock} snapshot;
   * `0` before the first duty transition.
   */
  readonly remainingDriveMinutes: number;
  /**
   * The 14h ABSOLUTE on-duty window deadline as an ISO stamp
   * (`clock.dutyWindowStartAt + dutyWindowMin`); `null` before the first duty
   * transition carries a clock.
   */
  readonly dutyWindowDeadline: string | null;
  /** Minutes DRIVEN this shift (`clock.driveTodayMin`); `0` pre-duty-transition. */
  readonly totalDrivenMinutes: number;
  /** Rolling 70h/8-day ON-DUTY minutes (`clock.weeklyOnDutyMin`); `0` pre-duty. */
  readonly weeklyOnDutyMin: number;
  /**
   * OPT-HOS-02 — the FULL per-shift {@link HosClock} snapshot carried by the last
   * `DriverDutyStateChanged` (DRV-02), persisted verbatim so the rolling optimizer's
   * HARD HOS gate can re-walk every driving leg through the Phase-10 engine. The
   * derived `remainingDriveMinutes` / `totalDrivenMinutes` are summaries OF this
   * clock; the gate needs the whole clock (driving/break/weekly/sleeper
   * accumulators), so it is stored alongside them. `null` before the first duty
   * transition carries a clock (the same point `dutyWindowDeadline` is null).
   */
  readonly hosClock: HosClock | null;
  /** Hub the driver is currently at; the home hub at registration / swap hub. */
  readonly currentHubId: string | null;
  /** The trip the driver is currently bound to; `null` if free. */
  readonly currentTripId: string | null;
  /** Domain time of the latest event applied (`occurredAt`), ISO-8601. */
  readonly lastEventAt: string;
}

/**
 * The driver-status read model: a map keyed by `driverId`. Iteration order is
 * never relied upon for correctness (serializer / DB sort by `driverId`).
 */
export type DriverStatusState = ReadonlyMap<string, DriverStatus>;

/** The empty starting state for a fresh fold or rebuild-from-zero. */
export const emptyDriverStatusState: DriverStatusState = new Map();

/**
 * The 14h ABSOLUTE deadline ISO from an {@link HosClock}:
 * `dutyWindowStartAt + dutyWindowMin`. The window is ELAPSED wall-clock, so this
 * is a fixed instant (NOT a pausing counter) — matching the Phase-10 engine.
 */
function deadlineIso(clock: HosClock): string {
  return epochMinutesToIso(
    isoToEpochMinutes(clock.dutyWindowStartAt) + DEFAULT_HOS_CONFIG.dutyWindowMin,
  );
}

/** Pure reducer for PRJ-01. Folds one event into the driver-status map. */
export function driverStatusReducer(
  state: DriverStatusState,
  { event, occurredAt }: OccurredEvent,
): DriverStatusState {
  switch (event.type) {
    case "DriverRegistered": {
      const next = new Map(state);
      next.set(event.payload.driverId, {
        driverId: event.payload.driverId,
        status: "off_duty",
        remainingDriveMinutes: 0,
        dutyWindowDeadline: null,
        totalDrivenMinutes: 0,
        weeklyOnDutyMin: 0,
        hosClock: null,
        currentHubId: event.payload.homeHubId,
        currentTripId: null,
        lastEventAt: occurredAt,
      });
      return next;
    }
    case "DriverAssignedToTrip": {
      const next = new Map(state);
      const prior = state.get(event.payload.driverId);
      next.set(event.payload.driverId, {
        driverId: event.payload.driverId,
        status: prior?.status ?? "off_duty",
        remainingDriveMinutes: prior?.remainingDriveMinutes ?? 0,
        dutyWindowDeadline: prior?.dutyWindowDeadline ?? null,
        totalDrivenMinutes: prior?.totalDrivenMinutes ?? 0,
        weeklyOnDutyMin: prior?.weeklyOnDutyMin ?? 0,
        hosClock: prior?.hosClock ?? null,
        currentHubId: prior?.currentHubId ?? null,
        currentTripId: event.payload.tripId,
        lastEventAt: occurredAt,
      });
      return next;
    }
    case "DriverDutyStateChanged": {
      const next = new Map(state);
      const prior = state.get(event.payload.driverId);
      const clock = event.payload.clock;
      next.set(event.payload.driverId, {
        driverId: event.payload.driverId,
        status: event.payload.dutyStatus,
        // Derive the headline HOS numbers from the carried clock snapshot via
        // the Phase-10 engine (reuse). `now` = the transition's occurredAt.
        remainingDriveMinutes: remainingLegalDriveMinutes(
          clock,
          DEFAULT_HOS_CONFIG,
          isoToEpochMinutes(occurredAt),
        ),
        dutyWindowDeadline: deadlineIso(clock),
        totalDrivenMinutes: clock.driveTodayMin,
        weeklyOnDutyMin: clock.weeklyOnDutyMin,
        // OPT-HOS-02: persist the FULL clock the hard gate re-walks (not just the
        // derived summaries above). The reducer reads it verbatim from the event.
        hosClock: clock,
        currentHubId: prior?.currentHubId ?? null,
        currentTripId: prior?.currentTripId ?? null,
        lastEventAt: occurredAt,
      });
      return next;
    }
    case "DriverSwappedAtHub": {
      const next = new Map(state);
      const incoming = state.get(event.payload.incomingDriverId);
      const outgoing = state.get(event.payload.outgoingDriverId);
      // The relay handoff: the trip moves to the FRESH incoming driver at the
      // swap hub; the depleted outgoing driver is RELEASED from the trip (it
      // enters RESTING via a paired DriverDutyStateChanged the sim emits).
      next.set(event.payload.incomingDriverId, {
        driverId: event.payload.incomingDriverId,
        status: incoming?.status ?? "off_duty",
        remainingDriveMinutes: incoming?.remainingDriveMinutes ?? 0,
        dutyWindowDeadline: incoming?.dutyWindowDeadline ?? null,
        totalDrivenMinutes: incoming?.totalDrivenMinutes ?? 0,
        weeklyOnDutyMin: incoming?.weeklyOnDutyMin ?? 0,
        hosClock: incoming?.hosClock ?? null,
        currentHubId: event.payload.hubId,
        currentTripId: event.payload.tripId,
        lastEventAt: occurredAt,
      });
      next.set(event.payload.outgoingDriverId, {
        driverId: event.payload.outgoingDriverId,
        status: outgoing?.status ?? "off_duty",
        remainingDriveMinutes: outgoing?.remainingDriveMinutes ?? 0,
        dutyWindowDeadline: outgoing?.dutyWindowDeadline ?? null,
        totalDrivenMinutes: outgoing?.totalDrivenMinutes ?? 0,
        weeklyOnDutyMin: outgoing?.weeklyOnDutyMin ?? 0,
        hosClock: outgoing?.hosClock ?? null,
        currentHubId: event.payload.hubId,
        currentTripId: null,
        lastEventAt: occurredAt,
      });
      return next;
    }
    // Every other domain event is a no-op for driver status — it tracks ONLY the
    // driver lifecycle. Trailer/package/plan/RFID/phase events do not change a
    // driver's duty state, so they leave the state reference untouched (P3).
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
    case "PackageInducted": // v2.0 IND-01: external induction is a no-op here
    case "PlanSuperseded": // FLOW-04: supersession is a hub-inventory-only concern
    case "PackageDelivered": // Phase-22 OUT-01: terminal delivery is package-only, not a driver concern
      return state;
    default:
      return assertNeverEvent(event);
  }
}
