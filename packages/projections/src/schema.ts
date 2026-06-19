import type { ColumnType, Selectable } from "kysely";

/**
 * Kysely table interfaces + DDL for the operational-twin projections
 * (FND-05/06/07). These read models are derived, disposable state: rebuildable
 * from the event log by replaying from global_seq=0 (FND-04).
 *
 * The canonical, reviewable DDL lives in `schema.sql`; the embedded
 * `PROJECTIONS_SCHEMA_SQL` string is kept byte-identical to it (a unit test
 * guards against drift, mirroring the event-store convention). Embedding it
 * keeps runtime migration asset-free under `tsc -b`.
 */

/** FND-05: package last-known location row. */
export interface PackageLocationTable {
  package_id: string;
  hub_id: string;
  confidence: number;
  last_seen_at: ColumnType<Date, string | Date, string | Date>;
}

/** FND-06: trailer current-state row. JSONB manifest read as a string[]. */
export interface TrailerStateTable {
  trailer_id: string;
  status: string;
  current_hub_id: string | null;
  trip_id: string | null;
  dock_door_id: string | null;
  assigned_package_ids: ColumnType<string[], string, string>;
  last_event_at: ColumnType<Date, string | Date, string | Date>;
}

/** FND-07: per-hub inventory row. Each bucket is a JSONB string[] of ids. */
export interface HubInventoryTable {
  hub_id: string;
  inbound: ColumnType<string[], string, string>;
  outbound: ColumnType<string[], string, string>;
  staged: ColumnType<string[], string, string>;
}

/**
 * FND-08 (catch-up): one ordered audit-timeline row per stored event that names
 * a package. `global_seq` is the row identity AND the strict order — so the
 * timeline for a package is `WHERE package_id = $1 ORDER BY global_seq`.
 */
export interface AuditTimelineTable {
  global_seq: ColumnType<bigint, string, string>;
  package_id: string;
  event_type: string;
  occurred_at: ColumnType<Date, string | Date, string | Date>;
  hub_id: string | null;
  scan_type: string | null;
}

/**
 * Geo-track (catch-up): the persisted route geometry index, folded incrementally
 * from `RouteRegistered`. Keyed by the directed hub pair so keyframe resolution
 * reads geometry without re-scanning the log. `geometry` is a JSONB `[lon,lat][]`.
 */
export interface GeoRouteTable {
  from_hub_id: string;
  to_hub_id: string;
  geometry: ColumnType<readonly [number, number][], string, string>;
}

/**
 * Geo-track (catch-up): per-trip trailer position keyframes for the map. Identity
 * is `(trailer_id, trip_id, kind)` — one depart + one arrive per trip.
 */
export interface GeoKeyframeTable {
  trailer_id: string;
  trip_id: string;
  kind: string;
  t: ColumnType<Date, string | Date, string | Date>;
  lon: number;
  lat: number;
}

export type PackageLocationRow = Selectable<PackageLocationTable>;
export type TrailerStateRow = Selectable<TrailerStateTable>;
export type HubInventoryRow = Selectable<HubInventoryTable>;
export type AuditTimelineRow = Selectable<AuditTimelineTable>;
export type GeoRouteRow = Selectable<GeoRouteTable>;
export type GeoKeyframeRow = Selectable<GeoKeyframeTable>;

/**
 * The projection tables this package owns. The inline applier/rebuild driver
 * read+write these; they live in the SAME database as the event store, so the
 * applier's `Kysely`/`Transaction` is typed with the intersection of both
 * schemas at the call site.
 */
export interface ProjectionDatabase {
  package_location: PackageLocationTable;
  trailer_state: TrailerStateTable;
  hub_inventory: HubInventoryTable;
  audit_timeline: AuditTimelineTable;
  geo_route: GeoRouteTable;
  geo_keyframe: GeoKeyframeTable;
}

/**
 * The operational projections owned here, each with its own `last_seq`
 * checkpoint row in `projection_checkpoints` (P5a idempotent fold). The names
 * are stable identifiers used both to gate the inline skip and to reset on
 * rebuild.
 */
