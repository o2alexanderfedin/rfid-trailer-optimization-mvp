import { type Kysely, type Transaction, sql } from "kysely";
import { type DomainEvent, validateEvent } from "@mm/domain";
import { type HubProjectionWrite, projectHub } from "@mm/projections";
import type { Database, EventRow } from "./schema.js";
import { ConcurrencyError } from "./errors.js";

/** Postgres SQLSTATE for unique_violation (the UNIQUE(stream_id, version) backstop). */
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
 * The persisted form of a domain event read back from the log.
 *
 *  - `globalSeq`  : the monotonic total-order position (bigint). Replay/readAll
 *                   order by THIS, never by a timestamp.
 *  - `version`    : the per-stream version (1..N).
 *  - `event`      : the typed `DomainEvent` rehydrated from JSONB `data`.
 *  - `occurredAt` : domain time (caller's clock), ISO string.
 *  - `recordedAt` : DB wall-clock time the row was written, ISO string.
 */
export interface StoredEvent {
  readonly globalSeq: bigint;
  readonly streamId: string;
  readonly version: number;
  readonly event: DomainEvent;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** Derive the stream type from its id prefix (e.g. `trailer-T42` -> `trailer`). */
function streamTypeOf(streamId: string): string {
  const dash = streamId.indexOf("-");
  return dash > 0 ? streamId.slice(0, dash) : streamId;
}

/**
 * Append events to a stream with optimistic concurrency (FND-02), in ONE
 * transaction.
 *
 * Concurrency is guarded two ways, defense-in-depth:
 *  (a) a per-stream compare-and-set: `UPDATE streams SET version = version + N
 *      WHERE stream_id = $1 AND version = expectedVersion`. Zero rows affected
 *      means a concurrent writer already advanced the version -> conflict, BEFORE
 *      any event is inserted. This is the structurally-tight primary guard.
 *  (b) the `UNIQUE(stream_id, version)` constraint on `events` as the backstop:
 *      if two transactions somehow pass (a) and race the inserts, Postgres
 *      rejects the loser with SQLSTATE 23505.
 * Both map to a typed `ConcurrencyError`; the transaction rolls back fully, so a
 * conflict leaves ZERO partial inserts and no version gaps/duplicates.
 *
 * Each event is validated with the domain `validateEvent` boundary before any
 * write (defense in depth, FND-03). `occurredAt` is the caller-supplied DOMAIN
 * clock (never a DB clock here); `recorded_at` is the only DB-clock field.
 *
 * @returns the stream's new version after the append.
 */
export async function appendToStream(
  db: Kysely<Database>,
  streamId: string,
  expectedVersion: number,
  events: readonly DomainEvent[],
  occurredAt: Date,
): Promise<{ newVersion: number }> {
  if (events.length === 0) return { newVersion: expectedVersion };
  // Validate at the ingestion boundary (FND-03) before any write.
  const validated = events.map((e) => validateEvent(e));

  try {
    return await db.transaction().execute(async (trx) => {
      await casStreamVersion(trx, streamId, expectedVersion, validated.length);

      let version = expectedVersion;
      for (const event of validated) {
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
      }
      return { newVersion: version };
    });
  } catch (err) {
    throw normalizeConflict(err, streamId, expectedVersion);
  }
}

/**
 * Compare-and-set the per-stream version (primary OCC guard). For a brand-new
 * stream (`expectedVersion === 0`) we first try to claim the `streams` row; if
 * it already exists the conditional UPDATE below resolves the conflict cleanly.
 */
async function casStreamVersion(
  trx: Transaction<Database>,
  streamId: string,
  expectedVersion: number,
  count: number,
): Promise<void> {
  if (expectedVersion === 0) {
    // Claim a fresh stream row. `DO NOTHING` on conflict so a pre-existing
    // stream falls through to the conditional UPDATE (which will see a
    // non-zero version and report the conflict).
    await trx
      .insertInto("streams")
      .values({ stream_id: streamId, stream_type: streamTypeOf(streamId) })
      .onConflict((oc) => oc.column("stream_id").doNothing())
      .execute();
  }

  const updated = await trx
    .updateTable("streams")
    .set((eb) => ({ version: eb("version", "+", count) }))
    .where("stream_id", "=", streamId)
    .where("version", "=", expectedVersion)
    .executeTakeFirst();

  if (Number(updated.numUpdatedRows) === 0) {
    throw new ConcurrencyError(streamId, expectedVersion);
  }
}

/** Map a raw error into a typed `ConcurrencyError` where appropriate. */
function normalizeConflict(
  err: unknown,
  streamId: string,
  expectedVersion: number,
): unknown {
  if (err instanceof ConcurrencyError) return err;
  if (isUniqueViolation(err)) {
    return new ConcurrencyError(streamId, expectedVersion);
  }
  return err;
}

/** Options for {@link appendWithRetry}. */
export interface AppendRetryOptions {
  /** Max retries AFTER the first attempt (default 3). */
  readonly maxRetries?: number;
  /**
   * Compute the `expectedVersion` to append at from the freshly-reloaded
   * current version. Defaults to identity (append at the current head). Override
   * only for tests / advanced control.
   */
  readonly expectedVersion?: (currentVersion: number) => number;
}

/**
 * Append with bounded retry-on-conflict (FND-02 retry path). On every attempt it
 * reloads the stream's current version, lets `build` produce the events for that
 * version, and appends. A `ConcurrencyError` (a concurrent writer won the race)
 * triggers a reload + retry, up to `maxRetries`. Any other error propagates.
 *
 * This is how a losing writer recovers: reload, rebuild against current state,
 * retry — converging without gaps or duplicates.
 */
export async function appendWithRetry(
  db: Kysely<Database>,
  streamId: string,
  build: (currentVersion: number) => readonly DomainEvent[],
  occurredAt: Date,
  options: AppendRetryOptions = {},
): Promise<{ newVersion: number }> {
  const maxRetries = options.maxRetries ?? 3;
  const expectedOf = options.expectedVersion ?? ((v: number): number => v);

  let attempt = 0;
  for (;;) {
    const current = await currentVersion(db, streamId);
    const expected = expectedOf(current);
    const events = build(current);
    try {
      return await appendToStream(db, streamId, expected, events, occurredAt);
    } catch (err) {
      if (err instanceof ConcurrencyError && attempt < maxRetries) {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

/** The current version of a stream (0 if it has no events yet). */
async function currentVersion(
  db: Kysely<Database>,
  streamId: string,
): Promise<number> {
  const row = await db
    .selectFrom("streams")
    .select("version")
    .where("stream_id", "=", streamId)
    .executeTakeFirst();
  return row?.version ?? 0;
}

/** Map a persisted row to the typed {@link StoredEvent}. */
function toStoredEvent(row: EventRow): StoredEvent {
  // `data` (payload) + `metadata` (schemaVersion) reconstitute the envelope,
  // then re-validate so what we hand callers is a proven `DomainEvent`.
  const meta = row.metadata as { schemaVersion?: unknown };
  const event = validateEvent({
    type: row.event_type,
    schemaVersion: meta.schemaVersion,
    payload: row.data,
  });
  return {
    globalSeq: BigInt(row.global_seq),
    streamId: row.stream_id,
    version: row.version,
    event,
    occurredAt: toIso(row.occurred_at),
    recordedAt: toIso(row.recorded_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Read a single stream's events in version order (FND-01). */
export async function readStream(
  db: Kysely<Database>,
  streamId: string,
): Promise<StoredEvent[]> {
  const rows = await db
    .selectFrom("events")
    .selectAll()
    .where("stream_id", "=", streamId)
    .orderBy("version", "asc")
    .execute();
  return rows.map(toStoredEvent);
}

/**
 * Read all events strictly after `fromGlobalSeq`, in total (`global_seq`) order
 * — the projection-rebuild read path. Ordering is by `global_seq`, NEVER by a
 * timestamp (FND-02 / threat T-01-10).
 */
export async function readAll(
  db: Kysely<Database>,
  fromGlobalSeq: bigint = 0n,
): Promise<StoredEvent[]> {
  const rows = await db
    .selectFrom("events")
    .selectAll()
    .where("global_seq", ">", sql<string>`${fromGlobalSeq.toString()}`)
    .orderBy("global_seq", "asc")
    .execute();
  return rows.map(toStoredEvent);
}

// ---------------------------------------------------------------------------
// Walking-skeleton spine compatibility: the original `append` ALSO applies the
// inline `hubs` projection in the same transaction (read-your-writes). It is
// kept (delegating to the same CAS guard) so the Plan-01 spine — seed + GET
// /hubs — stays green. New callers should use `appendToStream`.
// ---------------------------------------------------------------------------

/**
 * Append events AND apply the inline `hubs` projection in the SAME transaction.
 * Same optimistic-concurrency contract as {@link appendToStream}.
 */
export async function append(
  db: Kysely<Database>,
  streamId: string,
  expectedVersion: number,
  events: readonly DomainEvent[],
  occurredAt: Date,
): Promise<void> {
  if (events.length === 0) return;
  const validated = events.map((e) => validateEvent(e));

  try {
    await db.transaction().execute(async (trx) => {
      await casStreamVersion(trx, streamId, expectedVersion, validated.length);

      let version = expectedVersion;
      const projectionWrites: HubProjectionWrite[] = [];
      for (const event of validated) {
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
    throw normalizeConflict(err, streamId, expectedVersion);
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

/** Read the inline hubs projection (the operational twin's hub view). */
export async function getHubs(db: Kysely<Database>) {
  return db.selectFrom("hubs").selectAll().orderBy("hub_id", "asc").execute();
}
