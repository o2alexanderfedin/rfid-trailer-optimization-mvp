# Phase 1: Operational Data Foundation + Live Map Spike - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver the auditable, deterministically-replayable event-sourced operational twin for the middle-mile
network, fed by a minimal deterministic simulation, and lit up on an empty-but-live USA map. This phase
establishes the foundation every later phase reads from: the Postgres append-only event store, projections,
state queries, the monorepo scaffold, the simulation engine's network model + event stream, and the
OpenLayers map spike showing hubs/routes/live trailer points.

**In scope (requirements):** FND-01..08 (event store, optimistic concurrency, typed ingestion, deterministic
replay, package/trailer/hub state queries, audit timeline), SIM-01 (USA hub network model), SIM-02
(seeded deterministic event stream), VIZ-01 (empty live OpenLayers USA map with hubs + routes + trailer points).

**Out of scope (later phases):** load-block aggregation & planning (Phase 2), RFID noise/sensor fusion &
detection (Phase 3), optimizer (Phase 4), trailer animation / scenario knobs / dashboards / before-after (Phase 5).
</domain>

<decisions>
## Implementation Decisions

### Event Store & Determinism
- Single append-only `events` table on Postgres: `global_seq BIGSERIAL` (total order), `stream_id`, `version`, `type`, `data JSONB`, `occurred_at`; plus a `streams` table tracking current version.
- Optimistic concurrency enforced via `UNIQUE(stream_id, version)`; ordering/replay by `global_seq` (never by timestamp).
- Projections: inline/synchronous for the decision-critical operational twin (read-your-writes — package location, trailer state, hub inventory); async catch-up projections with a `projection_checkpoints` table for geo/audit/KPI views, with full rebuild via truncate + replay.
- Determinism is a hard requirement: reducers are pure — no `Date.now()`, no `Math.random()`, no unstable sort; all time/randomness comes from event data or injected seeds. An automated CI test asserts live state == state rebuilt from replay (byte-identical).
- Events are TypeScript discriminated-union types, validated with zod at the ingestion boundary, stored as JSONB. Event schema versioning anticipated (version field on event payloads).

### Monorepo & Stack
- pnpm workspaces + Turborepo 2. Packages: `domain` (zero-dep types/events), `event-store`, `projections`, `simulation`, `api`, `web`. Downward-only dependencies.
- Backend API: Fastify 5 (thin shell). DB access: Kysely over `pg` (raw-SQL control for event-log/projection queries; no heavy ORM).
- Frontend: React 19 + Vite + OpenLayers 10 (OpenStreetMap tiles). Realtime: raw `ws` 8 pushing server→client state diffs/snapshots.
- TypeScript 5.x strict, including `noUncheckedIndexedAccess`. Testing: Vitest. Reducers/planner covered by pure unit tests; event-store + projections covered by integration tests against a real Postgres.

### Containerization & Local Infra
- **Containerization via OrbStack** (user directive) — the Docker-compatible runtime on macOS. Local PostgreSQL runs as a container managed by OrbStack.
- Provide a `docker-compose.yml` (Postgres service) that runs on OrbStack's Docker engine; document `orb` usage in README.
- Integration tests use Testcontainers pointed at OrbStack's Docker socket (Docker-API compatible — no special config beyond the standard Docker context). Keep a fallback env var for a manually-run Postgres connection string.

### Phase-1 Map Spike & Sim Scope
- Map spike = static hub markers + route LineStrings + live trailer **points** updated in realtime. NO smooth animation/interpolation (deferred to Phase 5).
- Sim scope for Phase 1 = network model (hubs with lat/long, linehaul routes, trailers, packages) + deterministic, seeded event stream (package scans, trailer trips, arrivals). NO RFID/sensor noise yet (Phase 3 adds SIM-03).
- Network size ≈ 10 real US metro hubs with great-circle linehaul routes between them.
- Realtime transport for the spike: a WebSocket channel pushing trailer-position snapshots (and hub/twin state) on each simulation tick; the client renders current positions as points.

### Claude's Discretion
- Exact table/column naming, migration tooling details, sim tick cadence, seed values, hub selection, and package/trailer volumes are at Claude's discretion within the above constraints — guided by ARCHITECTURE.md, STACK.md, and PITFALLS.md.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Greenfield — no application code yet. Authoritative guidance lives in `.planning/research/` (STACK.md, ARCHITECTURE.md, PITFALLS.md, FEATURES.md, SUMMARY.md) and `rfid_middle_mile_trailer_optimization_tech_spec.md`.

### Established Patterns
- Git-flow enforced: work on `feature/phase-1-*` branch; pre-commit hook blocks direct commits to `main`/`develop` (merges allowed).
- Planning docs in `.planning/`; project guide in `CLAUDE.md`.

### Integration Points
- This phase creates the scaffold; later phases (`aggregation`, `load-planner`, `sensor-fusion`, `optimizer`) plug into the `event-store` + `projections` + `simulation` packages established here.
</code_context>

<specifics>
## Specific Ideas

- Containerization MUST use OrbStack (explicit user directive) — not Docker Desktop.
- Honor the research's anti-"silent lying" guardrails from Phase 1: deterministic replay test, optimistic concurrency, idempotent projections — these are cheapest to bake in now and very costly to retrofit (PITFALLS.md P3/P4/P5a/P11).
</specifics>

<deferred>
## Deferred Ideas

- Trailer animation/interpolation, scenario knobs, KPI dashboard, before/after comparison → Phase 5.
- RFID sensor noise + confidence + detection → Phase 3.
- Load-block aggregation & LIFO planning → Phase 2.
</deferred>
