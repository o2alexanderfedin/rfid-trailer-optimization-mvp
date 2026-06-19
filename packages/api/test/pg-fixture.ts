import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import pg from "pg";
import { createDb, migrate, type Database } from "@mm/event-store";
import { PROJECTIONS_SCHEMA_SQL, type ProjectionDb } from "@mm/projections";

/**
 * An ephemeral Postgres for the API integration tests, migrated with BOTH the
 * event-store schema (streams/events/projection_checkpoints/hubs) and the
 * operational + catch-up projection schema. Mirrors the projections/simulation
 * fixtures so the API is exercised against the exact production store +
 * projection path.
 *
 * Precedence of paths:
 *
 *  1. `MM_PG_URL` (shared-server, per-run database): a SERVER url pointing at a
 *     maintenance db (e.g. `postgres://mm:mm@localhost:5432/postgres`). Each run
 *     creates a fresh `mm_test_<uuid>` database on that one shared server, so
 *     concurrent test runs are isolated. `stop()` drops it.
 *  2. `DATABASE_URL` (direct): connect to that Postgres database as-is.
 *  3. Default: a `postgres:17` Testcontainer on the active Docker context
 *     (OrbStack).
 */
export type FixtureDb = Kysely<Database & ProjectionDb>;

export interface PgFixture {
  db: FixtureDb;
  connectionString: string;
  stop: () => Promise<void>;
}

/** View the fixture handle as the event-store `Kysely<Database>` (same instance). */
export function eventStoreView(db: FixtureDb): Kysely<Database> {
  return db as unknown as Kysely<Database>;
}

async function migrateAll(db: Kysely<Database>): Promise<void> {
  await migrate(db); // event-store schema (incl. projection_checkpoints)
  await sql.raw(PROJECTIONS_SCHEMA_SQL).execute(db); // operational + catch-up projections
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
    await migrateAll(db);

    return {
      db: db as unknown as FixtureDb,
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
    await migrateAll(db);
    return {
      db: db as unknown as FixtureDb,
      connectionString: override,
      stop: async () => {
        await db.destroy();
      },
    };
  }

  const container: StartedPostgreSqlContainer =
    await new PostgreSqlContainer("postgres:17").start();
  const connectionString = container.getConnectionUri();
  const db = createDb(connectionString);
  await migrateAll(db);

  return {
    db: db as unknown as FixtureDb,
    connectionString,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}
