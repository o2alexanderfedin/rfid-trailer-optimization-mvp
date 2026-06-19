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
