import type { ColumnType, Generated, Insertable, Selectable } from "kysely";
import type { DomainEventType } from "@mm/domain";

/**
 * Kysely table interfaces for the event store + the inline `hubs` projection.
 *
 * `events` is the append-only log:
 *  - `global_seq`  : total order for replay (GENERATED ALWAYS AS IDENTITY).
 *                    Replay/projection ALWAYS orders by this, never by time.
 *  - `(stream_id, version)` UNIQUE enforces optimistic concurrency (P4).
 *  - `data`        : the event payload as JSONB.
 *  - `occurred_at` : authoritative timestamp set at the persistence boundary.
 */
export interface EventsTable {
  global_seq: Generated<string>;
  stream_id: string;
  version: number;
  event_type: DomainEventType;
  data: ColumnType<unknown, string, string>;
  metadata: ColumnType<unknown, string, string>;
  occurred_at: ColumnType<Date, string | Date, string | Date>;
}

export type EventRow = Selectable<EventsTable>;
export type NewEventRow = Insertable<EventsTable>;

/** Inline read-model projected from `HubRegistered`, keyed by `hub_id`. */
export interface HubsTable {
  hub_id: string;
  name: string;
  lat: number;
  lon: number;
}

export type HubRow = Selectable<HubsTable>;

export interface Database {
  events: EventsTable;
  hubs: HubsTable;
}

/**
 * DDL for the event store + projection. Idempotent (IF NOT EXISTS) so it is
 * safe to run on every connection / container boot.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  global_seq  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_id   TEXT        NOT NULL,
  version     INT         NOT NULL,
  event_type  TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_events_stream_version UNIQUE (stream_id, version)
);

CREATE INDEX IF NOT EXISTS idx_events_stream_version ON events (stream_id, version);

CREATE TABLE IF NOT EXISTS hubs (
  hub_id TEXT PRIMARY KEY,
  name   TEXT             NOT NULL,
  lat    DOUBLE PRECISION NOT NULL,
  lon    DOUBLE PRECISION NOT NULL
);
`;
