-- Event store schema (FND-01, FND-02).
--
-- Three concerns:
--   1. `streams`               — per-stream version, the optimistic-concurrency
--                                CAS guard (UPDATE ... WHERE version = expected).
--   2. `events`                — the append-only log. `global_seq` is the total
--                                order for replay (NEVER order by timestamp);
--                                UNIQUE(stream_id, version) is the backstop guard.
--   3. `projection_checkpoints`— per-projection last-applied `global_seq`
--                                (async catch-up projections, Plan 04+).
--
-- All DDL is idempotent (IF NOT EXISTS) so `migrate()` is safe on every boot.
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

-- Inline `hubs` read-model (operational twin's hub view), upserted in the SAME
-- transaction as the append for read-your-writes consistency (PITFALLS P5a).
CREATE TABLE IF NOT EXISTS hubs (
  hub_id TEXT PRIMARY KEY,
  name   TEXT             NOT NULL,
  lat    DOUBLE PRECISION NOT NULL,
  lon    DOUBLE PRECISION NOT NULL
);
