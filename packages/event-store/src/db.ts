import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

/**
 * Build a Kysely instance over `pg` for the given connection string.
 * Honors a `DATABASE_URL` override when no explicit string is passed.
 */
export function createDb(connectionString?: string): Kysely<Database> {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "No Postgres connection string: pass one to createDb() or set DATABASE_URL.",
    );
  }
  const dialect = new PostgresDialect({
    pool: new pg.Pool({ connectionString: url }),
  });
  return new Kysely<Database>({ dialect });
}
