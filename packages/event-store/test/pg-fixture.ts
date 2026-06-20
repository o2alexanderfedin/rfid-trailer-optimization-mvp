import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import { createDb, migrate, type Database } from "../src/index.js";

/**
 * An ephemeral Postgres + migrated schema for integration tests.
 *
 * Precedence of paths:
 *
 *  1. `MM_PG_URL` (shared-server, per-run database): a SERVER url pointing at a
 *     maintenance db (e.g. `postgres://mm:mm@localhost:5432/postgres`). Each run
 *     creates a fresh `mm_test_<uuid>` database on that one shared server, so
 *     concurrent test runs are isolated from each other. `stop()` drops it.
 *  2. `DATABASE_URL` (direct): connect to that Postgres database as-is. Shared
 *     directly, so concurrent runs collide on the same tables.
 *  3. Default: spin a `postgres:17` container via Testcontainers against the
 *     active Docker context (OrbStack's `orbstack` context is the default; its
 *     socket is Docker-API compatible, so no special config is needed).
 */
export interface PgFixture {
  db: Kysely<Database>;
  connectionString: string;
  stop: () => Promise<void>;
}

/** Swap the database path of a server URL to point at `dbName`. */
function withDatabase(serverUrl: string, dbName: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export async function startPgFixture(): Promise<PgFixture> {
  const sharedServer = process.env.MM_PG_URL;
  if (sharedServer !== undefined && sharedServer !== "") {
    const dbName = `mm_test_${randomUUID().replace(/-/g, "")}`;
    const admin = new pg.Pool({ connectionString: sharedServer });
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }

    const connectionString = withDatabase(sharedServer, dbName);
    const db = createDb(connectionString);
    await migrate(db);

    return {
      db,
      connectionString,
      stop: async () => {
        await db.destroy();
        const dropper = new pg.Pool({ connectionString: sharedServer });
        try {
          await dropper.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        } finally {
          await dropper.end();
        }
      },
    };
  }

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
