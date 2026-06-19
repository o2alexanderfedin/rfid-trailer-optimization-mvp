import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { type Kysely, sql } from "kysely";
import { createDb, migrate, type Database } from "@mm/event-store";
import { PROJECTIONS_SCHEMA_SQL, type ProjectionDb } from "@mm/projections";

/**
 * An ephemeral Postgres for the simulation integration test, migrated with BOTH
 * the event-store schema (streams/events/projection_checkpoints) and the
 * operational-twin projection schema. Mirrors the projections fixture so the
 * simulator is exercised against the exact production store + projection path.
 *
 * Default: a `postgres:17` Testcontainer on the active Docker context
 * (OrbStack). Override with `DATABASE_URL` to reuse an existing instance.
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
  await sql.raw(PROJECTIONS_SCHEMA_SQL).execute(db); // operational projections
}

export async function startPgFixture(): Promise<PgFixture> {
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
