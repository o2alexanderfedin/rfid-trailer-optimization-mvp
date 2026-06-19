import { createDb, migrate } from "@mm/event-store";
import { buildApp } from "./app.js";
import { seedHubs } from "./seed.js";

/**
 * Real server entrypoint. Connects to DATABASE_URL, migrates, seeds the
 * Memphis hub, and serves the read API. CORS-free (web dev server proxies).
 */
async function main(): Promise<void> {
  const db = createDb();
  await migrate(db);
  await seedHubs(db);

  const app = buildApp(db);
  app.addHook("onClose", async () => {
    await db.destroy();
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`API listening on :${port}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
