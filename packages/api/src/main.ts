import { createDb, migrate } from "@mm/event-store";
import { PROJECTIONS_SCHEMA_SQL } from "@mm/projections";
import { sql } from "kysely";
import { buildServer } from "./server.js";
import { driveSimulation } from "./sim/driver.js";
import { DEMO_RFID_CONFIG } from "./detection-config.js";
import type { ApiDb } from "./routes/queries.js";

/**
 * Runnable entrypoint. Connects to DATABASE_URL, migrates BOTH schemas (event
 * store + projections), drives a short deterministic demo simulation to populate
 * the read models, and serves the query API + ws snapshots. A background ticker
 * keeps pushing snapshots so a freshly-connected map client always animates.
 */
async function main(): Promise<void> {
  const db = createDb() as unknown as ApiDb;
  await migrate(db as unknown as Parameters<typeof migrate>[0]);
  await sql.raw(PROJECTIONS_SCHEMA_SQL).execute(db);

  const { app, broadcast } = await buildServer({ db });
  app.addHook("onClose", async () => {
    await db.destroy();
  });

  const seed = Number(process.env.SIM_SEED ?? 4242);
  const durationTicks = Number(process.env.SIM_TICKS ?? 120);
  // Enable seeded RFID emission so the WHOLE Phase-3 pipeline runs on the live
  // demo (reads -> fused zone estimates -> per-tick detector -> exception feed).
  // Without `rfid` the driver gates detection off and the feature is invisible.
  await driveSimulation({ db, seed, durationTicks, rfid: DEMO_RFID_CONFIG, broadcast });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`API listening on :${port}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
