<!-- GSD:project-start source:PROJECT.md -->
## Project

**Middle-Mile Trailer Optimization Platform (MVP)**

A logistics optimization MVP for a hub-and-spoke middle-mile truck network. It models
trailers as rear-to-nose ordered sequences of load blocks, treats RFID/barcode reads as
probabilistic sensor evidence, and continuously re-optimizes hub-to-hub freight flow to
reduce package rehandling, blocked freight, missed connections, and SLA failures while
keeping trailers well utilized.

This v1 is a **simulation-driven MVP**: a synthetic event stream feeds an event-sourced
operational twin and a rolling-horizon optimizer, with a **realtime USA-map visualization**
(OpenLayers / OpenStreetMap) of hubs, trailers, routes, and freight flow as the centerpiece.
It is a proof-of-value demo, not a production pilot integrated with real WMS/TMS or RFID hardware.

**Core Value:** Generate **route-aware, LIFO-correct trailer load plans that minimize blocked-freight
rehandle** and continuously repair them as conditions change — demonstrated live, end-to-end,
over a simulated USA hub network. If everything else fails, the load planner + operational
twin producing explainable plans must work.

### Constraints

- **Tech stack**: TypeScript / Node.js backend, PostgreSQL persistence — single-language build for velocity.
- **Frontend**: TypeScript + OpenLayers (OpenStreetMap tiles) — realtime USA-map visualization is the demo centerpiece.
- **Data**: Simulated only — no real RFID hardware, IoT, or WMS/TMS integration in v1.
- **Optimization**: Custom greedy + local search, min-cost flow, VRP heuristics in the JS/TS ecosystem; exact solvers (Gurobi/MILP) out of scope.
- **Architecture**: Event-sourced operational twin + planning twin; in-process/lightweight event bus acceptable (Kafka deferred).
- **Quality**: Tests required (TDD); strong typing (no `any`, strict TS); explainable, auditable decisions.
- **Build model**: Solo agentic development (Claude builds) — favor simple, cohesive, well-established libraries.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## TL;DR Recommendation
- **API:** Fastify 5 (not NestJS) + TypeBox/Zod schemas — thin HTTP shell over an event-sourced core.
- **DB access:** Kysely 0.29 (type-safe SQL builder) over `pg` 8, with raw SQL for the event store and projection upserts. Drizzle 0.45 acceptable as alternative; avoid Prisma for this workload.
- **Event store:** Roll-your-own append-only table on Postgres (a single `events` table + per-stream optimistic concurrency). Use `@event-driven-io/emmett` 0.42 as the pattern/reference and optionally its Postgres store; do NOT introduce EventStoreDB or Kafka in v1.
- **Event bus / workers:** In-process typed event bus (custom, ~100 LOC) for projections + a single rolling-optimizer loop. Defer BullMQ+Redis until you actually need durable retries / parallel workers.
- **Optimization:** Write custom TypeScript — greedy LIFO load planner + local search, and a min-cost-flow / network-simplex implementation. Use `graphology` for graph structure and `ngraph.path` for shortest paths. Keep `glpk.js` (WASM GLPK) in reserve for an LP/MILP cross-check. Do NOT depend on `node_or_tools` or the stale `min-cost-flow` npm package.
- **Realtime:** Native `ws` 8 with a small typed protocol (server→client one-way state diffs). Socket.io 4 only if you need rooms/reconnection/fallback semantics out of the box.
- **Map UI:** OpenLayers (`ol`) 10.9 with React 19 + Vite, animating trailers via `postrender` + vector context along route LineStrings.
- **Simulation:** Custom deterministic tick/event-queue engine in TS (seeded RNG). Do NOT adopt `simscript`/`simjs` (stale, async-coroutine model fights determinism + event sourcing).
- **Tooling:** pnpm workspaces + Turborepo 2, Vitest 4, TypeScript 5.9 strict (`noUncheckedIndexedAccess`).
## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 22 LTS | Runtime | Current LTS; native `node --watch`, stable `fetch`, good WASM perf for glpk.js. |
| TypeScript | 5.9.x | Language | Strict typing mandate. (Registry `latest` may show a 6.x pre-release — pin the stable 5.9 line until 6.0 GA.) |
| Fastify | 5.8.x | HTTP/API layer | ~3× Express throughput, first-class JSON-schema validation (→ types via TypeBox), lifecycle hooks, plugin encapsulation. The system is mostly an internal engine + read API + WS endpoint; a thin fast server beats NestJS's DI/decorator ceremony for a solo agentic build. |
| PostgreSQL | 16/17 | Event store + projections + state | Single durable store for the append-only event log AND projection read models. ACID append with per-stream optimistic concurrency is exactly what event sourcing needs; `LISTEN/NOTIFY` can wake projection/optimizer loops. |
| Kysely | 0.29.x | Type-safe SQL query builder | Event sourcing lives or dies on SQL control: append-with-version-check, batch projection upserts, window functions over the event log, CTEs for "current location of package X". Kysely gives full SQL with end-to-end types and a ~8KB footprint, no ORM abstraction fighting you. |
| `pg` | 8.22.x | Postgres driver | Battle-tested driver under Kysely; supports `LISTEN/NOTIFY`, `COPY`, prepared statements. |
| OpenLayers (`ol`) | 10.9.x | Map rendering | Mandated. Mature vector/animation API; OSM raster + GeoJSON/vector layers; `postrender` + `getVectorContext` animates trailers smoothly along route geometries without per-feature React re-renders. |
| React | 19.x | UI shell around the map | Component model for the operator panels (load-plan view, alerts, KPI, timeline); keep the OL map instance in a ref, drive it imperatively from a WS stream. |
| Vite | 6/7 | Frontend build/dev | Fast HMR, native ESM, trivial OpenLayers + React setup. |
### Optimization Tier (the JVM→TS gap — mostly custom code)
| Library | Version | Purpose | When to Use / Reality |
|---------|---------|---------|------------------------|
| graphology | 0.26.x | In-memory graph model for the time-expanded hub network | Solid, maintained, typed. Provides graph structure + standard algorithms, but **no production min-cost-flow**. Use it as the data structure your custom flow solver runs over. |
| graphology-shortest-path | 2.1.x | Dijkstra/unweighted paths | Building block for successive-shortest-path min-cost flow and for route legs. |
| ngraph.path | 1.6.x | Fast A*/NBA* pathfinding | Maintained (2025); fastest JS pathfinder. Use for shortest-path queries inside the flow solver and for route distance precompute. |
| glpk.js | 5.0.x | WASM GLPK LP/MILP solver (reserve) | Maintained (emsdk 4.0). Use to (a) cross-check the custom min-cost-flow result as an LP, and (b) optionally solve small exact subproblems. NOT the primary path — keeps a verifiable oracle in your back pocket. Single-threaded WASM; fine for scoped rolling-horizon subproblems, not national single-run. |
| **Custom: min-cost flow** | — | Freight→route-leg assignment (spec §11.3) | **No reliable maintained JS min-cost-flow library exists** (`min-cost-flow` npm is 2.1.0 from 2022, unmaintained). Implement Successive Shortest Paths (SSP) with potentials (Johnson) or capacity-scaling SSP over the time-expanded graph. ~200–400 LOC, well-specified, testable against glpk.js. |
| **Custom: LIFO load planner + local search** | — | Trailer rear-to-nose load planning (spec §11.5–11.8) | No off-the-shelf library models single-rear-door LIFO/partial-LIFO blockers. Implement the greedy (sort by unload order, place nose→rear) + local-repair moves (split/reassign/hold/over-carry). This IS the core value of the product — owning it is correct. |
| **Custom: VRPTW heuristic** | — | Trailer/truck routing (spec §11.4) | `node_or_tools` (mapbox OR-Tools VRP binding) is effectively abandoned (last real work ~5y ago, pins ancient Node, prebuilt binaries for Node 4/6). Do NOT depend on it. For an MVP with a fixed hub-and-spoke topology, a construction heuristic (savings/insertion) + 2-opt/Or-opt local search in TS is sufficient and fully controllable. |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@event-driven-io/emmett` | 0.42.x | Event sourcing patterns + (optional) Postgres event store | Use as the canonical pattern reference (command→event→state, projections). Adopt `emmett-postgresql` store if you want a ready append/read API; otherwise lift its table design into your own. Single-language, lightweight, composition-over-magic — fits an MVP. |
| `ws` | 8.21.x | WebSocket server for live map updates | Primary realtime transport. One-directional server→client state diffs at the sim tick rate; tiny, fast, no abstraction overhead. |
| socket.io | 4.8.x | Realtime w/ rooms+reconnect (alternative) | Only if you need auto-reconnect, rooms (per-hub channels), or transport fallback without writing it yourself. Heavier protocol; not needed for a single demo stream. |
| TypeBox or Zod | latest / 4.4.x | Schema + runtime validation of events & API I/O | Validate event payloads on ingest and API boundaries; derive TS types. TypeBox integrates natively with Fastify JSON-schema; Zod if you prefer ergonomic parsing in the engine. Pick one. |
| BullMQ + Redis | 5.79.x | Durable job queue / background workers | DEFER. Only introduce when you need durable ret/at-least-once for the optimizer or parallel hub-scoped workers. In-process loop covers the MVP. |
| seedrandom / custom LCG | latest | Deterministic RNG for the simulator | Reproducible event streams are essential for testing the optimizer and demoing — seed everything. |
| date-fns | 4.x | Time math for time-expanded graph & windows | Time-bucketing (deadline buckets, planning epochs, freeze windows) without Moment bloat. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| pnpm | Package manager + workspaces | Monorepo: `packages/core` (domain+event store), `packages/optimizer`, `packages/sim`, `apps/api`, `apps/web`. Content-addressed store, strict by default. |
| Turborepo | 2.9.x | Monorepo task orchestration/caching | `build`/`test`/`lint` pipelines with caching across packages; fast incremental CI. |
| Vitest | 4.1.x | Test runner (TDD mandate) | Vite-native, fast, ESM-first, great TS DX; same transform as the web app. Use for unit (load planner, flow solver, projections) + integration (event store against a real Postgres via testcontainers). |
| Testcontainers (node) | latest | Ephemeral Postgres for event-store tests | Test append/concurrency/projection logic against real Postgres, not a mock. |
| ESLint 9 (flat config) + typescript-eslint | latest | Lint / `no-explicit-any` enforcement | Enforce the "no `any`, strict TS" constraint mechanically. |
| tsx | latest | Run TS directly in dev | `node --watch` + tsx for the API/sim loops without a build step in dev. |
## Installation
# --- monorepo bootstrap ---
# --- apps/api (Fastify + event store + realtime) ---
# --- packages/optimizer (graph + reserve solver) ---
#   min-cost flow, LIFO load planner, VRPTW heuristic = CUSTOM TS in this package
# --- apps/web (OpenLayers map UI) ---
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Fastify 5 | NestJS 11 (`@nestjs/platform-fastify`) | If the team grows to 3+ devs and you want enforced module/DI structure, built-in microservices, GraphQL. For a solo agentic MVP it's overhead. |
| Kysely | Drizzle 0.45 | Drizzle is a fine pick if you want schema-as-code migrations + relational query helpers; its single-query relational output avoids Prisma's N+1. Choose Drizzle if you value its migration tooling; choose Kysely for maximal raw-SQL transparency around the event log. |
| Roll-your-own Postgres event store (or Emmett's) | EventStoreDB (`@eventstore/db-client`) | Only if you needed a dedicated streaming database with built-in subscriptions/projections at scale. Adds a second datastore + ops burden — violates the single-store, single-language MVP goal. |
| In-process typed event bus | BullMQ + Redis | When you need durable, retryable, parallel background work (e.g., many hub-scoped optimizer workers) or to survive process restarts mid-job. |
| `ws` (raw) | socket.io 4 | When you want rooms (per-hub subscriptions), auto-reconnect, and transport fallback without hand-rolling them. |
| Custom min-cost flow (+ glpk.js oracle) | OR-Tools (Python sidecar) | If TS solver quality proves insufficient, run OR-Tools as an out-of-process Python microservice over JSON — but that breaks the single-language constraint, so treat as a Phase-5 escape hatch only. |
| Custom tick/event-queue simulator | SimScript / SIM.JS | Never for this project — both are stale and their coroutine model undermines deterministic, event-sourced replay. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `node_or_tools` (mapbox OR-Tools binding) | Effectively abandoned; native addon with prebuilt binaries targeting Node 4/6, won't build cleanly on Node 22; no maintenance. | Custom VRPTW construction + local-search heuristic in TS; glpk.js for exact small subproblems. |
| `min-cost-flow` npm (v2.1.0) | Unmaintained since 2022, no types, unverified correctness for capacitated/cost cases at scale. | Implement Successive-Shortest-Paths with potentials over graphology; validate against glpk.js LP. |
| Kafka / Redpanda / Pulsar / NATS (kafkajs etc.) | The spec's streaming backbone is overkill for a single-process simulation MVP; adds infra, ops, and serialization complexity for zero demo value. | Postgres append-only log + `LISTEN/NOTIFY` + in-process typed bus. Revisit only for multi-service production. |
| Prisma | Heavy client (~40MB binary), historically N+1 on nested reads, weakest at the window-function/CTE-heavy queries event-sourced projections need. | Kysely (or Drizzle). |
| EventStoreDB | Second datastore + new ops/runtime; unnecessary when Postgres can be the event store for an MVP. | Postgres event table (own or Emmett's). |
| `simscript` / `simjs` | Stale (2022), async-coroutine simulation model conflicts with deterministic seeded replay and event sourcing. | Custom deterministic event-queue/tick engine emitting domain events. |
| Gurobi / commercial MILP | Out of scope (cost, licensing), and unnecessary at load-block/zone granularity. | Heuristics + glpk.js (open-source) for any exact checks. |
| Redis for "live state" (as in spec §14.1) | The operational twin's live state is just Postgres projections in an MVP; Redis is premature infra. | Postgres projection tables (optionally cached in-memory in the optimizer process). |
## Stack Patterns by Variant
- Use raw `ws` + `@fastify/websocket` with a tiny typed message envelope (`{ t: 'trailerMoved', ... }`).
- Push state diffs at the sim tick (e.g., every 250–1000ms); let OpenLayers interpolate motion between diffs via `postrender`.
- Switch to socket.io 4 for rooms + reconnect, or add a thin pub/sub over `ws`.
- Move the scoped min-cost-flow subproblem to glpk.js as an LP, or stand up an out-of-process OR-Tools (Python) service as a Phase-5 escape hatch (breaks single-language rule — last resort).
- Introduce BullMQ + Redis; run hub-scoped optimizer jobs as workers; keep the event store as source of truth.
## Optimization Realization Gaps (explicit — feeds roadmap risk flags)
| Spec capability | JS/TS reality | Required action | Confidence |
|-----------------|---------------|-----------------|-----------|
| Min-cost flow (§11.3) | No maintained library | **Custom SSP/network-simplex** over graphology; glpk.js as LP oracle | MEDIUM — algorithm is standard, but it's net-new code needing strong tests |
| VRP/VRPTW (§11.4) | No usable maintained binding (`node_or_tools` dead) | **Custom savings/insertion + 2-opt/Or-opt** heuristic | MEDIUM |
| Trailer LIFO load planner (§11.5–11.8) | No library models single-rear-door blockers | **Custom greedy + local repair** (the product's core IP) | HIGH that it must be custom; this is expected/desired |
| Time-expanded graph (§11.2) | graphology covers structure | Build node/edge factory; custom edge types (Trip/Wait/CrossDock/Hold) | HIGH |
| Rolling-horizon loop (§11.9) | Plain TS scheduler | Custom epoch loop reading event log, scoping affected hubs, freeze window | HIGH |
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Fastify 5.8 | Node 20+/22 | Drop Node <20; use `@fastify/websocket` (Fastify 5 line) for WS. |
| Kysely 0.29 | `pg` 8.x | Use `PostgresDialect`; pre-1.0 API but stable and widely used. |
| `@event-driven-io/emmett` 0.42 | Node 20+, Postgres 14+ | Pre-1.0 — pin exact version; streaming code moved into `emmett-postgresql`. |
| OpenLayers 10.9 | React 19, Vite 6/7 | Keep the `ol/Map` in a `useRef`; never let React re-render the map node. |
| glpk.js 5.0 | Node 22 (WASM), modern browsers | Single-threaded; load async (`await GLPK()`); fine for scoped subproblems. |
| Vitest 4 | Vite 6/7, TS 5.9 | Same transform pipeline as the web app; use `@vitest/coverage-v8`. |
| TypeScript 5.9 | All above | Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module: nodenext` (api/sim) / `bundler` (web). Avoid jumping to a 6.x pre-release mid-build. |
## Sources
- npm registry (`npm view <pkg> version time.modified`, 2026-06-18) — verified current versions: fastify 5.8.5, @nestjs/core 11.1.27, drizzle-orm 0.45.2, kysely 0.29.2, pg 8.22.0, @event-driven-io/emmett(-postgresql) 0.42.3, bullmq 5.79.0, socket.io 4.8.3, ws 8.21.0, ol 10.9.0, graphology 0.26.0, ngraph.path 1.6.1 (2025), glpk.js 5.0.0 (2025), node_or_tools 1.3.0 (code stale, prebuilt for Node 4/6), min-cost-flow 2.1.0 (2022), simscript 1.0.37 (2022). HIGH confidence.
- https://github.com/event-driven-io/emmett , https://www.npmjs.com/package/@event-driven-io/emmett-postgresql , https://event-driven.io/en/emmett_postgresql_event_store/ — Emmett Postgres event sourcing. HIGH.
- https://encore.dev/articles/nestjs-vs-fastify , https://www.pkgpulse.com/blog/nestjs-vs-fastify-2026 — Fastify vs NestJS positioning. MEDIUM.
- https://www.pkgpulse.com/blog/prisma-vs-drizzle-vs-kysely-typescript-orm-tier-list , https://levelup.gitconnected.com/the-2025-typescript-orm-battle-prisma-vs-drizzle-vs-kysely-007ffdfded67 — ORM/query-builder comparison incl. raw-SQL/projection fit. MEDIUM.
- https://github.com/jvail/glpk.js , https://www.npmjs.com/package/glpk.js — WASM GLPK LP/MILP. HIGH (capability), MEDIUM (perf at scale, unverified).
- https://github.com/mapbox/node-or-tools , https://www.npmjs.com/package/node_or_tools — OR-Tools VRP binding (assessed stale). MEDIUM-HIGH (abandonment).
- https://www.npmjs.com/package/min-cost-flow — unmaintained flow lib. HIGH (staleness).
- https://openlayers.org/en/latest/examples/feature-move-animation.html , https://mxd.codes/articles/how-to-create-a-web-map-with-open-layers-and-react — OL marker-along-route animation + React integration. HIGH (capability).
- https://www.typescriptlang.org/tsconfig/ , https://devblogs.microsoft.com/typescript/announcing-typescript-5-9/ , https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html — strict tsconfig guidance. HIGH.
- https://github.com/Bernardo-Castilho/SimScript , https://en.wikipedia.org/wiki/SIM.JS — DES libraries (assessed unsuitable/stale). MEDIUM.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
