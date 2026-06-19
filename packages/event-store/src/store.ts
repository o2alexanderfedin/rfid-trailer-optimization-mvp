import { type Kysely, type Transaction, sql } from "kysely";
import { type DomainEvent, parseDomainEvent } from "@mm/domain";
import { type HubProjectionWrite, projectHub } from "@mm/projections";
import type { Database, EventRow, HubRow } from "./schema.js";
import { ConcurrencyError } from "./errors.js";

/** Postgres SQLSTATE for unique_violation. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Append events to a stream with optimistic concurrency, AND apply the inline
 * `hubs` projection in the SAME transaction (read-your-writes consistency).
 *
 * Contract (PITFALLS P4):
 *  - `expectedVersion` is the version the caller believes the stream is at
 *    (0 for a brand-new stream). The first appended event gets
 *    `expectedVersion + 1`, then increments.
 *  - On version mismatch (or a concurrent 23505 race) throws `ConcurrencyError`;
 *    the transaction rolls back, leaving no gaps or duplicate versions.
 *
 * `occurredAt` is injected (not read from a clock here) so the caller controls
 * time; the store records it as the authoritative `occurred_at`.
 */
export async function append(
  db: Kysely<Database>,
  streamId: string,
  expectedVersion: number,
  events: readonly DomainEvent[],
  occurredAt: Date,
): Promise<void> {
  if (events.length === 0) return;
  // Validate at the ingestion boundary (FND-03) before any write.
  for (const e of events) parseDomainEvent(e);

  try {
    await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("events")
        .select((eb) => eb.fn.max("version").as("maxVersion"))
        .where("stream_id", "=", streamId)
        .executeTakeFirst();

      const actualVersion = Number(current?.maxVersion ?? 0);
      if (actualVersion !== expectedVersion) {
        throw new ConcurrencyError(streamId, expectedVersion, actualVersion);
      }

      let version = expectedVersion;
      const projectionWrites: HubProjectionWrite[] = [];
      for (const event of events) {
        version += 1;
        await trx
          .insertInto("events")
          .values({
            stream_id: streamId,
            version,
            event_type: event.type,
            data: JSON.stringify(event.payload),
            metadata: JSON.stringify({ schemaVersion: event.schemaVersion }),
            occurred_at: occurredAt,
          })
          .execute();
        projectionWrites.push(...projectHub(event));
      }

      await applyHubWrites(trx, projectionWrites);
    });
  } catch (err) {
    if (err instanceof ConcurrencyError) throw err;
    if (isUniqueViolation(err)) {
      throw new ConcurrencyError(streamId, expectedVersion, undefined);
    }
    throw err;
  }
}

/** Idempotent upsert of hub rows (PITFALLS P5a) within the append transaction. */
async function applyHubWrites(
  trx: Transaction<Database>,
  writes: readonly HubProjectionWrite[],
): Promise<void> {
  for (const w of writes) {
    await trx
      .insertInto("hubs")
      .values({
        hub_id: w.row.hubId,
        name: w.row.name,
        lat: w.row.lat,
        lon: w.row.lon,
      })
      .onConflict((oc) =>
        oc.column("hub_id").doUpdateSet({
          name: w.row.name,
          lat: w.row.lat,
          lon: w.row.lon,
        }),
      )
      .execute();
  }
}

/** Read a single stream's events in version order. */
export async function readStream(
  db: Kysely<Database>,
  streamId: string,
): Promise<EventRow[]> {
  return db
    .selectFrom("events")
    .selectAll()
    .where("stream_id", "=", streamId)
    .orderBy("version", "asc")
    .execute();
}

/** Read all events from a global position, in total (`global_seq`) order. */
export async function readAll(
  db: Kysely<Database>,
  fromGlobalSeq = 0,
): Promise<EventRow[]> {
  return db
    .selectFrom("events")
    .selectAll()
    .where("global_seq", ">", sql<string>`${fromGlobalSeq}`)
    .orderBy("global_seq", "asc")
    .execute();
}

/** Read the inline hubs projection (the operational twin's hub view). */
export async function getHubs(db: Kysely<Database>): Promise<HubRow[]> {
  return db.selectFrom("hubs").selectAll().orderBy("hub_id", "asc").execute();
}
