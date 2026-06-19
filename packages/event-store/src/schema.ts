import type { ColumnType, Generated, Insertable, Selectable } from "kysely";
import type { DomainEventType } from "@mm/domain";

/**
 * Kysely table interfaces for the event store (FND-01, FND-02) + the inline
 * `hubs` projection.
 *
 * `events` is the append-only log:
 *  - `global_seq`  : total order for replay (GENERATED ALWAYS AS IDENTITY).
 *                    Replay/projection ALWAYS orders by this, never by time.
 *  - `(stream_id, version)` UNIQUE is the optimistic-concurrency BACKSTOP (P4).
 *  - `data`        : the event payload as JSONB.
 *  - `metadata`    : envelope metadata (e.g. `schemaVersion`) as JSONB.
 *  - `occurred_at` : DOMAIN time, supplied by the caller's clock (never a DB
 *                    clock) so replay/sim are deterministic.
 *  - `recorded_at` : the ONLY DB-clock field (wall time the row was written).
 */
export interface EventsTable {
  global_seq: Generated<string>;
  stream_id: string;
  version: number;
  event_type: DomainEventType;
  data: ColumnType<unknown, string, string>;
  metadata: ColumnType<unknown, string, string>;
  occurred_at: ColumnType<Date, string | Date, string | Date>;
  // DB-clock field: defaulted by Postgres (never inserted/updated from app code).
  recorded_at: ColumnType<Date, never, never>;
}

export type EventRow = Selectable<EventsTable>;
export type NewEventRow = Insertable<EventsTable>;

/**
 * Per-stream version row — the primary optimistic-concurrency guard. Appends do
 * a conditional `UPDATE ... WHERE version = expectedVersion` (a compare-and-set):
 * 0 rows affected == a conflict, caught BEFORE any event insert.
 */
export interface StreamsTable {
  stream_id: string;
  stream_type: string;
  version: Generated<number>;
}

export type StreamRow = Selectable<StreamsTable>;

/** Per-projection last-applied `global_seq` for async catch-up (Plan 04+). */
export interface ProjectionCheckpointsTable {
  projection: string;
  last_seq: Generated<string>;
}

/** Inline read-model projected from `HubRegistered`, keyed by `hub_id`. */
export interface HubsTable {
  hub_id: string;
  name: string;
  lat: number;
  lon: number;
}

export type HubRow = Selectable<HubsTable>;

export interface Database {
  streams: StreamsTable;
  events: EventsTable;
  projection_checkpoints: ProjectionCheckpointsTable;
  hubs: HubsTable;
}

/**
 * DDL for the event store + inline projection. The byte-identical canonical
 * source lives in `schema.sql` (the reviewable artifact); a unit test asserts
 * the two never drift. Embedding it here keeps `migrate()` dependency-free at
 * runtime (no asset-copy step needed under `tsc -b`). Idempotent (IF NOT
 * EXISTS), so safe to run on every connection / container boot.
 */
export const SCHEMA_SQL = `-- Event store schema (FND-01, FND-02).
--
-- Three concerns:
--   1. \`streams\`               — per-stream version, the optimistic-concurrency
--                                CAS guard (UPDATE ... WHERE version = expected).
--   2. \`events\`                — the append-only log. \`global_seq\` is the total
--                                order for replay (NEVER order by timestamp);
--                                UNIQUE(stream_id, version) is the backstop guard.
--   3. \`projection_checkpoints\`— per-projection last-applied \`global_seq\`
--                                (async catch-up projections, Plan 04+).
--
-- All DDL is idempotent (IF NOT EXISTS) so \`migrate()\` is safe on every boot.
-- Events are STRICTLY append-only: the store API exposes no UPDATE/DELETE path
-- (threat T-01-08); corrections are modeled as new corrective events.

CREATE TABLE IF NOT EXISTS streams (
  stream_id   TEXT PRIMARY KEY,
  stream_type TEXT NOT NULL,
  version     INT  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  global_seq  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_id   TEXT        NOT NULL REFERENCES streams (stream_id),
  version     INT         NOT NULL,
  event_type  TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_events_stream_version UNIQUE (stream_id, version)
);

CREATE INDEX IF NOT EXISTS idx_events_stream_version ON events (stream_id, version);
CREATE INDEX IF NOT EXISTS idx_events_type_global_seq ON events (event_type, global_seq);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection TEXT   PRIMARY KEY,
  last_seq   BIGINT NOT NULL DEFAULT 0
);

-- Inline \`hubs\` read-model (operational twin's hub view), upserted in the SAME
-- transaction as the append for read-your-writes consistency (PITFALLS P5a).
CREATE TABLE IF NOT EXISTS hubs (
  hub_id TEXT PRIMARY KEY,
  name   TEXT             NOT NULL,
  lat    DOUBLE PRECISION NOT NULL,
  lon    DOUBLE PRECISION NOT NULL
);
`;
