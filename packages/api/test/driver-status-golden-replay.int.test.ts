import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  DEFAULT_HOS_CONFIG,
  type DomainEvent,
  type HosClock,
  epochMinutesToIso,
  isoToEpochMinutes,
  remainingLegalDriveMinutes,
} from "@mm/domain";
import { appendToStream, readAll } from "@mm/event-store";
import {
  applyInline,
  projectionView,
  type ProjectionDb,
  readOperationalTwin,
  rebuildProjections,
  type ReplayEvent,
  serializeTwin,
} from "@mm/projections";
import {
  eventStoreView,
  startPgFixture,
  type FixtureDb,
  type PgFixture,
} from "./pg-fixture.js";

/**
 * PRJ-02 success criterion 3 — DRIVER-STATUS GOLDEN REPLAY (live == rebuilt).
 *
 * Mirrors `projections-golden-replay.int.test.ts` but exercises the v1.2 driver
 * read models (`driver_status`, `driver_assignment`) plus the `trailer_state.driver_id`
 * stamping. Build the twin LIVE by appending a seeded driver-lifecycle stream and
 * applying each event inline (read-your-writes); capture the deterministic,
 * sorted-key serialization. Then INDEPENDENTLY rebuild by TRUNCATEing + resetting
 * checkpoints + replaying `readAll(0n)` strictly by global_seq through the SAME
 * applier. Assert BYTE-IDENTICAL — proving the driver projections carry no ambient
 * nondeterminism (Date.now/Math.random/unstable sort) and rebuild from the log
 * exactly matches live state (FND-04 determinism keystone, P3).
 */

function replayReadAll(
  db: Kysely<ProjectionDb>,
  fromGlobalSeq: bigint,
): Promise<readonly ReplayEvent[]> {
  return readAll(eventStoreView(db as unknown as FixtureDb), fromGlobalSeq);
}

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const MIN = 60_000;

// --- Driver-lifecycle event builders ----------------------------------------
function registered(driverId: string, homeHubId: string, occurredAt: string): DomainEvent {
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
  occurredAt: string,
): DomainEvent {
  return {
    type: "DriverAssignedToTrip",
    schemaVersion: 1,
    payload: { driverId, tripId, trailerId, occurredAt },
  };
}
function clockAt(startMs: number, overrides: Partial<HosClock> = {}): HosClock {
  const startIso = iso(startMs);
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
  dutyStatus: "driving" | "on_break" | "resting" | "off_duty",
  clock: HosClock,
  reason: string,
  occurredAt: string,
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
  occurredAt: string,
): DomainEvent {
  return {
    type: "DriverSwappedAtHub",
    schemaVersion: 1,
    payload: { outgoingDriverId, incomingDriverId, hubId, tripId, trailerId, occurredAt },
  };
}
function departed(
  trailerId: string,
  fromHubId: string,
  toHubId: string,
  tripId: string,
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId, packageIds: [] },
  };
}
function trailerArrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return { type: "TrailerArrivedAtHub", schemaVersion: 1, payload: { trailerId, hubId, tripId } };
}

interface Seed {
  readonly stream: string;
  readonly events: readonly DomainEvent[];
  readonly offsetMs: number;
}

