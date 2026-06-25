import type { ColumnType, Selectable } from "kysely";
import type { HosClock } from "@mm/domain";

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
  /** PRJ-02: the driver bound to the trailer's trip (join-free hub detail). */
  driver_id: string | null;
  last_event_at: ColumnType<Date, string | Date, string | Date>;
}

/**
 * PRJ-01/PRJ-02: a driver's current duty status + HOS summary, one row per
 * driver. `driver_id` is the identity so re-applying a fold is an idempotent
 * upsert. The HOS-derived fields are computed by the Phase-10 engine from the
 * `HosClock` snapshot carried in `DriverDutyStateChanged`; `duty_window_deadline`
 * is the 14h ABSOLUTE deadline (nullable until the first duty transition).
 */
export interface DriverStatusTable {
  driver_id: string;
  status: string;
  remaining_drive_minutes: number;
  duty_window_deadline: ColumnType<Date, string | Date, string | Date> | null;
  total_driven_minutes: number;
  weekly_on_duty_min: number;
  /**
   * OPT-HOS-02: the FULL per-shift HosClock snapshot, persisted as JSONB so the
   * rolling optimizer's HARD HOS gate re-walks every driving leg through the
   * Phase-10 engine. Read back as a parsed `HosClock`, written as a JSON string
   * (the `pg` JSONB convention used by `zone_estimate.posterior`). `null` until
   * the first duty transition carries a clock.
   */
  hos_clock: ColumnType<HosClock, string, string> | null;
  current_hub_id: string | null;
  current_trip_id: string | null;
  last_event_at: ColumnType<Date, string | Date, string | Date>;
}

/**
 * PRJ-02: the driver↔trip/trailer assignment row (one per driver), for join-free
 * hub-detail queries. `driver_id` is the identity; `trip_id`/`trailer_id` are
 * `null` when the driver is free (e.g. after a relay swap releases the outgoing
 * driver). `hub_id` is the hub the driver is currently at.
 */
