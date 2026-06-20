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

## Integration into feature/phase-1-operational-data-foundation-live-map-spike

Selected as the winning implementation of Plan 06 (judge confidence ~0.62, a
close call vs R1). Merged with `git merge --no-ff` of
`40b80bfe7717d5f87f2fd8448b19dbf9d439f96e` into
`feature/phase-1-operational-data-foundation-live-map-spike`.
- Merge: clean (merge base == branch HEAD, recursive strategy, **zero conflicts**).
- Merge commit: `2a7de68557786f6deef4748d6d5bb90d94c302c7`.

### Re-verified gates in the MAIN repo after merge (not from the worktree)
- `pnpm install` — OK (pre-existing `@mm/api`↔`@mm/event-store` cyclic workspace
  dependency warning only; not introduced by this plan).
- `pnpm -r build` — OK (all 6 packages: domain, event-store, api, projections,
  web, simulation).
- `pnpm lint` — OK (eslint exit 0, no errors/warnings).
- `pnpm test:all` — OK: **18 files / 116 tests passed** against **real Postgres on
  OrbStack via Testcontainers**. The 3 new integration suites
  (`api/test/queries.int.test.ts`, `api/test/ws.int.test.ts`,
  `projections/test/audit-geo.int.test.ts`) were confirmed to spin up real
  `PostgreSqlContainer` instances (15 tests, including a truncate+replay rebuild).
- No merge-only breakage; no code changes were required to land the merge.

### Requirements delivered
- **FND-05** — `GET /packages/:id/location` (hub + confidence + timestamp; 404 on
  unknown id).
- **FND-06** — `GET /trailers/:id` (current assignment / contents; 404 on unknown).
- **FND-07** — `GET /hubs/:id/inventory` (inbound / outbound / staged).
- **FND-08** — `GET /packages/:id/history` ordered audit timeline + catch-up
  `audit_timeline` projection.

### Carried risks (from the judge's review of R2 — accepted, not gate failures)
- (a) **Geo arrival resolution heuristic.** Arrival keyframes are anchored via the
  lexicographically-smallest leg whose key ends in `->hubId`. Correct only while
  every route's last vertex equals the hub coordinate; if future routes have
  distinct approach geometries into the same hub, R2 may anchor the arrival
  keyframe to the wrong leg. R1's per-trip leg tracking was immune. Revisit when
  multiple distinct approaches per hub are introduced.
- (b) **FND-08 audit timeline scope.** R2's timeline omits `TrailerDeparted` and
  exposes only `hubId`/`scanType`, so a package's history does not record that it
  departed on a trailer — a narrower reading of "full ordered audit timeline" than
  R1's payload-carrying, departure-inclusive timeline. Expand if FND-08 must be
  exhaustive.
- (c) **Unvalidated JSONB reads.** R2 uses raw `as Hub` / `as {...}` casts on JSONB
  at the read boundary (no schema validation), so malformed event data would leak
  untyped. R1 used Zod-validated reads. Consider adding read-boundary validation.
- (d) **Two `GET /hubs` implementations.** Skeleton `buildApp` (via `getHubs`) and
  full `buildServer` (via `HubRegistered` log) — a mild DRY tension, though in
  separate composition roots.
- (e) **Pre-existing `@mm/api`↔`@mm/event-store` test-only dependency cycle.**
  Present in BOTH worktrees (skeleton spine test); not introduced by this plan.

None of (a)–(e) fail a gate today; all 116 tests pass against real Postgres.
