# Walking Skeleton — Middle-Mile Trailer Optimization Platform (MVP)

**Phase:** 1
**Generated:** 2026-06-19

## Capability Proven End-to-End

A `HubRegistered` domain event is appended to the Postgres append-only event store
(with optimistic concurrency), an **inline projection upserts the `hubs` read model in
the same transaction**, the Fastify `GET /hubs` endpoint reads that projection, and the
React 19 + OpenLayers 10 web app renders an OSM USA basemap with exactly one real hub
marker (Memphis, 35.1495, -90.0490) — all wired together and proven by a real-Postgres
integration test and a Playwright e2e.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo 2.9 | Content-addressed installs, cached `build`/`lint`/`test` pipelines; 6 small packages with downward-only deps. |
| Language/strictness | TypeScript 5.9 (stable, not 6.x pre-release) with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` | Strong typing mandate; catches index/optionality bugs at compile time; no `any` (ESLint 9 flat config errors on the unsafe-`any` family). |
| Event store | Roll-your-own append-only `events` table on Postgres 17 (`global_seq` IDENTITY total order, `UNIQUE(stream_id, version)` OCC) via Kysely 0.29 over `pg` 8.22 | Single durable store for log + read models; raw-SQL control for append-with-version-check; replay always orders by `global_seq`, never timestamp (PITFALLS P4). |
| Projections | Inline/synchronous reducer applied in the SAME transaction as append; idempotent upsert keyed by `hub_id` | Read-your-writes consistency for the operational twin; re-applying an event is a no-op (PITFALLS P5a). Reducer is a **pure function** — no `Date.now()`/`Math.random()` (PITFALLS P3). |
| API | Fastify 5.8, built via a `buildApp(db)` factory | Thin fast HTTP shell; the factory makes the full spine injectable for integration tests (`app.inject`) and reuses the same code path in production. |
| Frontend | React 19 + Vite 7 + OpenLayers 10.9 (OSM tiles) | `ol/Map` created once in a `useRef`, never re-created by React; a SINGLE reused `VectorSource` updated in place; disposed on unmount; feature count surfaced via `data-hub-count` for leak assertions (PITFALLS P10). |
| Local infra | `docker-compose.yml` Postgres 17 on OrbStack; integration tests via Testcontainers (`@testcontainers/postgresql`) against OrbStack's Docker socket, with a `DATABASE_URL` override | OrbStack is the mandated runtime; Testcontainers gives ephemeral real-Postgres tests (no mocks); the override allows a manually-run DB. |
| Test split | Vitest 4 workspace with two projects — `unit` (everything except `*.int.test.ts`) and `integration` (only `*.int.test.ts`, 120s timeout) | `pnpm test` for fast feedback; `pnpm test:all` adds real-Postgres integration. |
| Directory layout | `packages/{domain,event-store,projections,simulation,api,web}` | Downward-only deps: `domain` (zero-dep) ← `projections`/`simulation`/`event-store` ← `api` ← `web` (type-only). |

## Stack Touched in Phase 1

- [x] Project scaffold — pnpm + Turborepo 2.9, TS 5.9 strict, ESLint 9 flat (errors on `any`), Vitest 4 workspace.
- [x] Routing — real Fastify route `GET /hubs` (plus `GET /health`).
- [x] Database — real WRITE (`append` -> `events` + inline `hubs` upsert, one transaction) AND real READ (`getHubs` / `GET /hubs`), proven against a real Postgres 17 container.
- [x] UI — React + OpenLayers `SkeletonMap` fetches `/api/hubs` and renders the Memphis marker on an OSM USA basemap (single reused vector source).
- [x] Deployment — documented local full-stack run: `docker compose up -d` (Postgres on OrbStack), `pnpm --filter @mm/api dev`, `pnpm --filter @mm/web dev`.

### Gate Results (all green)

| Gate | Command | Result |
|---|---|---|
| Install | `pnpm install` | PASS |
| Build (strict TS, 6 pkgs) | `pnpm -r build` | PASS (0 errors) |
| Lint (errors on `any`) | `pnpm lint` | PASS (0 errors) |
| Unit tests | `pnpm test` | PASS (11) |
| Integration (real Postgres / OrbStack) | `pnpm test:all` | PASS (15 total; 4 integration) |
| Web build | `pnpm --filter @mm/web build` | PASS |
| Web e2e (Playwright) | `pnpm --filter @mm/web test:e2e` | PASS (OSM + 1 hub + no leak) |

## Out of Scope (Deferred to Later Slices)

> Explicitly NOT in the skeleton — this list prevents re-litigating Phase 1's minimalism.

- Any domain event beyond `HubRegistered` (PackageCreated/Scanned, Trailer* events) — the store/projection machinery is event-agnostic and ready, but the slice ships only `HubRegistered`.
- The deterministic tick/event-queue simulation engine emitting scans/trips/arrivals (SIM-02 full engine). Phase 1 ships the static USA hub **network model** (SIM-01) and a pure hub→event mapper only.
- WebSocket realtime channel pushing trailer-position/twin snapshots, and live trailer **points** on the map.
- Route LineStrings on the map; trailer animation/interpolation (Phase 5).
- Async catch-up projections + `projection_checkpoints` table; the golden replay CI test (live state == replay-from-`global_seq=0`). The inline projection + purity discipline are in place to make this cheap later.
- Additional read APIs: `GET /packages/:id/location`, `/trailers/:id`, `/hubs/:id/inventory`, `/packages/:id/history`.
- Load-block aggregation & LIFO planning (Phase 2), RFID noise/sensor fusion (Phase 3), optimizer (Phase 4), dashboards/before-after (Phase 5).

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its
architectural decisions (event store, inline+async projections, Fastify factory, OL-in-ref map):

- **Phase 2 — Load Planning:** add Package/LoadBlock/Trailer events + projections; the greedy LIFO load planner + local search; emit plans the API can serve.
- **Phase 3 — RFID-Assisted Validation:** add RFID/scan observation events as probabilistic evidence; sensor-fusion projection with confidence thresholds; "missing read ≠ missing package".
- **Phase 4 — Rolling Optimizer:** rolling-horizon epoch loop reading the event log; custom min-cost-flow (validated against glpk.js) + VRPTW heuristics; freeze window + deterministic tie-break.
- **Phase 5 — Simulation + Visualization Wrapper:** the full deterministic sim engine driving a WS stream; live trailer points/animation, route lines, scenario knobs, KPI dashboard, before/after.
