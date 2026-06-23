import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DomainEvent, HosClock } from "@mm/domain";
import type { Database } from "@mm/event-store";
import { appendToStream, readAll } from "@mm/event-store";
import {
  applyInline,
  projectionView,
  type ProjectionDb,
  type ReplayEvent,
} from "@mm/projections";
import { DEFAULT_OBJECTIVE_WEIGHTS, runEpoch, type Epoch } from "@mm/optimizer";
import { buildTwinSnapshot } from "../src/optimizer/twin-snapshot.js";
import {
  eventStoreView,
  startPgFixture,
  type FixtureDb,
  type PgFixture,
} from "./pg-fixture.js";

/**
 * GAP-1 (v1.2 milestone audit) — OPT-HOS-02 / OPT-HOS-03 fire on the LIVE path.
 *
 * The audit found the hard HOS gate + insertRest/relay recommendation were DARK:
 * `buildTwinSnapshot` built `TwinDriver` as `{ driverId, remainingDriveMinutes }`
 * and NEVER set `hosClock`, so `epoch.ts driverHosContextFor` returned `undefined`,
 * the `route-trailers.ts hosLegsFeasible` gate never activated, and
 * `firstHosInfeasibleLeg` (gated on `route.hosFeasible === false`) was never reached.
 *
 * This test proves the fix END-TO-END on the live path: it appends a real
 * driver-lifecycle stream (whose `DriverDutyStateChanged` carries a DEPLETED
 * `HosClock`), folds it through the SAME `applyInline` the running system uses so a
 * real `driver_status` row exists, then builds the `TwinSnapshot` with the live
 * `buildTwinSnapshot` and runs `runEpoch`. The live-built snapshot now carries the
 * full `hosClock`, the hard gate rejects the leg the depleted driver cannot legally
 * complete (`hosFeasible: false` ⇒ recommendation `feasible: false`), and an
 * `insertRest`/`relay` `EpochRecommendation` is surfaced.
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

// --- Event builders ----------------------------------------------------------
function registered(driverId: string, homeHubId: string, occurredAt: string): DomainEvent {
  return { type: "DriverRegistered", schemaVersion: 1, payload: { driverId, homeHubId, occurredAt } };
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
function dutyChanged(
  driverId: string,
  clock: HosClock,
  occurredAt: string,
): DomainEvent {
  return {
    type: "DriverDutyStateChanged",
    schemaVersion: 1,
    payload: { driverId, dutyStatus: "driving", reason: "trip-dispatched", clock, occurredAt },
  };
}
function routeRegistered(
  routeId: string,
  fromHubId: string,
  toHubId: string,
  geometry: readonly [number, number][],
): DomainEvent {
  return {
    type: "RouteRegistered",
    schemaVersion: 1,
    payload: { routeId, fromHubId, toHubId, geometry: geometry.map((p) => [...p] as [number, number]) },
  };
}
function departed(
  trailerId: string,
  fromHubId: string,
  toHubId: string,
  tripId: string,
  packageIds: readonly string[] = [],
): DomainEvent {
  return {
    type: "TrailerDeparted",
    schemaVersion: 1,
    payload: { trailerId, fromHubId, toHubId, tripId, packageIds: [...packageIds] },
  };
}
function trailerArrived(trailerId: string, hubId: string, tripId: string): DomainEvent {
  return { type: "TrailerArrivedAtHub", schemaVersion: 1, payload: { trailerId, hubId, tripId } };
}

describe("OPT-HOS-02/03 LIVE PATH: live-built snapshot carries hosClock + hard gate fires (GAP-1)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("a depleted driver's live driver_status row makes its trailer HOS-INFEASIBLE with an insertRest/relay recommendation", async () => {
    const D1 = "HOSLIVE-D1";
    const T1 = "HOSLIVE-T1";
    const TRIP = "HOSLIVE-TRIP1";
    const H1 = "HOSLIVE-H1";
    const H2 = "HOSLIVE-H2";
    const PKG = "HOSLIVE-PKG1";

    // The driver is sitting at H1 with a depleted 11h driving clock. The clock is
    // anchored at the duty instant so the 14h window is NOT the limiting factor —
    // the depleted driving clock is: driveTodayMin 655 of 660 ⇒ only 5 legal drive
    // minutes left, so the onward ~30-min H1→H2 leg cannot be completed without a
    // mandatory 10h rest (hard gate fires).
    const dutyMs = 200 * MIN;
    const dutyIso = iso(dutyMs);
    const depletedClock: HosClock = {
      driveTodayMin: 655,
      dutyWindowStartAt: dutyIso,
      sinceLastBreakMin: 0,
      weeklyOnDutyMin: 655,
      comeOnDutyAt: dutyIso,
      sleeperBerthLongMin: 0,
      sleeperBerthShortMin: 0,
    };

    const es = eventStoreView(fx.db);
    const proj = projectionView(fx.db);

    // 1. Append the onward route + the driver + the trailer lifecycle streams. The
    //    trailer ARRIVES at H1 (current_hub_id=H1) bound to D1, carrying a package;
    //    its onward route H1→H2 is derived by the snapshot builder from the
    //    RouteRegistered leg, so the HOS gate has a driving leg to reject.
    await appendToStream(
      es,
      `network-${T1}`,
      0,
      [
        // A short regional leg (~30 min ORS/haversine) so the depleted driver
        // cannot legally complete it.
        routeRegistered("HOSLIVE-R1", H1, H2, [
          [-87.63, 41.88],
          [-87.0, 41.5],
        ]),
      ],
      at(0),
    );
    await appendToStream(es, `driver-${D1}`, 0, [registered(D1, H1, iso(0))], at(1_000));
    await appendToStream(
      es,
      `trailer-${T1}`,
      0,
      [
        assigned(D1, TRIP, T1, dutyIso),
        departed(T1, "HOSLIVE-H0", H1, TRIP, [PKG]),
        // Arriving stamps current_hub_id=H1 and carries the manifest + driver.
        trailerArrived(T1, H1, TRIP),
        // The depleted clock snapshot is folded into driver_status here.
        dutyChanged(D1, depletedClock, dutyIso),
      ],
      at(dutyMs),
    );

    // 2. Fold the WHOLE log through the SAME applyInline the running system uses.
    const events = await readAll(es, 0n);
    for (const ev of events) await applyInline(proj, ev);

    // Sanity: a real driver_status row exists and the trailer is bound to D1.
    const driverRow = await fx.db
      .selectFrom("driver_status")
      .selectAll()
      .where("driver_id", "=", D1)
      .executeTakeFirst();
    expect(driverRow).toBeDefined();
    expect(driverRow!.total_driven_minutes).toBe(655);
    const trailerRow = await fx.db
      .selectFrom("trailer_state")
      .selectAll()
      .where("trailer_id", "=", T1)
      .executeTakeFirst();
    expect(trailerRow!.driver_id).toBe(D1);

    // 3. Build the LIVE snapshot and assert it now carries the full hosClock.
    const snapshot = await buildTwinSnapshot(
      fx.db as unknown as Kysely<Database & ProjectionDb>,
    );
    const twinTrailer = snapshot.trailers.find((t) => t.trailerId === T1)!;
    expect(twinTrailer.driver).toBeDefined();
    expect(twinTrailer.driver!.driverId).toBe(D1);
    // THE FIX: the live-built snapshot carries the full per-shift clock (was undefined).
    expect(twinTrailer.driver!.hosClock).toBeDefined();
    expect(twinTrailer.driver!.hosClock!.driveTodayMin).toBe(655);

    // 4. Run the epoch over the LIVE snapshot — the hard gate must fire.
    const epoch: Epoch = { epochId: "e-hos-live", nowMin: 100, freezeWindowMin: 15 };
    const result = runEpoch(
      epoch,
      { events: [departed(T1, H1, H2, TRIP)], twinSnapshot: snapshot },
      DEFAULT_OBJECTIVE_WEIGHTS,
    );
    const rec = result.recommendations.find((r) => r.trailerId === T1)!;
    // OPT-HOS-02 — the trailer is HOS-INFEASIBLE on the live path.
    expect(rec.feasible).toBe(false);
    // OPT-HOS-03 — an insertRest/relay recovery is surfaced (explainable, names D1).
    expect(rec.repairRecommendations).toBeDefined();
    const kinds = new Set(rec.repairRecommendations!.map((r) => r.kind));
    expect(kinds.has("insertRest") || kinds.has("relay")).toBe(true);
    const hosRec = rec.repairRecommendations!.find(
      (r) => r.kind === "insertRest" || r.kind === "relay",
    )!;
    expect(hosRec.rationale).toContain(D1);
  });
});
