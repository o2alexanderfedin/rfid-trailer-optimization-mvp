import { type Kysely, sql } from "kysely";
import type { Database } from "./schema.js";
import { SCHEMA_SQL } from "./schema.js";

/**
 * Apply the idempotent event-store schema (streams + events +
 * projection_checkpoints + the inline hubs projection). Safe to call
 * repeatedly — every statement is `IF NOT EXISTS`.
 */
export async function migrate(db: Kysely<Database>): Promise<void> {
  await sql.raw(SCHEMA_SQL).execute(db);
}
