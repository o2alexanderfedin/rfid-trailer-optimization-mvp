import { createDb, migrate } from "@mm/event-store";
import { PROJECTIONS_SCHEMA_SQL } from "@mm/projections";
import { sql } from "kysely";
import { buildServer } from "./server.js";
import { driveSimulationPaced, driveSimulationOpenEnded } from "./sim/driver.js";
import {
  DEMO_RFID_CONFIG,
  DEMO_OVER_CARRY_CONFIG,
  resolveDemoFuelEnabled,
  resolveDemoHosEnabled,
} from "./detection-config.js";
import { DEFAULT_FUEL_CONFIG, DEFAULT_HOS_CONFIG, type FuelConfig } from "@mm/domain";
import type { ApiDb } from "./routes/queries.js";

/**
 * Runnable entrypoint. Connects to DATABASE_URL, migrates BOTH schemas (event
 * store + projections), starts listening, THEN drives the deterministic demo
 * simulation as a paced live stream — one sim-tick per wall-clock interval.
 *
 * FIX E: The previous implementation called `driveSimulation(...)` BEFORE
 * `app.listen()`, so any client connecting after startup received the initial
 * snapshot and NEVER any further ticks (the sim had already run to completion).
 * Now we:
 *   1. Listen first so clients can connect immediately.
 *   2. Drive the sim via `driveSimulationPaced()`, which advances one sim-tick
 *      per wall-clock interval and broadcasts each tick to connected clients.
 *   3. Event generation remains fully deterministic (same seed → same stream);
 *      only the *broadcast pacing* uses wall-clock (`setTimeout`) — presentation
 *      layer only, not the sim engine.
 *   4. The rolling optimizer runs per paced tick (live re-opt visible on the map).
 *
 * SIM-04: `loop` is the live rolling-optimizer (RollingLoop) — it fires per tick
 * so the optimizer runs on the live path and recommendations are visible.
 */
