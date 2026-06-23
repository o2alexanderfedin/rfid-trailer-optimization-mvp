import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOS_CONFIG,
  type DomainEvent,
  type DutyStatus,
  type HosClock,
  epochMinutesToIso,
  isoToEpochMinutes,
  remainingLegalDriveMinutes,
} from "@mm/domain";
import {
  type OccurredEvent,
  driverStatusReducer,
  emptyDriverStatusState,
} from "../src/index.js";

/**
 * PRJ-01 (TDD RED → GREEN): the pure `driverStatusReducer` folds the four
 * driver-lifecycle events into ONE deterministic row per driver
 * (`{ driverId, status, remainingDriveMinutes, dutyWindowDeadline,
 * totalDrivenMinutes, weeklyOnDutyMin, currentHubId, currentTripId,
 * lastEventAt }`), mirroring `trailerStateReducer` (one-row-per-entity).
 *
 * The HOS-derived fields (`remainingDriveMinutes`, `dutyWindowDeadline`) are
 * computed from the `HosClock` snapshot carried in `DriverDutyStateChanged`
 * using the Phase-10 `@mm/domain` engine (`remainingLegalDriveMinutes`) — REUSED,
 * never reimplemented. Purity (P3): all time comes from `occurredAt` / the clock
 * snapshot; no wall clock, no RNG. Identical event sequence ⇒ identical state.
 */

const T0 = Date.parse("2026-04-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function evt(event: DomainEvent, occurredAt: string): OccurredEvent {
  return { event, occurredAt };
}

// --- Event factories --------------------------------------------------------

function registered(driverId: string, homeHubId: string, occurredAt = at(0)): DomainEvent {
  return {
    type: "DriverRegistered",
    schemaVersion: 1,
    payload: { driverId, homeHubId, occurredAt },
  };
}

function assigned(
  driverId: string,
  tripId: string,
  trailerId: string,
  occurredAt = at(0),
): DomainEvent {
  return {
    type: "DriverAssignedToTrip",
    schemaVersion: 1,
    payload: { driverId, tripId, trailerId, occurredAt },
  };
}

function clockAt(
  startMs: number,
  overrides: Partial<HosClock> = {},
): HosClock {
  const startIso = new Date(T0 + startMs).toISOString();
  return {
    driveTodayMin: 0,
    dutyWindowStartAt: startIso,
    sinceLastBreakMin: 0,
    weeklyOnDutyMin: 0,
    comeOnDutyAt: startIso,
    sleeperBerthLongMin: 0,
    sleeperBerthShortMin: 0,
    ...overrides,
  };
}

function dutyChanged(
  driverId: string,
  dutyStatus: DutyStatus,
  clock: HosClock,
  reason = "trip-dispatched",
  occurredAt = at(0),
): DomainEvent {
  return {
    type: "DriverDutyStateChanged",
    schemaVersion: 1,
    payload: { driverId, dutyStatus, reason, clock, occurredAt },
  };
}

function swapped(
  outgoingDriverId: string,
  incomingDriverId: string,
  hubId: string,
  tripId: string,
  trailerId: string,
  occurredAt = at(0),
): DomainEvent {
  return {
    type: "DriverSwappedAtHub",
    schemaVersion: 1,
    payload: { outgoingDriverId, incomingDriverId, hubId, tripId, trailerId, occurredAt },
  };
}

function fold(events: OccurredEvent[]) {
  return events.reduce(driverStatusReducer, emptyDriverStatusState);
}

// Expected HOS derivations (the engine is the single source of truth).
function expectedRemaining(clock: HosClock, occurredAt: string): number {
  return remainingLegalDriveMinutes(
    clock,
    DEFAULT_HOS_CONFIG,
    isoToEpochMinutes(occurredAt),
  );
}
function expectedDeadline(clock: HosClock): string {
  return epochMinutesToIso(
    isoToEpochMinutes(clock.dutyWindowStartAt) + DEFAULT_HOS_CONFIG.dutyWindowMin,
  );
}

