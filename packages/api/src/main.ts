import { createDb, migrate } from "@mm/event-store";
import { PROJECTIONS_SCHEMA_SQL } from "@mm/projections";
import { sql } from "kysely";
import { buildServer } from "./server.js";
import { driveSimulationPaced } from "./sim/driver.js";
import { DEMO_RFID_CONFIG, DEMO_OVER_CARRY_CONFIG } from "./detection-config.js";
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
  const { app, broadcast, loop, speedController } = await buildServer({
    db,
    simSeed: seed,
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
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received — shutting down`);
    try {
      await app.close();
      await db.destroy();
    } catch (err: unknown) {
      app.log.error(err, "error during shutdown");
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Wall-clock ms between each sim-tick broadcast (presentation pacing only —
  // the sim engine is deterministic; only the delivery interval is wall-clock).
  // The interval/pause are now LIVE-tunable via the SpeedController (GET/POST
  // /sim/speed): the paced driver reads `getTickIntervalMs()`/`isPaused()` fresh
  // each iteration. `tickIntervalMs` is kept as the back-compat fallback.
  const tickIntervalMs = Number(process.env.SIM_TICK_INTERVAL_MS ?? 500);

  // Drive the sim AFTER listen so every connected client receives live ticks.
  // Enable seeded RFID emission so the WHOLE Phase-3 pipeline fires end-to-end
  // (reads → fused zone estimates → per-tick detector → exception feed).
  // F-07 / SNS-05: also enable the seeded over-carry so the missed-unload feed is
  // live — the UNCHANGED detector fires on spoke-origin over-carry return legs.
  driveSimulationPaced({
    db,
    seed,
    durationTicks,
    rfid: DEMO_RFID_CONFIG,
    overCarry: DEMO_OVER_CARRY_CONFIG.rate,
    broadcast,
    loop,
    tickIntervalMs,
    getTickIntervalMs: () => speedController.getTickIntervalMs(),
    isPaused: () => speedController.isPaused(),
  }).catch((err: unknown) => {
    app.log.error(err, "paced sim driver error");
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
