# Phase 1 Research: Operational Data Foundation + Live Map Spike

**Researched:** 2026-06-18
**Phase:** 1 — Operational Data Foundation + Live Map Spike
**Requirements:** FND-01..08, SIM-01, SIM-02, VIZ-01
**Sources:** Project research (`.planning/research/STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md`), tech spec §6/§9/§13/§18, and a **Google AI Mode browser consult** (mandatory per execution directives) on event sourcing in TypeScript/Node + PostgreSQL.

---

## Google AI Mode Consult (2026-06-18)

Query: *"best practices event sourcing in TypeScript Node.js with PostgreSQL append-only event store optimistic concurrency deterministic replay projections 2026."* The AI-Mode answer **independently converged on our locked architecture** and supplied concrete patterns:

**Event store schema (validated):**
```sql
CREATE TABLE event_store (
  global_position BIGSERIAL PRIMARY KEY,        -- total order for replay (never order by timestamp)
  stream_id       VARCHAR(255) NOT NULL,
  stream_version  INT NOT NULL,
  event_type      VARCHAR(100) NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_stream_id_version UNIQUE (stream_id, stream_version)  -- optimistic concurrency
);
CREATE INDEX idx_stream_id ON event_store (stream_id, stream_version);
```

**Pure reducer (`evolve`) — deterministic, no side effects:**
```typescript
export interface DomainEvent<T = unknown> { type: string; payload: T; }
export function evolve(state: State, event: DomainEvent): State { /* switch on event.type, return new state */ }
```

**Optimistic concurrency on append (single atomic transaction):** `BEGIN` → read current `MAX(stream_version)` → compare to `expectedVersion` (throw `ConcurrencyError` on mismatch) → `INSERT` each event with incremented version → `COMMIT`. The `UNIQUE(stream_id, stream_version)` constraint catches concurrent races as Postgres error `23505`.

**Takeaway:** our CONTEXT.md / ARCHITECTURE.md decisions are sound. We adopt the exact schema (renamed to our column conventions), the pure-`evolve` reducer pattern, and the transactional append with expected-version check + `23505` handling.

> Further Google AI Mode consults will be run during implementation/debug for OpenLayers realtime rendering, Fastify+ws wiring, and Testcontainers-on-OrbStack, per the mandatory-consult directive.

---

## Implementation Guidance

### Event store (`packages/event-store`)
- Table `events`: `global_seq BIGSERIAL PK`, `stream_id text`, `version int`, `type text`, `data jsonb`, `metadata jsonb`, `occurred_at timestamptz`; `UNIQUE(stream_id, version)`; index `(stream_id, version)`.
- `append(streamId, expectedVersion, events[])`: one transaction, expected-version check, incrementing version, catch `23505` → `ConcurrencyError`.
- `readStream(streamId)` ordered by `version`; `readAll(fromGlobalSeq)` ordered by `global_seq` for projections.
- Events are a TS discriminated union in `packages/domain`; zod schema per event validated at the ingestion boundary (FND-03).

### Projections (`packages/projections`)
- **Inline/synchronous** for the operational twin (FND-05/06/07 — package location, trailer state, hub inventory): updated in the same flow as append so reads are read-your-writes consistent.
- **Async catch-up** for geo/audit/KPI (FND-08 audit timeline, VIZ-01 geo): a poller advances from `global_seq` using a `projection_checkpoints(name, last_global_seq)` table; idempotent upserts keyed by event identity; full rebuild = truncate projection + replay from `global_seq=0`.
- Reducers are pure: no `Date.now()`, `Math.random()`, or unstable sort — all time/randomness comes from event `data`/`occurred_at` (PITFALLS P3).

### Domain model (`packages/domain`)
- Entities: Package, LoadBlock (stub for P2), Trailer, TrailerSlice (stub), Hub, DockDoor, Route, Trip (per tech spec §6).
- Phase-1 events: `PackageCreated`, `PackageScanned`, `PackageArrivedAtHub`, `TrailerArrived`, `TrailerDocked`, `TrailerDeparted`, `TrailerArrivedAtHub` (subset of spec §9.2 sufficient for FND queries + SIM).

### Simulation (`packages/simulation`)
- SIM-01: model ~10 US metro hubs (lat/long), linehaul routes (great-circle), trailers, packages.
- SIM-02: deterministic seeded engine — tick/event-queue driven by an injected seed + virtual clock; emits scans/trips/arrivals as domain events into the store. No `Math.random` without seed; no RFID noise yet (Phase 3).

### API + realtime (`packages/api`)
- Fastify 5; Kysely over `pg`. REST: `GET /packages/:id/location`, `GET /trailers/:id`, `GET /hubs/:id/inventory`, `GET /packages/:id/history` (audit timeline).
- `ws` channel pushing trailer-position + hub/twin snapshots each sim tick.

### Web map spike (`packages/web`)
- React 19 + Vite + OpenLayers 10 (OSM tiles). VIZ-01: hub markers + route LineStrings + live trailer **points** from ws snapshots. No animation/interpolation (Phase 5). Guard against OpenLayers source/layer churn leaks (PITFALLS P10) — reuse a single vector source, update features in place.

### Local infra (OrbStack)
- `docker-compose.yml` Postgres service running on OrbStack's Docker engine. Integration tests use Testcontainers against OrbStack's Docker socket (standard Docker context — no special config). Fallback env `DATABASE_URL` for a manually-run Postgres.

---

## Validation Architecture

Validation strategy for Nyquist coverage of Phase 1 requirements.

### Determinism / Replay (FND-04) — the keystone test
- **Golden replay test:** build operational-twin state live from a seeded sim run; independently rebuild the same projections by replaying `events` from `global_seq=0`; assert the two are deep-equal (byte-identical serialization). Runs in CI.
- **Purity guard:** unit tests assert reducers produce identical output for identical input across repeated calls; lint/grep guard forbids `Date.now(`/`Math.random(` in `packages/domain` + `projections` reducers.

### Optimistic Concurrency (FND-02)
- Integration test: two concurrent `append` calls with the same `expectedVersion` → exactly one succeeds, the other throws `ConcurrencyError` (Postgres `23505`); stream has no version gaps/dupes.

### State Queries (FND-05/06/07/08)
- Integration tests over a seeded event stream assert: package last-seen location+confidence+timestamp; trailer current assignment/observation; hub inventory counts; package audit timeline is the correct ordered event history.

### Ingestion typing (FND-01/03)
- Unit tests: invalid event payloads rejected by zod at the boundary; valid events persisted as JSONB and round-trip through `readStream`.

### Simulation (SIM-01/02)
- Tests: same seed ⇒ identical event stream (determinism); network has ~10 hubs with valid coordinates and connected routes; emitted events drive projections without error.

### Map spike (VIZ-01)
- Component/e2e (Playwright): map renders OSM tiles, all hub markers + route lines present; trailer points update on ws snapshot; no layer/source leak across N updates (feature count stable on the single vector source).

---

## Key Pitfalls Carried Into Plans (from PITFALLS.md)
- **P3 Non-deterministic replay** → purity guard + golden replay test (above).
- **P4 Missing optimistic concurrency** → unique `(stream_id, version)` + expected-version check; replay by `global_seq`, never timestamp.
- **P5a Non-idempotent projections** → checkpointed, idempotent upserts; rebuild via truncate+replay.
- **P10 OpenLayers leaks/re-render storms** → single reused vector source, in-place feature updates, bounded feature count.
- **P11 Event schema versioning** → version field on event payloads; reducers tolerate older shapes.

---
*Phase 1 research — incorporates mandatory Google AI Mode consult on event sourcing in TS/Node + Postgres.*