// ---------------------------------------------------------------------------
// PRJ-01: driverStatusReducer
// ---------------------------------------------------------------------------
describe("driverStatusReducer (PRJ-01)", () => {
  it("registration creates an off_duty row with a fresh clock baseline", () => {
    const state = fold([evt(registered("D1", "MEM"), at(0))]);
    expect(state.get("D1")).toEqual({
      driverId: "D1",
      status: "off_duty",
      remainingDriveMinutes: 0,
      dutyWindowDeadline: null,
      totalDrivenMinutes: 0,
      weeklyOnDutyMin: 0,
      currentHubId: "MEM",
      currentTripId: null,
      lastEventAt: at(0),
    });
  });

  it("assignment binds the trip + trailer without losing the home hub", () => {
    const state = fold([
      evt(registered("D1", "MEM"), at(0)),
      evt(assigned("D1", "TRIP1", "T1"), at(1_000)),
    ]);
    expect(state.get("D1")).toMatchObject({
      driverId: "D1",
      currentTripId: "TRIP1",
      currentHubId: "MEM",
      lastEventAt: at(1_000),
    });
  });

  it("duty change folds the HOS clock snapshot into the derived fields", () => {
    const clock = clockAt(0, {
      driveTodayMin: 120,
      sinceLastBreakMin: 120,
      weeklyOnDutyMin: 120,
    });
    const occurredAt = at(120 * 60_000); // 120 min after window start
    const state = fold([
      evt(registered("D1", "MEM"), at(0)),
      evt(assigned("D1", "TRIP1", "T1"), at(60_000)),
      evt(dutyChanged("D1", "driving", clock, "trip-dispatched"), occurredAt),
    ]);
    expect(state.get("D1")).toEqual({
      driverId: "D1",
      status: "driving",
      remainingDriveMinutes: expectedRemaining(clock, occurredAt),
      dutyWindowDeadline: expectedDeadline(clock),
      totalDrivenMinutes: 120,
      weeklyOnDutyMin: 120,
      currentHubId: "MEM",
      currentTripId: "TRIP1",
      lastEventAt: occurredAt,
    });
    // Sanity: the derived remaining is the engine's number, clamped >= 0.
    expect(state.get("D1")?.remainingDriveMinutes).toBeGreaterThan(0);
  });

  it("a resting duty change reports the resting status + the resting clock", () => {
    const clock = clockAt(600, {
      driveTodayMin: 0,
      sinceLastBreakMin: 0,
      weeklyOnDutyMin: 660,
    });
    const occurredAt = at(660 * 60_000);
    const state = fold([
      evt(registered("D1", "MEM"), at(0)),
      evt(dutyChanged("D1", "resting", clock, "10h-reset"), occurredAt),
    ]);
    expect(state.get("D1")).toMatchObject({
      status: "resting",
      totalDrivenMinutes: 0,
      weeklyOnDutyMin: 660,
      dutyWindowDeadline: expectedDeadline(clock),
    });
  });

  it("a swap moves the trip to the incoming driver and frees the outgoing one", () => {
    const state = fold([
      evt(registered("D1", "MEM"), at(0)),
      evt(registered("D2", "DFW"), at(500)),
      evt(assigned("D1", "TRIP1", "T1"), at(1_000)),
      evt(swapped("D1", "D2", "DFW", "TRIP1", "T1"), at(2_000)),
    ]);
    // Incoming driver now carries the trip; current hub = swap hub.
    expect(state.get("D2")).toMatchObject({
      currentTripId: "TRIP1",
      currentHubId: "DFW",
      lastEventAt: at(2_000),
    });
    // Outgoing driver is released from the trip at the swap hub.
    expect(state.get("D1")).toMatchObject({
      currentTripId: null,
      currentHubId: "DFW",
      lastEventAt: at(2_000),
    });
  });

  it("tracks multiple drivers independently", () => {
    const state = fold([
      evt(registered("D1", "MEM"), at(0)),
      evt(registered("D2", "LAX"), at(1_000)),
    ]);
    expect(state.get("D1")?.currentHubId).toBe("MEM");
    expect(state.get("D2")?.currentHubId).toBe("LAX");
    expect(state.size).toBe(2);
  });

  it("non-driver events are no-ops (return the same state reference)", () => {
    const base = fold([evt(registered("D1", "MEM"), at(0))]);
    const next = driverStatusReducer(
      base,
      evt(
        {
          type: "TrailerDeparted",
          schemaVersion: 1,
          payload: {
            trailerId: "T1",
            fromHubId: "MEM",
            toHubId: "DFW",
            tripId: "TRIP1",
            packageIds: [],
          },
        },
        at(9_000),
      ),
    );
    expect(next).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Purity / determinism (P3)
// ---------------------------------------------------------------------------
describe("driverStatusReducer purity + determinism (P3)", () => {
  const clock = clockAt(0, { driveTodayMin: 60, sinceLastBreakMin: 60, weeklyOnDutyMin: 60 });
  const seed: OccurredEvent[] = [
    evt(registered("D2", "DFW"), at(0)),
    evt(registered("D1", "MEM"), at(500)),
    evt(assigned("D1", "TRIP1", "T1"), at(1_000)),
    evt(dutyChanged("D1", "driving", clock), at(60 * 60_000)),
    evt(swapped("D1", "D2", "DFW", "TRIP1", "T1"), at(120 * 60_000)),
  ];

  it("replaying the same event list twice from empty yields identical state", () => {
    expect(fold(seed)).toEqual(fold(seed));
  });

  it("calling the reducer twice with the same (state, event) is deep-equal", () => {
    const e = evt(dutyChanged("D9", "driving", clock), at(60 * 60_000));
    expect(driverStatusReducer(emptyDriverStatusState, e)).toEqual(
      driverStatusReducer(emptyDriverStatusState, e),
    );
  });

  it("does not mutate the input state (immutability)", () => {
    const before = fold(seed);
    const snapshot = new Map(before);
    driverStatusReducer(before, evt(registered("D3", "ATL"), at(99_999)));
    expect(before).toEqual(snapshot);
  });

  it("all derived time comes from occurredAt / the clock snapshot, never the wall clock", () => {
    const occurredAt = at(77 * 60_000);
    const state = fold([
      evt(registered("D1", "MEM"), at(0)),
      evt(dutyChanged("D1", "driving", clock), occurredAt),
    ]);
    expect(state.get("D1")?.lastEventAt).toBe(occurredAt);
    expect(state.get("D1")?.remainingDriveMinutes).toBe(
      expectedRemaining(clock, occurredAt),
    );
  });
});