async function main(): Promise<void> {
  const seed = Number(process.env.SIM_SEED ?? 4242);
  const db = createDb() as unknown as ApiDb;
  await migrate(db as unknown as Parameters<typeof migrate>[0]);
  await sql.raw(PROJECTIONS_SCHEMA_SQL).execute(db);

  const durationTicks = Number(process.env.SIM_TICKS ?? 120);
  // Demo richness: trailers (each with a primary driver) per spoke. Default 3 so
  // the live map shows ~3× the trucks at once; set FLEET_PER_SPOKE=1 for the lean
  // (golden-equivalent) single-trailer-per-spoke run. Threaded to the sim engine.
  const fleetPerSpoke = Math.max(1, Math.floor(Number(process.env.FLEET_PER_SPOKE ?? 3)));
  // Run the rolling optimizer every Nth tick (not every tick) so the heavier
  // per-tick optimization of a larger fleet doesn't block event generation /
  // freeze the trailer animation. Default 8; set OPTIMIZER_EVERY_TICKS=1 for the
  // strict per-tick re-opt (lean fleet).
  const optimizerEveryTicks = Math.max(1, Math.floor(Number(process.env.OPTIMIZER_EVERY_TICKS ?? 8)));
  // Optimizer transport (spec §5): the DEMO defaults to `worker` (offload the
  // CPU-heavy min-cost-flow + VRPTW to a worker_threads worker so the paced
  // playback loop never stalls). Set OPTIMIZER_EXECUTION=inline for the strict
  // in-process path (e.g. parity debugging). Anything other than `inline` ⇒ worker.
  const optimizerExecution =
    process.env.OPTIMIZER_EXECUTION === "inline" ? "inline" : "worker";
  // SP2 (spec §5): fuel/refuel modeling on the LIVE demo (DEFAULT ON; set
  // FUEL_ENABLED=0 to disable). When on, the engine accrues a per-trailer odometer
  // and emits TruckRested/TruckRefueled, and the optimizer folds the expected
  // refuel time into leg timing — so trucks visibly park to rest + refuel mid-route
  // and the plan reflects the lost time. Off-by-default in the engine keeps the
  // unit determinism goldens byte-identical; this env wiring affects ONLY the demo.
  const fuelEnabled = resolveDemoFuelEnabled();
  // P27-B (COORD-03 live reject): the CONTINENTAL demo config enables fuel and
  // lowers `refuelThresholdMiles` so long backbone legs deterministically push a
  // mid-trip truck past the refuel limit exactly when a coordinator targets it →
  // the "won't divert: fuel" SuggestionRejected fires LIVE. 250 miles is short
  // enough that a single hub-to-hub backbone leg (400–900 mi) crosses the
  // threshold mid-trip, but large enough that short spoke legs rarely trigger
  // early. Do NOT edit DEFAULT_FUEL_CONFIG — this override affects ONLY the live
  // continental demo run, never the unit determinism goldens (which call
  // simulate() directly with the engine default, fuel OFF).
  const fuelConfig: FuelConfig = {
    ...DEFAULT_FUEL_CONFIG,
    enabled: fuelEnabled,
    // P27-B override: lower threshold so backbone legs trigger the fuel guard.
    refuelThresholdMiles: 250,
  };
  // Phase 22 (OUT-01): terminal delivery on the LIVE demo (DEFAULT ON; set
  // OUTBOUND_DELIVERY_ENABLED=0 to disable). When on, freight reaching its
  // destination hub fires PackageDelivered after a seeded dwell — driving the
  // VIZ-14 destination-hub flash + the OUT-05 delivery KPI counters. Induction is
  // enabled alongside it so externally-inducted freight (with SLA deadlines) also
  // flows to delivery. Off-by-default in the ENGINE keeps the unit goldens
  // byte-identical; this env wiring affects ONLY the demo.
  const outboundDeliveryEnabled = process.env.OUTBOUND_DELIVERY_ENABLED !== "0";
  const inductionEnabled = process.env.INDUCTION_ENABLED !== "0";
  // Phase 21 (FLOW-01/02): spoke→center consolidation on the LIVE demo (DEFAULT
  // ON; set CONSOLIDATION_ENABLED=0 to disable). When on, spoke-origin trailers
  // carry real freight to the center, which re-sorts it for onward distribution —
  // so the full bidirectional freight lifecycle (induction → consolidation →
  // center re-sort → distribution → delivery) runs live. Off-by-default in the
  // ENGINE keeps the unit goldens byte-identical; this env wiring affects ONLY the demo.
  const consolidationEnabled = process.env.CONSOLIDATION_ENABLED !== "0";
  // Phase 19 (CONT-01/02): continuous open-ended operation on the LIVE demo.
  // OPT-IN (DEFAULT OFF — the default demo keeps the finite paced run that all
  // existing tooling expects). Set RUN_UNTIL_STOPPED=1 to drive the resumable
  // `driveSimulationOpenEnded` path instead: ONE bounded `SimContinuation`
  // advanced by chunks, broadcasting forever until the process is stopped — so the
  // full v2.0 lifecycle (induction → consolidation → distribution → delivery)
  // runs indefinitely on the live map. Engine determinism goldens are untouched
  // (they call `simulate` directly; this env wiring affects ONLY the demo).
  // NOTE: bounded persisted retention (event-log pruning) is a DEEPER opt-in and
  // is intentionally left OFF here — enabling it requires materializing the
  // delivery-KPI aggregate first (see v2.0-MILESTONE-AUDIT.md tech-debt), since
  // the on-demand KPI COUNTs over the `events` log a prune would shrink.
  const runUntilStopped = process.env.RUN_UNTIL_STOPPED === "1";
  const { app, broadcast, loop, speedController, worker } = await buildServer({
    db,
    simSeed: seed,
    optimizerExecution,
    // SP2: forward the fuel config so the live optimizer is fuel-aware (matches sim).
    fuelConfig,
    // FIX F: pass the full baseline tick count so scenario injection computes
    // scenarioEpochMs beyond any already-memoized baseline epoch.
    baselineTicks: durationTicks,
  });
  // FIX E: listen FIRST so connected clients can receive live ticks.
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`API listening on :${port}`);

  // buildServer() already called app.ready(), so by the time we get here the
  // instance is started — addHook("onClose", ...) would throw
  // FST_ERR_INSTANCE_ALREADY_LISTENING. Tear the DB down on process termination
  // (SIGINT/SIGTERM) instead, closing the server first so in-flight requests drain.
  // CONT-01: cooperative stop flag for the open-ended driver — flipped on the
  // first termination signal so `driveSimulationOpenEnded({ stopped })` exits its
  // frame loop cleanly at the next boundary (no-op for the finite paced path).
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received — shutting down`);
    stopping = true;
    try {
      // `app.close()` already terminates the worker via its onClose hook; we also
      // close it explicitly (idempotent) so the worker thread never outlives the
      // process on shutdown.
      await app.close();
      await worker?.close();
      await db.destroy();
    } catch (err: unknown) {
      app.log.error(err, "error during shutdown");
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Accumulator pacing knobs (presentation only — the sim engine is
  // deterministic; only the FRAME cadence + per-frame batching are wall-clock).
  // The speed multiplier + pause are LIVE-tunable via the SpeedController
  // (GET/POST /sim/speed): the paced driver reads `getMultiplier()`/`isPaused()`
  // FRESH each frame so a slider drag lands on the very next frame.
  const frameMs = Number(process.env.SIM_FRAME_MS ?? 250);
  // Low per-frame drain budget ⇒ more WS deltas (smoother map responsiveness) at
  // ~the same total cost, since the per-frame fold dominates at a large fleet.
  const maxTicksPerFrame = Math.max(
    1,
    Math.floor(Number(process.env.SIM_MAX_TICKS_PER_FRAME ?? 4)),
  );

  // Phase 18 — live driver-HOS prerequisite: enable Hours-of-Service on the LIVE
  // demo (DEFAULT ON; set HOS_ENABLED=0 to disable). With HOS on, the engine
  // seeds drivers, assigns them per trip, accrues driving minutes, parks/relays
  // on a breach, and emits driver + load/unload phase events ⇒ `driver_status` is
  // populated ⇒ `GET /hubs/:id/detail` + the ws driver buckets carry real duty
  // data (the v1.2 hero feature is now visible on the map + Hub Detail panel).
  // This DOES NOT touch the unit determinism goldens — they call `simulate`
  // directly with the default (HOS-off) config and never read HOS_ENABLED.
  const hosEnabled = resolveDemoHosEnabled();
  app.log.info(`driver HOS ${hosEnabled ? "ENABLED" : "disabled"} on live demo`);
  app.log.info(`fuel/refuel stops ${fuelEnabled ? "ENABLED" : "disabled"} on live demo`);
  app.log.info(`fleet: ${fleetPerSpoke} trailer(s) per spoke`);

  // Drive the sim AFTER listen so every connected client receives live ticks.
  // Enable seeded RFID emission so the WHOLE Phase-3 pipeline fires end-to-end
  // (reads → fused zone estimates → per-tick detector → exception feed).
  // F-07 / SNS-05: also enable the seeded over-carry so the missed-unload feed is
  // live — the UNCHANGED detector fires on spoke-origin over-carry return legs.
  // Options shared by BOTH drive paths. `driveSimulationOpenEnded` extends
  // `driveSimulationPacedOptions` (a clean superset), so the whole live wiring —
  // broadcast, optimizer loop, frame pacing, live speed control, and every v2.0
  // feature flag — is identical; only the run shape (finite vs. continuous) differs.
  const driveOpts = {
    db,
    seed,
    durationTicks,
    rfid: DEMO_RFID_CONFIG,
    overCarry: DEMO_OVER_CARRY_CONFIG.rate,
    hosEnabled,
    hosConfig: DEFAULT_HOS_CONFIG,
    // SP2: drive the engine with fuel ON (per FUEL_ENABLED) so the live stream
    // carries TruckRested/TruckRefueled and the geo-track renders mid-route stops.
    fuel: fuelConfig,
    // Phase 20/21/22: induction + consolidation + terminal delivery on the live
    // demo so freight enters at the spokes, consolidates spoke→center, re-sorts,
    // distributes, and fires PackageDelivered at its destination — the full v2.0
    // freight lifecycle live (VIZ-13 induction flash + VIZ-12 consolidation +
    // VIZ-14 delivery flash + OUT-05 KPI).
    inductionEnabled,
    consolidationEnabled,
    outboundDeliveryEnabled,
    fleetPerSpoke,
    optimizerEveryTicks,
    broadcast,
    loop,
    frameMs,
    maxTicksPerFrame,
    getMultiplier: () => speedController.getMultiplier(),
    isPaused: () => speedController.isPaused(),
  };
  app.log.info(
    `run mode: ${runUntilStopped ? "CONTINUOUS (open-ended, until stopped)" : "finite paced"}`,
  );
  // Drive the sim AFTER listen so every connected client receives live ticks.
  // Enable seeded RFID emission so the WHOLE Phase-3 pipeline fires end-to-end
  // (reads → fused zone estimates → per-tick detector → exception feed). F-07 /
  // SNS-05: seeded over-carry keeps the missed-unload feed live too.
  const drive = runUntilStopped
    ? driveSimulationOpenEnded({ ...driveOpts, stopped: () => stopping })
    : driveSimulationPaced(driveOpts);
  drive.catch((err: unknown) => {
    app.log.error(err, "sim driver error");
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
