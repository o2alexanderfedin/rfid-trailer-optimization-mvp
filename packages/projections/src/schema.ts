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

/**
 * Geo-track (catch-up / M-4): the in-flight trip -> leg index. A `TrailerDeparted`
 * inserts the trip's leg; the matching `TrailerArrivedAtHub` reads it to resolve
 * the correct arrival leg, then deletes the row. Persisted so incremental
 * catch-up resolves identically to a full rebuild across passes.
 */
export interface GeoInflightTripTable {
  trip_id: string;
  from_hub_id: string;
  to_hub_id: string;
}

/**
 * SNS-02: the tag -> package registry row. Built from `PackageCreated.rfidTagId`;
 * `tag_id` is the identity so re-applying a registration is an idempotent upsert.
 */
export interface TagRegistryTable {
  tag_id: string;
  package_id: string;
}

/**
 * SNS-02/03: the latest fused zone estimate per `(package_id, trailer_id)`. The
 * OBSERVED layer made queryable. `confidence` is the bounded posterior mass of
 * `estimated_zone` (STRICTLY < 1.0 — anti-P5b, inherited from the fusion engine).
 * `posterior` is the full JSONB distribution for auditing. `last_reliable_checkpoint`
 * is the carried-forward known-good anchor (nullable). `(package_id, trailer_id)`
 * is the identity so re-applying a read is an idempotent upsert.
 */
export interface ZoneEstimateTable {
  package_id: string;
  trailer_id: string;
  estimated_zone: string;
  confidence: number;
  posterior: ColumnType<Readonly<Record<string, number>>, string, string>;
  last_reliable_checkpoint: string | null;
  last_observed_at: ColumnType<Date, string | Date, string | Date>;
}

/**
 * SNS-04/05: one OPEN exception row (wrong-trailer / missed-unload). `exception_id`
 * is the stable identity so re-running detection is an idempotent upsert (T-03-16).
 * `hub_id` is the missed-unload stop (nullable for wrong-trailer); `severity` +
 * `recommended_action` make the exception auditable (T-03-18).
 */
export interface ExceptionsTable {
  exception_id: string;
  kind: string;
  package_id: string;
  trailer_id: string;
  hub_id: string | null;
  severity: string;
  recommended_action: string;
  confidence: number;
  occurred_at: ColumnType<Date, string | Date, string | Date>;
}

/**
 * SNS-04/05: the SINGLETON false-positive-rate KPI counters. `id` is a fixed
 * `TRUE` so there is exactly one row. FP-rate = `low_confidence_exceptions /
 * total_exceptions` — a REAL queryable ratio (the demo credibility metric).
 */
export interface ExceptionKpiTable {
  id: ColumnType<boolean, boolean | undefined, never>;
  total_exceptions: ColumnType<bigint, string | number, string | number>;
  low_confidence_exceptions: ColumnType<bigint, string | number, string | number>;
}

export type PackageLocationRow = Selectable<PackageLocationTable>;
export type ExceptionsRow = Selectable<ExceptionsTable>;
export type ExceptionKpiRow = Selectable<ExceptionKpiTable>;
export type TagRegistryRow = Selectable<TagRegistryTable>;
export type ZoneEstimateRow = Selectable<ZoneEstimateTable>;
export type TrailerStateRow = Selectable<TrailerStateTable>;
export type HubInventoryRow = Selectable<HubInventoryTable>;
export type AuditTimelineRow = Selectable<AuditTimelineTable>;
export type GeoRouteRow = Selectable<GeoRouteTable>;
export type GeoKeyframeRow = Selectable<GeoKeyframeTable>;
export type GeoInflightTripRow = Selectable<GeoInflightTripTable>;

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
  tag_registry: TagRegistryTable;
  zone_estimate: ZoneEstimateTable;
  exceptions: ExceptionsTable;
  exception_kpi: ExceptionKpiTable;
  audit_timeline: AuditTimelineTable;
  geo_route: GeoRouteTable;
  geo_keyframe: GeoKeyframeTable;
  geo_inflight_trip: GeoInflightTripTable;
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
  "tag-registry",
  "zone-estimate",
  "exceptions",
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

-- SNS-02: the tag -> package registry, folded from PackageCreated.rfidTagId.
-- tag_id is the identity so re-applying a registration is an idempotent upsert;
-- an unmapped tag simply has no row (resolves to undefined, never an exception).
CREATE TABLE IF NOT EXISTS tag_registry (
  tag_id     TEXT PRIMARY KEY,
  package_id TEXT NOT NULL
);

-- SNS-02/03: the latest fused zone estimate per (package_id, trailer_id) — the
-- OBSERVED layer made queryable. confidence is the bounded posterior mass of
-- estimated_zone (STRICTLY < 1.0, anti-P5b). posterior is the full distribution
-- (JSONB) for auditing; last_reliable_checkpoint is the carried-forward anchor.
CREATE TABLE IF NOT EXISTS zone_estimate (
  package_id               TEXT             NOT NULL,
  trailer_id               TEXT             NOT NULL,
  estimated_zone           TEXT             NOT NULL,
  confidence               DOUBLE PRECISION NOT NULL,
  posterior                JSONB            NOT NULL,
  last_reliable_checkpoint TEXT,
  last_observed_at         TIMESTAMPTZ      NOT NULL,
  PRIMARY KEY (package_id, trailer_id)
);

-- SNS-04/05: the OPEN exceptions feed. One row per detected planned-vs-observed
-- disagreement (wrong-trailer / missed-unload). exception_id is the stable
-- identity so re-running detection is an idempotent upsert (no flood, T-03-16).
-- severity + recommended_action make every exception auditable (T-03-18).
CREATE TABLE IF NOT EXISTS exceptions (
  exception_id      TEXT PRIMARY KEY,
  kind              TEXT             NOT NULL,
  package_id        TEXT             NOT NULL,
  trailer_id        TEXT             NOT NULL,
  hub_id            TEXT,
  severity          TEXT             NOT NULL,
  recommended_action TEXT            NOT NULL,
  confidence        DOUBLE PRECISION NOT NULL,
  occurred_at       TIMESTAMPTZ      NOT NULL
);

-- SNS-04/05: the singleton false-positive-rate KPI counters. total_exceptions is
-- the distinct exceptions ever opened; low_confidence_exceptions is the subset
-- below the secondary confidence band. FP-rate = low / total (a REAL queryable
-- ratio, not a placeholder) — the demo metric proving the feed stays credible.
CREATE TABLE IF NOT EXISTS exception_kpi (
  id                        BOOLEAN PRIMARY KEY DEFAULT TRUE,
  total_exceptions          BIGINT  NOT NULL DEFAULT 0,
  low_confidence_exceptions BIGINT  NOT NULL DEFAULT 0,
  CONSTRAINT exception_kpi_singleton CHECK (id)
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

-- CATCH-UP (M-4): the in-flight trip -> leg index. A \`TrailerDeparted\` records
-- the trip's ACTUAL leg here; the matching \`TrailerArrivedAtHub\` reads it to
-- place the arrival keyframe on the correct leg (vs a lexicographic guess), then
-- deletes the row. Persisting it makes incremental catch-up resolve identically
-- to a full rebuild even when departure and arrival fall in different passes.
CREATE TABLE IF NOT EXISTS geo_inflight_trip (
  trip_id     TEXT PRIMARY KEY,
  from_hub_id TEXT NOT NULL,
  to_hub_id   TEXT NOT NULL
);
`;