describe("DRIVER GOLDEN REPLAY: live twin == rebuilt-from-log twin (PRJ-02)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("rebuilds the driver read models byte-identically from global_seq=0", async () => {
    const tag = "DR";
    const D1 = `${tag}-D1`;
    const D2 = `${tag}-D2`;
    const T1 = `${tag}-T1`;
    const TRIP = `${tag}-TRIP1`;
    const MEM = `${tag}-MEM`;
    const DFW = `${tag}-DFW`;

    // D1 drives 200 min then a duty change carries the HOS clock; the trailer
    // departs, arrives at DFW, and D1 is relay-swapped for the fresh D2.
    const drivingClock = clockAt(0, {
      driveTodayMin: 200,
      sinceLastBreakMin: 200,
      weeklyOnDutyMin: 200,
    });
    const restingClock = clockAt(600, {
      driveTodayMin: 0,
      sinceLastBreakMin: 0,
      weeklyOnDutyMin: 200,
    });

    // occurredAt offsets are intentionally NOT monotonic vs append order, to
    // prove replay orders by global_seq and reducers read time only from occurredAt.
    const seeds: Seed[] = [
      {
        stream: `driver-${D1}`,
        offsetMs: 1_000,
        events: [registered(D1, MEM, iso(0)), registered(D2, DFW, iso(500))],
      },
      {
        stream: `trailer-${T1}`,
        offsetMs: 9_000,
        events: [
          assigned(D1, TRIP, T1, iso(60 * MIN)),
          dutyChanged(D1, "driving", drivingClock, "trip-dispatched", iso(60 * MIN)),
          departed(T1, MEM, DFW, TRIP),
        ],
      },
      {
        stream: `trailer-${T1}-arr`,
        offsetMs: 3_000,
        events: [
          trailerArrived(T1, DFW, TRIP),
          swapped(D1, D2, DFW, TRIP, T1, iso(260 * MIN)),
          dutyChanged(D1, "resting", restingClock, "10h-reset", iso(260 * MIN)),
          dutyChanged(D2, "driving", clockAt(260 * MIN), "relay-takeover", iso(260 * MIN)),
        ],
      },
    ];

    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);

    let cursor = 0n;
    for (const seed of seeds) {
      const current = await es
        .selectFrom("streams")
        .select("version")
        .where("stream_id", "=", seed.stream)
        .executeTakeFirst();
      await appendToStream(es, seed.stream, current?.version ?? 0, seed.events, at(seed.offsetMs));
      const fresh = await readAll(es, cursor);
      for (const ev of fresh) await applyInline(proj, ev);
      if (fresh.length > 0) cursor = fresh[fresh.length - 1]!.globalSeq;
    }

    const liveTwin = await readOperationalTwin(proj);
    const liveSerialized = serializeTwin(liveTwin);

    // --- Sanity: the documented driver semantics hold in the LIVE twin. ------
    // D1: depleted, resting; its HOS-derived numbers come from the engine.
    const d1 = liveTwin.driverStatus.get(D1);
    expect(d1?.status).toBe("resting");
    expect(d1?.totalDrivenMinutes).toBe(0); // reset clock
    expect(d1?.dutyWindowDeadline).toBe(
      epochMinutesToIso(isoToEpochMinutes(restingClock.dutyWindowStartAt) + DEFAULT_HOS_CONFIG.dutyWindowMin),
    );
    // D2: fresh driver, now driving, carries the trip.
    const d2 = liveTwin.driverStatus.get(D2);
    expect(d2?.status).toBe("driving");
    expect(d2?.remainingDriveMinutes).toBe(
      remainingLegalDriveMinutes(clockAt(260 * MIN), DEFAULT_HOS_CONFIG, isoToEpochMinutes(iso(260 * MIN))),
    );
    // Assignment: D2 holds the trip + trailer; D1 was released by the swap.
    expect(liveTwin.driverAssignment.get(D2)).toMatchObject({ tripId: TRIP, trailerId: T1, hubId: DFW });
    expect(liveTwin.driverAssignment.get(D1)).toMatchObject({ tripId: null, trailerId: null });
    // trailer_state.driver_id (PRJ-02) re-stamped to the incoming driver D2.
    expect(liveTwin.trailerState.get(T1)?.driverId).toBe(D2);

    // --- REBUILD: truncate + reset checkpoints + replay from global_seq=0 ----
    await rebuildProjections(proj, replayReadAll);
    const rebuiltTwin = await readOperationalTwin(proj);
    const rebuiltSerialized = serializeTwin(rebuiltTwin);

    // THE KEYSTONE ASSERTION: byte-identical serialization, then deep-equal.
    expect(rebuiltSerialized).toBe(liveSerialized);
    expect(rebuiltTwin).toEqual(liveTwin);
    // The driver read models must be non-trivially present (not silently empty).
    expect(rebuiltTwin.driverStatus.size).toBe(2);
    expect(rebuiltTwin.driverAssignment.size).toBe(2);
  });

  it("a second rebuild is identical to the first (replay is deterministic)", async () => {
    const proj = projectionView(fx.db);
    await rebuildProjections(proj, replayReadAll);
    const a = serializeTwin(await readOperationalTwin(proj));
    await rebuildProjections(proj, replayReadAll);
    const b = serializeTwin(await readOperationalTwin(proj));
    expect(b).toBe(a);
  });
});
