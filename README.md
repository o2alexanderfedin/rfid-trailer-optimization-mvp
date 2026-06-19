# RFID-Assisted Middle-Mile Trailer Optimization Platform

A logistics optimization MVP for a hub-and-spoke middle-mile truck network. It models
trailers as rear-to-nose ordered load blocks, treats RFID as probabilistic sensor
evidence, and continuously re-optimizes hub-to-hub freight flow to reduce package
rehandling, blocked freight, and missed connections — while keeping trailers well
utilized.

This repository is the **MVP build**: a simulation-driven system with an event-sourced
operational twin, a rolling-horizon optimizer, and a **realtime USA-map visualization**
of trailers, hubs, and freight flow.

## Scope (v1)

Covers the spec's Phases 1–4:

1. **Operational data foundation** — event sourcing + projections (where is package X / what's on trailer T).
2. **Load planning** — load-block aggregation, route-aware LIFO trailer load planner, rehandle & utilization scoring.
3. **RFID-assisted validation** — confidence-scored location, wrong-trailer & missed-unload detection.
4. **Rolling optimizer** — min-cost flow freight assignment, VRP routing, local repair, freeze windows.

Plus a **simulation engine** that generates realistic events and a **minimal web UI**
centered on a live OpenLayers/OpenStreetMap visualization of the USA network.

See [`rfid_middle_mile_trailer_optimization_tech_spec.md`](rfid_middle_mile_trailer_optimization_tech_spec.md)
for the full technical specification.

## Stack

- **Backend:** TypeScript / Node.js
- **Database:** PostgreSQL
- **Frontend:** TypeScript + OpenLayers (OpenStreetMap tiles)
- **Optimization:** custom greedy + local search, min-cost flow, VRP

## Setup

Prerequisites: Node 22+, pnpm 10, and **OrbStack** (the mandated Docker runtime;
`docker context` must point at `orbstack`).

```bash
pnpm install
```

### Monorepo layout (Phase 1 walking skeleton)

`packages/` — downward-only dependencies (`domain` is zero-dep):

- `domain` — entities + zod-validated, versioned domain events (`HubRegistered`).
- `event-store` — append-only `events` table on Postgres, optimistic concurrency, inline projection.
- `projections` — pure projection reducers (no clock/RNG; deterministic).
- `simulation` — USA hub network model (SIM-01).
- `api` — Fastify read API (`GET /hubs`) over the event store.
- `web` — React 19 + Vite + OpenLayers 10 live USA map.

### Gates

```bash
pnpm -r build                  # strict TS, all packages, zero errors
pnpm lint                      # ESLint 9 flat — errors on `any`
pnpm test                      # unit tests (no DB)
pnpm test:all                  # + integration vs a real Postgres (Testcontainers on OrbStack)
pnpm --filter @mm/web build    # production web build
pnpm --filter @mm/web test:e2e # Playwright: OSM + one hub marker + no leak
```

### Run the full stack locally

```bash
docker compose up -d                 # Postgres 17 on OrbStack
export DATABASE_URL=postgres://mm:mm@localhost:5432/mm
pnpm --filter @mm/api dev            # Fastify API on :3001 (migrates + seeds Memphis)
pnpm --filter @mm/web dev            # Vite dev server on :5173 (proxies /api -> :3001)
```

Open http://localhost:5173 — an OSM USA basemap with the Memphis hub marker.

## Development

This project uses **git-flow**. Protected branches (`main`, `develop`) reject direct
commits — work happens on `feature/*`, `release/*`, `hotfix/*`, and `bugfix/*` branches.

```bash
git flow feature start <feature-name>
# ...make changes...
git flow feature finish <feature-name>
```

## Planning

Project planning artifacts (managed by GSD) live in [`.planning/`](.planning/):
`PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, and research notes.

## License

[Add license information]
