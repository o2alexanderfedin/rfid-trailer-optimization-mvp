-- Operational-twin projection schema (FND-05/06/07), built by @mm/projections.
--
-- These read models are DERIVED state: they are fully reconstructable by
-- replaying the event log from global_seq=0 (FND-04 golden replay). They are
-- therefore disposable — `rebuildProjections` TRUNCATEs them and replays.
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

-- FND-06: a trailer's current state / assignment. `driver_id` (PRJ-02) is the
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
-- it, `WHERE current_hub_id = :hubId` is a full-table scan per hub click.
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
-- driver). The HOS-derived numbers (`remaining_drive_minutes`,
-- `duty_window_deadline`) are computed by the Phase-10 engine from the HosClock
-- snapshot in DriverDutyStateChanged; `duty_window_deadline` is the 14h ABSOLUTE
-- deadline (nullable until the first duty transition carries a clock). Feeds the
-- Phase-14 hub-detail panel (driver duty status + remaining legal drive time).
-- OPT-HOS-02: `hos_clock` persists the FULL per-shift HosClock snapshot (JSONB,
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

-- CATCH-UP (M-4): the in-flight trip -> leg index. A `TrailerDeparted` records
-- the trip's ACTUAL leg here; the matching `TrailerArrivedAtHub` reads it to
-- place the arrival keyframe on the correct leg (vs a lexicographic guess), then
-- deletes the row. Persisting it makes incremental catch-up resolve identically
-- to a full rebuild even when departure and arrival fall in different passes.
CREATE TABLE IF NOT EXISTS geo_inflight_trip (
  trip_id     TEXT PRIMARY KEY,
  from_hub_id TEXT NOT NULL,
  to_hub_id   TEXT NOT NULL
);