export interface DriverAssignmentTable {
  driver_id: string;
  trip_id: string | null;
  trailer_id: string | null;
  hub_id: string | null;
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
 * FND-08 / UI-02 (catch-up): one ordered audit-timeline row per stored event
 * that names a package or trailer. `global_seq` is the row identity AND the
 * strict order. Exactly one of `package_id` / `trailer_id` is non-null per row:
 *  - Package events: `package_id` set, `trailer_id` null.
 *  - Trailer / plan-lifecycle events: `trailer_id` set, `package_id` null.
 * `recommendation` carries the captured system recommendation for plan-lifecycle
 * events (anti-repudiation, T-05-09); null for all other event types.
 */
export interface AuditTimelineTable {
  global_seq: ColumnType<bigint, string, string>;
  package_id: string | null;
  trailer_id: string | null;
  event_type: string;
  occurred_at: ColumnType<Date, string | Date, string | Date>;
  hub_id: string | null;
  scan_type: string | null;
  recommendation: string | null;
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
 * is `(trailer_id, trip_id, kind, t)` — one depart + one arrive per trip, PLUS any
 * SP2 mid-leg `rested`/`refueling` stops distinguished by their time (spec §6).
 * `duration_minutes` is the stop's park length (null for depart/arrive).
 */
export interface GeoKeyframeTable {
  trailer_id: string;
  trip_id: string;
  kind: string;
  t: ColumnType<Date, string | Date, string | Date>;
  lon: number;
  lat: number;
  duration_minutes: number | null;
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
  /**
   * SP2 (spec §6): the trip's `TrailerDeparted` occurredAt — the anchor a mid-leg
   * `rested`/`refueling` stop interpolates against. Nullable so a row written by a
   * pre-SP2 build (or an incremental pass before this column existed) reads back as
   * `null`; the stop interpolation falls back to fraction 0 (the leg origin) in
   * that case. Written as ISO text, read back as a Date|string.
   */
  depart_at: ColumnType<Date, string | Date, string | Date> | null;
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
export type DriverStatusRow = Selectable<DriverStatusTable>;
export type DriverAssignmentRow = Selectable<DriverAssignmentTable>;
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
  driver_status: DriverStatusTable;
  driver_assignment: DriverAssignmentTable;
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
  "driver-status",
  "driver-assignment",
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

-- FND-06: a trailer's current state / assignment. \`driver_id\` (PRJ-02) is the
-- driver bound to the trailer's trip, stamped from the driver-lifecycle events so
-- the hub-detail panel reads it join-free.
CREATE TABLE IF NOT EXISTS trailer_state (
  trailer_id           TEXT PRIMARY KEY,
  status               TEXT        NOT NULL,
  current_hub_id       TEXT,
  trip_id              TEXT,
  dock_door_id         TEXT,
  assigned_package_ids JSONB       NOT NULL DEFAULT '[]'::jsonb,
  driver_id            TEXT,
  last_event_at        TIMESTAMPTZ NOT NULL
);

-- PRJ-02: a reverse index for the hub-detail query (trailers AT a hub). Without
-- it, \`WHERE current_hub_id = :hubId\` is a full-table scan per hub click.
CREATE INDEX IF NOT EXISTS idx_trailer_state_current_hub
  ON trailer_state (current_hub_id);

-- FND-07: per-hub inventory, bucketed inbound / outbound / staged.
CREATE TABLE IF NOT EXISTS hub_inventory (
  hub_id   TEXT PRIMARY KEY,
  inbound  JSONB NOT NULL DEFAULT '[]'::jsonb,
  outbound JSONB NOT NULL DEFAULT '[]'::jsonb,
  staged   JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- PRJ-01/PRJ-02: a driver's current duty status + HOS summary (one row per
-- driver). The HOS-derived numbers (\`remaining_drive_minutes\`,
-- \`duty_window_deadline\`) are computed by the Phase-10 engine from the HosClock
-- snapshot in DriverDutyStateChanged; \`duty_window_deadline\` is the 14h ABSOLUTE
-- deadline (nullable until the first duty transition carries a clock). Feeds the
-- Phase-14 hub-detail panel (driver duty status + remaining legal drive time).
-- OPT-HOS-02: \`hos_clock\` persists the FULL per-shift HosClock snapshot (JSONB,
-- mirroring zone_estimate.posterior) so the rolling optimizer's HARD HOS gate can
-- re-walk every driving leg through the Phase-10 engine; null until the first duty
-- transition carries a clock.
CREATE TABLE IF NOT EXISTS driver_status (
  driver_id               TEXT PRIMARY KEY,
  status                  TEXT        NOT NULL,
  remaining_drive_minutes INTEGER     NOT NULL DEFAULT 0,
  duty_window_deadline    TIMESTAMPTZ,
  total_driven_minutes    INTEGER     NOT NULL DEFAULT 0,
  weekly_on_duty_min      INTEGER     NOT NULL DEFAULT 0,
  hos_clock               JSONB,
  current_hub_id          TEXT,
  current_trip_id         TEXT,
  last_event_at           TIMESTAMPTZ NOT NULL
);

-- PRJ-02: the driver -> trip/trailer assignment (one row per driver) for
-- join-free hub-detail queries. trip_id/trailer_id are null when the driver is
-- free (e.g. after a relay swap releases the outgoing driver).
CREATE TABLE IF NOT EXISTS driver_assignment (
  driver_id     TEXT PRIMARY KEY,
  trip_id       TEXT,
  trailer_id    TEXT,
  hub_id        TEXT,
  last_event_at TIMESTAMPTZ NOT NULL
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

-- FND-08 (CATCH-UP): a package's OR a trailer's ordered audit timeline. One row
-- per stored event that names a package or trailer; global_seq is the identity
-- AND the strict order. Exactly one of package_id / trailer_id is non-null per
-- row (package events use package_id; trailer / plan-lifecycle events use
-- trailer_id). recommendation captures the system recommendation at decision
-- events (PlanGenerated/PlanAccepted) for anti-repudiation (T-05-09).
CREATE TABLE IF NOT EXISTS audit_timeline (
  global_seq     BIGINT PRIMARY KEY,
  package_id     TEXT,
  trailer_id     TEXT,
  event_type     TEXT        NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  hub_id         TEXT,
  scan_type      TEXT,
  recommendation TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timeline_package
  ON audit_timeline (package_id, global_seq);

CREATE INDEX IF NOT EXISTS idx_audit_timeline_trailer
  ON audit_timeline (trailer_id, global_seq);

-- CATCH-UP: the route geometry index, folded incrementally from RouteRegistered
-- so keyframe resolution never re-scans the log. geometry is a JSONB [lon,lat][].
CREATE TABLE IF NOT EXISTS geo_route (
  from_hub_id TEXT  NOT NULL,
  to_hub_id   TEXT  NOT NULL,
  geometry    JSONB NOT NULL,
  PRIMARY KEY (from_hub_id, to_hub_id)
);

-- CATCH-UP: per-trip trailer position keyframes for the live map. Identity is
-- (trailer_id, trip_id, kind, t): one depart + one arrive per trip, PLUS any
-- number of SP2 mid-leg rested/refueling stops distinguished by their time
-- (spec §6). Including \`t\` keeps re-folding the same event idempotent (same time
-- ⇒ same row) while letting multiple stops on one leg coexist. \`duration_minutes\`
-- is the stop's park length (NULL for depart/arrive — a leg endpoint has no dwell).
CREATE TABLE IF NOT EXISTS geo_keyframe (
  trailer_id       TEXT             NOT NULL,
  trip_id          TEXT             NOT NULL,
  kind             TEXT             NOT NULL,
  t                TIMESTAMPTZ      NOT NULL,
  lon              DOUBLE PRECISION NOT NULL,
  lat              DOUBLE PRECISION NOT NULL,
  duration_minutes INTEGER,
  PRIMARY KEY (trailer_id, trip_id, kind, t)
);

ALTER TABLE geo_keyframe ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;

-- CATCH-UP (M-4): the in-flight trip -> leg index. A \`TrailerDeparted\` records
-- the trip's ACTUAL leg here; the matching \`TrailerArrivedAtHub\` reads it to
-- place the arrival keyframe on the correct leg (vs a lexicographic guess), then
-- deletes the row. Persisting it makes incremental catch-up resolve identically
-- to a full rebuild even when departure and arrival fall in different passes.
CREATE TABLE IF NOT EXISTS geo_inflight_trip (
  trip_id     TEXT PRIMARY KEY,
  from_hub_id TEXT NOT NULL,
  to_hub_id   TEXT NOT NULL,
  -- SP2: the trip's depart time, the anchor a mid-leg rest/refuel stop
  -- interpolates against (spec §6). Nullable + ADD-IF-NOT-EXISTS so an existing
  -- DB upgrades cleanly on the next idempotent boot.
  depart_at   TIMESTAMPTZ
);

ALTER TABLE geo_inflight_trip ADD COLUMN IF NOT EXISTS depart_at TIMESTAMPTZ;
`;
