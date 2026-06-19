# Plan 06 Summary — Query API + catch-up projections + ws (rival 2)

**Branch:** wt/p1-06-r2 · **Requirements:** FND-05, FND-06, FND-07, FND-08

## What shipped

### Task 1 — Catch-up (async) projections (`@mm/projections`)
- `reducers/audit-timeline.ts` — `auditTimelineReducer`: pure map of one stored
  event → at most one ordered timeline entry (FND-08). Identity = `global_seq`.
- `reducers/geo-track.ts` — `geoTrackReducer` + `legKey`: pure fold of route
  geometry (`RouteRegistered`) + trailer trip events (`TrailerDeparted` /
  `TrailerArrivedAtHub`) into per-trip `(trailerId, tripId, kind, t, lon, lat)`
  keyframes along the route LineString.
- `runner/catchup.ts` — `runCatchup` (checkpoint-driven poller, idempotent keyed
  upserts), `rebuildCatchup` (truncate + reset checkpoint + replay from 0),
  `readAuditTimeline`, `readGeoKeyframes`, `serializeCatchup`. The geo-track route
  index is persisted (`geo_route` table) and folded INCREMENTALLY, so a steady
  catch-up tick is O(new events), not O(log).
- Schema: added `audit_timeline`, `geo_route`, `geo_keyframe` tables (idempotent
  DDL, byte-identical `schema.sql` ↔ `PROJECTIONS_SCHEMA_SQL`); new catch-up
  checkpoints `audit-timeline`, `geo-track`.

### Task 2 — Fastify query API + ws (`@mm/api`, composition root)
- `routes/queries.ts` — `registerQueryRoutes`: `GET /packages/:id/location`
  (FND-05, 404), `GET /trailers/:id` (FND-06, 404), `GET /hubs/:id/inventory`
  (FND-07), `GET /packages/:id/history` (FND-08, ordered by global_seq),
  `GET /hubs` + `GET /routes` (geo, derived uniformly from the log). All `:id`
  params validated by Fastify JSON schema; all reads parameterized (T-01-18).
- `ws/snapshots.ts` — `attachSnapshotSocket`: `/ws` channel pushing ONE batched
  `{ t:'snapshot', trailers, hubs }` per tick (Anti-Pattern 4 / T-01-19), trailer
  positions from geo-track.
- `server.ts` — `buildServer({ db, enableWs })` composition root (REST + ws +
  CORS); `sim/driver.ts` drives `@mm/simulation` per tick (append → inline twin →
  catch-up → broadcast); `main.ts` runnable entrypoint.
- The Plan 01 skeleton `buildApp`/`GET /hubs`/`HubDto` are preserved unchanged so
  the prior spine test stays green (zero regression).

## Gates (run from the worktree)
- `pnpm install` — OK
- `pnpm -r build` — OK (all 6 packages)
- `pnpm lint` — OK (no `any`, type-checked, zero warnings)
- `pnpm test:all` — OK: **18 files / 116 tests** (real Postgres on OrbStack via
  Testcontainers), including all prior tests + the new catch-up + API suites.

## Notable
- Fixed a latent NUL-byte separator in the geo-track leg key (the live full-log
  path masked it; the per-tick persisted-route path exposed it). `legKey` is now
  a single exported `->`-separated function reused by the catch-up runner so the
  in-memory and persisted route indexes can never drift.