export const OPERATIONAL_PROJECTIONS = [
  "package-location",
  "trailer-state",
  "hub-inventory",
] as const;

export type OperationalProjectionName = (typeof OPERATIONAL_PROJECTIONS)[number];

/**
 * The CATCH-UP (async) projections (Plan 06), each with its own `last_seq`
 * checkpoint row. A background poller advances each from its checkpoint via
 * `readAll(fromSeq)`, applying idempotent upserts; a full rebuild truncates the
 * table, resets the checkpoint to 0, and replays the whole log.
 */
export const CATCHUP_PROJECTIONS = ["audit-timeline", "geo-track"] as const;

export type CatchupProjectionName = (typeof CATCHUP_PROJECTIONS)[number];

/** Idempotent DDL for the operational-twin projection tables (FND-05/06/07). */
export const PROJECTIONS_SCHEMA_SQL = `-- Operational-twin projection schema (FND-05/06/07), built by @mm/projections.
--
-- These read models are DERIVED state: they are fully reconstructable by
-- replaying the event log from global_seq=0 (FND-04 golden replay). They are
-- therefore disposable — \`rebuildProjections\` TRUNCATEs them and replays.
--
-- All DDL is idempotent (IF NOT EXISTS) so it is safe to run on every boot,
-- alongside the event-store schema. Bucket/manifest lists are stored as JSONB
-- arrays of ids kept SORTED by the pure reducers, so the persisted form is
-- byte-stable across a live run and a rebuild (P3 determinism).

-- FND-05: a package's last-known location (+ confidence + timestamp).
CREATE TABLE IF NOT EXISTS package_location (
  package_id   TEXT PRIMARY KEY,
  hub_id       TEXT             NOT NULL,
  confidence   DOUBLE PRECISION NOT NULL,
  last_seen_at TIMESTAMPTZ      NOT NULL
);

-- FND-06: a trailer's current state / assignment.
CREATE TABLE IF NOT EXISTS trailer_state (
  trailer_id           TEXT PRIMARY KEY,
  status               TEXT        NOT NULL,
  current_hub_id       TEXT,
  trip_id              TEXT,
  dock_door_id         TEXT,
  assigned_package_ids JSONB       NOT NULL DEFAULT '[]'::jsonb,
  last_event_at        TIMESTAMPTZ NOT NULL
);

-- FND-07: per-hub inventory, bucketed inbound / outbound / staged.
CREATE TABLE IF NOT EXISTS hub_inventory (
  hub_id   TEXT PRIMARY KEY,
  inbound  JSONB NOT NULL DEFAULT '[]'::jsonb,
  outbound JSONB NOT NULL DEFAULT '[]'::jsonb,
  staged   JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- FND-08 (CATCH-UP): a package's ordered audit timeline. One row per stored
-- event that names a package; global_seq is the identity AND the strict order.
CREATE TABLE IF NOT EXISTS audit_timeline (
  global_seq  BIGINT PRIMARY KEY,
  package_id  TEXT        NOT NULL,
  event_type  TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  hub_id      TEXT,
  scan_type   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timeline_package
  ON audit_timeline (package_id, global_seq);

-- CATCH-UP: the route geometry index, folded incrementally from RouteRegistered
-- so keyframe resolution never re-scans the log. geometry is a JSONB [lon,lat][].
CREATE TABLE IF NOT EXISTS geo_route (
  from_hub_id TEXT  NOT NULL,
  to_hub_id   TEXT  NOT NULL,
  geometry    JSONB NOT NULL,
  PRIMARY KEY (from_hub_id, to_hub_id)
);

-- CATCH-UP: per-trip trailer position keyframes for the live map. Identity is
-- (trailer_id, trip_id, kind) — one depart + one arrive per trip.
CREATE TABLE IF NOT EXISTS geo_keyframe (
  trailer_id TEXT             NOT NULL,
  trip_id    TEXT             NOT NULL,
  kind       TEXT             NOT NULL,
  t          TIMESTAMPTZ      NOT NULL,
  lon        DOUBLE PRECISION NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (trailer_id, trip_id, kind)
);
`;
