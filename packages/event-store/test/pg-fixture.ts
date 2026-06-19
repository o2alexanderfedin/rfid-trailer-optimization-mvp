import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Kysely } from "kysely";
import { createDb, migrate, type Database } from "../src/index.js";

/**
 * An ephemeral Postgres + migrated schema for integration tests.
 *
 * Default path: spins a `postgres:17` container via Testcontainers against the
 * active Docker context (OrbStack's `orbstack` context is the default; its
 * socket is Docker-API compatible, so no special config is needed).
 *
 * Override: if `DATABASE_URL` is set, connect to that Postgres instead of
 * starting a container (useful for a manually-run `docker compose up` DB).
 */
export interface PgFixture {
  db: Kysely<Database>;
  connectionString: string;
  stop: () => Promise<void>;
}

export async function startPgFixture(): Promise<PgFixture> {
  const override = process.env.DATABASE_URL;
  if (override !== undefined && override !== "") {
    const db = createDb(override);
    await migrate(db);
    return {
      db,
      connectionString: override,
      stop: async () => {
        await db.destroy();
      },
    };
  }

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:17",
  ).start();
  const connectionString = container.getConnectionUri();
  const db = createDb(connectionString);
  await migrate(db);

  return {
    db,
    connectionString,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}
