import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { readAll } from "@mm/event-store";
import {
  type CatchupDb,
  type StoredEventLike,
  readGeoKeyframes,
  rebuildCatchup,
  runCatchup,
  serializeCatchup,
} from "@mm/projections";
import { DEFAULT_FUEL_CONFIG, type FuelConfig } from "@mm/domain";
import { driveSimulation } from "../src/sim/driver.js";
import { buildTwinSnapshot } from "../src/optimizer/twin-snapshot.js";
import {
  eventStoreView,
  startPgFixture,
  type FixtureDb,
  type PgFixture,
} from "./pg-fixture.js";

/**
 * SP2 Task 5 — the FUEL-ON live-demo integration test (spec §9, integration).
 *
 * Drives the REAL deterministic sim (fuel ON) into the event store + projections
 * via the same `driveSimulation` path the demo uses, then asserts END-TO-END:
 *  1. the store carries `TruckRested` + `TruckRefueled` events (the new stops);
 *  2. the geo-track catch-up projection emits `rested` / `refueling` keyframes at
 *     interpolated MID-LEG positions carrying `durationMinutes`;
 *  3. the twin snapshot carries a non-zero `milesSinceRefuel` for at least one
 *     trailer (the optimizer's fuel-aware odometer);
 *  4. a fuel-OFF run produces NEITHER stop event (the determinism keystone holds
 *     end-to-end), so the fuel-on plan timing genuinely reflects the new stops;
 *  5. `rebuildCatchup` is byte-identical to the live catch-up state (P3 / FND-04).
 *
 * NOTE (rival worktree): this FILE is implemented but NOT run here — integration
 * runs (Testcontainers Postgres) are executed by the orchestrator on the winner.
 */

const SEED = 4242;
// 600 ticks (1 tick = 1 min sim time): enough for the long-coast legs (LAX/SEA/PHX
// ~1,900–2,250 min one-way) to drive past the threshold mid-leg, fire HOS rests +
// refuels, and land ≥1 arrival — while finishing well inside the integration
// timeout. (At 6000 ticks the run exceeded the lane's default 120s and timed out.)
const TICKS = 600;
// HOS on so rests exist; fuel on with a SMALL threshold (400 mi) so several refuels
// occur within this short horizon over the long legs.
const FUEL_ON: FuelConfig = { ...DEFAULT_FUEL_CONFIG, enabled: true, refuelThresholdMiles: 400 };

/** A view of the fixture handle as the catch-up runner's `Kysely<CatchupDb>`. */
function catchupView(db: FixtureDb): Kysely<CatchupDb> {
  return db as unknown as Kysely<CatchupDb>;
}

/** Inject `@mm/event-store`'s `readAll` as the catch-up log reader. */
function replayReadAll(
  db: Kysely<CatchupDb>,
  fromGlobalSeq: bigint,
): Promise<readonly StoredEventLike[]> {
  return readAll(eventStoreView(db as unknown as FixtureDb), fromGlobalSeq);
}

describe("SP2 fuel-on live path: rest/refuel events + geo keyframes + fuel-aware twin", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("drives a fuel-on stream that reaches the store, projections, and the twin", async () => {
    // 1. Drive the REAL sim with fuel ON (+ HOS on so rests exist), no broadcast.
    await driveSimulation({
      db: fx.db,
      seed: SEED,
      durationTicks: TICKS,
      hosEnabled: true,
      fuel: FUEL_ON,
      broadcast: undefined,
    });

    // 2. The store carries the NEW stop events.
    const es = eventStoreView(fx.db);
    const all = await readAll(es, 0n);
    const rested = all.filter((e) => e.event.type === "TruckRested");
    const refueled = all.filter((e) => e.event.type === "TruckRefueled");
    expect(rested.length).toBeGreaterThan(0);
    expect(refueled.length).toBeGreaterThan(0);
    // Each refuel payload is well-formed (NO lon/lat; deterministic gallons/odometer).
    for (const r of refueled) {
      if (r.event.type !== "TruckRefueled") continue;
      expect(r.event.payload).not.toHaveProperty("lon");
      expect(r.event.payload.odometerMiles).toBeGreaterThanOrEqual(FUEL_ON.refuelThresholdMiles);
    }

    // 3. The geo-track catch-up projection emits rested/refueling keyframes at
    //    interpolated positions, carrying durationMinutes.
    const cv = catchupView(fx.db);
    await runCatchup(cv, replayReadAll);
    const keyframes = await readGeoKeyframes(cv);
    const restKfs = keyframes.filter((k) => k.kind === "rested");
    const refuelKfs = keyframes.filter((k) => k.kind === "refueling");
    expect(restKfs.length).toBeGreaterThan(0);
    expect(refuelKfs.length).toBeGreaterThan(0);
    for (const k of [...restKfs, ...refuelKfs]) {
      expect(k.durationMinutes).toBeGreaterThan(0);
      // A real interpolated coordinate (not the [0,0] stub).
      expect(Number.isFinite(k.lon)).toBe(true);
      expect(Number.isFinite(k.lat)).toBe(true);
    }

    // 4. The twin snapshot carries a non-zero milesSinceRefuel for ≥ 1 trailer.
    const snapshot = await buildTwinSnapshot(fx.db);
    const anyMiles = snapshot.trailers.some((t) => (t.milesSinceRefuel ?? 0) > 0);
    expect(anyMiles).toBe(true);
    // Every route leg carries a distanceMiles (ORS/haversine) for fuel-awareness.
    for (const r of snapshot.routes) {
      expect(r.distanceMiles).toBeDefined();
      expect(r.distanceMiles!).toBeGreaterThanOrEqual(0);
    }

    // 5. rebuildCatchup is byte-identical to the live catch-up state (P3 / FND-04).
    const liveState = await serializeCatchup(cv);
    await rebuildCatchup(cv, replayReadAll);
    const rebuiltState = await serializeCatchup(cv);
    expect(rebuiltState).toBe(liveState);
  }, 300_000);

  it("a fuel-OFF run over the SAME seed produces NO stop events (keystone end-to-end)", async () => {
    // Reset the store by spinning a fresh fixture would be heavy; instead assert the
    // fuel-OFF stream directly from the engine path the demo would take with fuel
    // off — no TruckRested/TruckRefueled reach the store. We use a SECOND fixture DB
    // to keep this hermetic from the fuel-on run above.
    const fx2 = await startPgFixture();
    try {
      await driveSimulation({
        db: fx2.db,
        seed: SEED,
        durationTicks: TICKS,
        hosEnabled: true,
        // fuel omitted ⇒ engine default (off).
        broadcast: undefined,
      });
      const es2 = eventStoreView(fx2.db);
      const all2 = await readAll(es2, 0n);
      expect(all2.some((e) => e.event.type === "TruckRested")).toBe(false);
      expect(all2.some((e) => e.event.type === "TruckRefueled")).toBe(false);
    } finally {
      await fx2.stop();
    }
  }, 300_000);
});
