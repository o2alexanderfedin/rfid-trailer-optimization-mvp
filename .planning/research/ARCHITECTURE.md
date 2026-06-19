# Architecture Research

**Domain:** Event-sourced, simulation-driven middle-mile trailer optimization (TS/Node + PostgreSQL + OpenLayers)
**Researched:** 2026-06-18
**Confidence:** HIGH (event-store + projection patterns verified against multiple PostgreSQL event-sourcing references and the Emmett/Node ecosystem; optimizer composition derived directly from spec §10–11; MEDIUM on specific npm optimization libs)

## Standard Architecture

The spec (§9, §13, §18) describes a Kafka/JVM event-sourced system with an operational twin, a planning twin, and a decomposed rolling-horizon optimizer. For a **single-developer TS/Node MVP** this collapses to a **single Node process (modular monolith)** with an **in-process event bus**, a **PostgreSQL event store**, **projection read models in the same DB**, and the optimizer running against an in-memory **planning twin** snapshot. Kafka, Redis, and microservice boundaries are deferred — but module boundaries are drawn so they *could* later become services without rewrites.

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         SIMULATION ENGINE                              │
│   synthetic packages / trailer moves / RFID reads on a USA hub graph   │
│   emits domain commands/events on a virtual clock (speed-controllable) │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │ events
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    IN-PROCESS EVENT BUS (typed)                        │
│        publish → persist → fan-out to subscribers (projections)        │
├──────────────────────────────────────────────────────────────────────┤
│                  EVENT STORE  (PostgreSQL, append-only)                │
│   events(stream_id, version, type, data, global_seq) + streams table  │
│   optimistic concurrency via UNIQUE(stream_id, version)               │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │ global_seq ordered read
                ┌────────────────┼─────────────────────────────┐
                ▼                ▼                             ▼
        ┌──────────────┐ ┌──────────────┐            ┌──────────────────┐
        │ OPERATIONAL  │ │  AUDIT /     │            │  GEO / TELEMETRY │
        │  PROJECTIONS │ │  EXCEPTION   │            │  PROJECTION      │
        │ pkg location │ │  timeline    │            │ trailer pos over │
        │ trailer state│ │              │            │ time, route geom │
        │ hub inventory│ └──────────────┘            └────────┬─────────┘
        │ load plan    │                                      │
        └──────┬───────┘                                      │
               │ read (snapshot)                              │
               ▼                                              │
   ┌──────────────────────────────────────────────┐          │
   │        PLANNING TWIN  (sandbox copy)          │          │
   │  in-memory clone of operational state scoped  │          │
   │  to affected hubs/trailers — optimizer mutates│          │
   │  it freely, NO event-store writes             │          │
   ├──────────────────────────────────────────────┤          │
   │  OPTIMIZER PIPELINE (spec §10 layers)         │          │
   │  aggregate→netflow→route→load→crossdock→repair│          │
   └──────────────────┬───────────────────────────┘          │
                      │ accepted plan → PlanGenerated event   │
                      ▼ (back to event store)                 │
   ┌──────────────────────────────────────────────┐          │
   │   API LAYER (Fastify/Express + WebSocket/SSE) │◄─────────┘
   └──────────────────┬───────────────────────────┘
                      │ realtime push (positions, plans, exceptions, KPIs)
                      ▼
   ┌──────────────────────────────────────────────┐
   │   WEB  (OpenLayers USA map + read-only UI)    │
   └──────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| `domain/events` | Entity types (Package, LoadBlock, Trailer, TrailerSlice, Hub, DockDoor, Route, Trip) + the closed set of typed event definitions (§9.2) + command types. No I/O. | Pure TS types + zod schemas; discriminated union `DomainEvent` |
| `event-store` | Append-only persistence, optimistic concurrency, stream loading, global-ordered read for subscribers, snapshotting | PostgreSQL + `pg`; one `events` table + `streams` table |
| `event-bus` | Publish events, persist via store inside a tx, fan-out to in-process subscribers; provides catch-up subscription with checkpoint | Typed `EventEmitter` / async dispatcher over store |
| `projections` | Build/maintain read models (pkg location, trailer state, hub inventory, load plan, dock schedule, exceptions, SLA risk, audit, geo) | Subscriber handlers writing projection tables; per-projection checkpoint |
| `aggregation` | Group packages → load blocks by (hub, dest, SLA, deadline bucket, handling, size) (§11.1) | Pure function over operational projection |
| `load-planner` | Rear-to-nose LIFO / partial-LIFO slice assignment, rehandle + utilization scoring, loading-instruction output, LIFO validation (§7, §11.5–11.6) | Greedy + local-repair heuristics, pure |
| `sensor-fusion` | RFID/barcode observations → confidence-scored zone estimates; wrong-trailer & missed-unload detection (rule-based Bayesian, §8) | Pure scoring functions over evidence |
| `optimizer` | Layered pipeline: time-expanded graph, min-cost flow freight assignment, VRP/VRPTW routing, rolling-horizon loop, local repair (split/reassign/hold/over-carry), weighted objective (§10–12) | Custom graph + heuristics over the planning twin |
| `simulation` | Synthetic event generation on a virtual clock; trailer kinematics along route geometry; configurable scenarios | Standalone generator driving the event bus |
| `api` | HTTP query endpoints + WebSocket/SSE realtime channel + plan/override commands | Fastify + `ws`/SSE |
| `web` | OpenLayers USA map, load-plan view, exception alerts, audit timeline, KPI dashboard | Vite + TS + OpenLayers |

## Recommended Project Structure

Monorepo (pnpm workspaces). Dependency arrows point **downward only** — lower packages never import upper ones.

```
packages/
├── domain/              # entities, event/command types, value objects — ZERO deps
│   ├── entities/        # Package, LoadBlock, Trailer, TrailerSlice, Hub, DockDoor, Route, Trip
│   ├── events/          # DomainEvent union + per-event zod schemas
│   └── commands/        # command types
├── event-store/         # Postgres append-only store + optimistic concurrency + snapshots
│   ├── schema.sql       # events, streams, projection_checkpoints, snapshots
│   ├── store.ts         # appendToStream / readStream / readAll(fromGlobalSeq)
│   └── snapshot.ts
├── event-bus/           # publish + persist + catch-up subscriptions w/ checkpoints
├── projections/         # read-model builders (one file per projection)
│   ├── package-location.ts
│   ├── trailer-state.ts
│   ├── hub-inventory.ts
│   ├── load-plan.ts
│   ├── exceptions.ts
│   ├── geo-track.ts     # trailer position-over-time + route geometry for the map
│   └── audit-timeline.ts
├── aggregation/         # packages → load blocks  (pure)
├── load-planner/        # LIFO slice planner + scoring + validation (pure)
├── sensor-fusion/       # RFID/barcode evidence → zone confidence + detections (pure)
├── optimizer/           # planning twin + layered pipeline + rolling-horizon loop
│   ├── planning-twin.ts # sandbox snapshot construction + scoping
│   ├── layers/          # aggregate, netflow, route, load, crossdock, repair
│   ├── objective.ts
│   └── horizon-loop.ts  # trigger model, freeze windows, idempotency
├── simulation/          # synthetic event generator on a virtual clock
├── api/                 # Fastify HTTP + WS/SSE; wires store→bus→projections→optimizer
└── web/                 # OpenLayers map + read-only operator UI
```

### Structure Rationale

- **`domain/` has zero dependencies** so every other package can depend on the same types without cycles. The closed `DomainEvent` union is the single contract crossing all boundaries.
- **`aggregation`, `load-planner`, `sensor-fusion` are pure** (no DB/clock/IO). They take plain data, return plain data — trivially unit-testable (TDD constraint) and reusable by both the optimizer and the API.
- **`optimizer` owns the planning twin** because the twin only exists to serve optimization; nothing else should hold sandbox state.
- **`projections/geo-track` is separated** from operational projections because the map's needs (interpolated positions over a time window, route LineStrings) differ from "current state" queries and have a different write cadence.
- **`api` is the only package that wires concrete infrastructure together** — it is the composition root. This keeps lower packages free of process/HTTP concerns and lets the whole thing later split into services along existing package seams.

## Architectural Patterns

### Pattern 1: PostgreSQL Append-Only Event Store with Optimistic Concurrency

**What:** Two tables. `events` is strictly append-only (no UPDATE/DELETE). A `UNIQUE(stream_id, version)` constraint enforces optimistic concurrency: a writer passes the version it expects the stream to be at; a concurrent writer at the same version is rejected by the DB, not by app logic. A `global_seq BIGINT GENERATED ALWAYS AS IDENTITY` gives a total order for subscribers/projections.

**When to use:** Always here — this is the operational twin's backbone and the source of all auditability (§9.1).

**Trade-offs:** Append-only + per-stream version is simple and bulletproof for a single-writer-per-stream MVP; global ordering via identity column is gap-tolerant (use it only for "read events after checkpoint X", never assume contiguity). For multi-writer-per-stream you'd need advisory locks — not needed at MVP.

**Example (schema sketch):**
```sql
CREATE TABLE streams (
  stream_id   TEXT PRIMARY KEY,           -- e.g. 'trailer-T42', 'package-P123'
  stream_type TEXT NOT NULL,
  version     INT  NOT NULL DEFAULT 0     -- current version (count of events)
);

CREATE TABLE events (
  global_seq  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_id   TEXT  NOT NULL REFERENCES streams(stream_id),
  version     INT   NOT NULL,             -- per-stream, 1..N
  event_type  TEXT  NOT NULL,
  data        JSONB NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL,       -- domain time (virtual clock in sim)
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stream_id, version)             -- optimistic concurrency guard
);
CREATE INDEX ON events (stream_id, version);
CREATE INDEX ON events (event_type, global_seq);

-- append (single tx):
--   UPDATE streams SET version = version + 1
--     WHERE stream_id = $1 AND version = $expectedVersion;   -- 0 rows => conflict
--   INSERT INTO events (stream_id, version, ...) VALUES (...);
```

### Pattern 2: Inline (Synchronous) vs Catch-Up (Async) Projections

**What:** Two projection update modes. **Inline** projections run in the same transaction as the append (strong read-your-writes; the operational twin should be inline so the optimizer never reads stale state). **Catch-up** projections run a background loop reading `events WHERE global_seq > checkpoint`, applying handlers, advancing a checkpoint row — used for heavier/derived read models (geo-track interpolation, KPIs, analytics) where slight lag is fine.

**When to use:** Inline for `package-location`, `trailer-state`, `hub-inventory`, `load-plan`, `exceptions` (decision-critical). Async for `geo-track`, `audit-timeline`, `sla-risk`, KPI rollups.

**Trade-offs:** Inline costs write latency and couples projection failures to writes; keep inline handlers trivial. Async decouples and enables full **rebuild** (truncate read model, reset checkpoint to 0, replay) — the core operational benefit of event sourcing.

**Example:**
```sql
CREATE TABLE projection_checkpoints (
  projection  TEXT PRIMARY KEY,
  last_seq    BIGINT NOT NULL DEFAULT 0
);
-- rebuild: TRUNCATE trailer_geo_track; UPDATE projection_checkpoints
--   SET last_seq = 0 WHERE projection = 'geo-track';  -- loop replays from 0
```

### Pattern 3: Planning Twin as a Scoped In-Memory Snapshot

**What:** The operational twin is the live projection set (authoritative, event-driven). The **planning twin** is a throwaway in-memory deep copy of *only the affected hubs/trailers/load-blocks* (the rolling-horizon scope), handed to the optimizer. The optimizer mutates it freely while exploring candidate plans. It produces **no event-store writes** until a plan is accepted; acceptance emits a single `PlanGenerated` (then `PlanAccepted`) event back through the normal append path (§18.1–18.2).

**When to use:** Every optimization epoch. This is the spec's required twin separation realized without a second database — a structural-clone of the relevant projection slice is sufficient and cheap at MVP scale.

**Trade-offs:** In-memory clone is simple and side-effect-free but means the optimizer must work on a bounded scope (which the rolling-horizon design already requires). If candidate evaluation needed durability/concurrency you'd promote the twin to a separate schema; not needed for a solo MVP.

**Example:**
```typescript
// optimizer reads operational projections, clones the affected slice, never writes through it
const scope = detectAffectedScope(newEvents);                 // hubs, trailers, blocks
const twin  = PlanningTwin.fromProjections(operational, scope); // structuredClone of slice
const plan  = runPipeline(twin);                              // mutates twin only
const valid = validateAndRepair(plan, twin);
if (accept(valid)) eventBus.publish(planGenerated(valid));    // ONLY side effect
```

### Pattern 4: Layered Optimizer Pipeline (spec §10) as Composed Pure Stages

**What:** Each planning layer is a function `(input, twin) → output` chained into a pipeline, all operating on the scoped planning twin:
```
aggregate → networkFlow → trailerRoute → loadPlan → crossDock → rollingRepair
```
Layer 1 (`aggregation`) groups packages into load blocks. Layer 2 builds a **time-expanded hub graph** and runs **min-cost flow** to assign freight to lanes/time windows. Layer 3 runs **VRP/VRPTW** to sequence trailer routes. Layer 4 calls `load-planner` for rear-to-nose LIFO slice assignment + scoring. Layer 5 schedules cross-dock transfers. Layer 6 applies **local repair** (split/reassign/hold/over-carry) against the weighted objective (§12).

**When to use:** Decomposition is mandatory (§10 — "avoids one massive, unsolvable model"). Each layer is independently testable and can degrade gracefully (the spec's "if all else fails, load-planner + operational twin must work" → layers 1+4 alone are a shippable slice).

**Trade-offs:** Pipeline decoupling can produce locally-optimal-but-globally-suboptimal plans; rolling repair (layer 6) is the cross-layer correction. Keep layer interfaces as plain data structs so layers can be reordered/skipped per scope.

### Pattern 5: Rolling-Horizon Loop — Hybrid Trigger + Freeze Window + Idempotency

**What:** A loop that fires on **both** a periodic timer (every 5–15 min of domain time, §11.9) **and** event triggers (new exception, large inventory delta). Each epoch: read new events → update operational twin → compute affected scope → build planning input → optimize → validate/repair → publish plan. A **freeze window** excludes trailers departing within 10–15 min from replanning (unless critical), so plans don't churn under execution. **Idempotency**: each epoch is keyed by `(epoch_id, scope_hash)`; re-running the same epoch over the same events yields the same plan and republishing is a no-op (compare against last `PlanGenerated` for that trailer).

**When to use:** The core control loop driving the demo. In simulation it ticks on the virtual clock so the demo can be sped up.

**Trade-offs:** Hybrid triggers risk thrash; debounce event triggers and cap optimization frequency per trailer. Freeze windows trade optimality for execution stability — correct for logistics.

## Data Flow

### End-to-End Flow (simulator → map)

```
[Simulation tick on virtual clock]
   ↓ emits command/event (PackageScanned, TrailerDeparted, RfidObserved, ...)
[Event Bus.publish]
   ↓ append to Postgres (streams version check + events insert, single tx)
[Event Store]  ──global_seq──► [Inline projections]  → operational twin (pkg loc, trailer, hub, plan, exceptions)
                              └► [Async projections]  → geo-track, audit, SLA-risk, KPIs
   ↓ (periodic OR event trigger)
[Rolling-horizon epoch] → detect scope → clone Planning Twin → optimizer pipeline → validate/repair
   ↓ accepted plan
[PlanGenerated event] → event store → load-plan projection updated
   ↓
[API] WebSocket/SSE channel pushes deltas: trailer positions, plan changes, exceptions, KPI snapshot
   ↓
[Web / OpenLayers] renders hubs (Points), routes (LineStrings), trailers (interpolated Points moving over time)
```

### Realtime Map Geo Data Flow

```
Hub coords:    static seed table  hubs(id, name, lat, lon)  → GeoJSON Points (load once)
Route geometry: routes(id, from_hub, to_hub, geometry LINESTRING)  → drawn as LineStrings
                (MVP: straight-line/great-circle between hubs; optional OSRM/road geometry later)
Trailer motion: geo-track projection stores (trailer_id, trip_id, t, lat, lon) keyframes from
                Trailer{Departed,ArrivedAtHub} events + route geometry; the CLIENT interpolates
                position along the LineString by fraction = elapsed/ETA for smooth animation.
                Server pushes keyframes/ETAs; client tweens between them (no per-second server push).
```
PostGIS is **optional** at MVP — straight-line interpolation and stored LineStrings cover the demo; add PostGIS only if road-network geometry or spatial queries (hubs-in-bbox) become needed.

### State Management (web)

```
[WebSocket/SSE deltas] → [client store (trailers, plans, hubs, exceptions, kpis)]
        ↓ subscribe
[OpenLayers vector sources] ← requestAnimationFrame tween loop interpolates trailer Points
[UI panels: load-plan view | exception alerts | audit timeline | KPI dashboard]
```

## Scaling Considerations

This is a single-developer simulation MVP; "scale" = simulated entity count and event rate, not real users.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Demo (≤30 hubs, ≤500 trailers, ~10s events/sec sim) | Modular monolith, in-process bus, inline projections, in-memory planning twin. No Kafka/Redis. |
| Larger sim (100+ hubs, 10k+ packages, faster-than-realtime) | Move heavy projections fully async; batch event appends; add partial indexes; cache operational twin slices; cap optimizer scope per epoch. |
| "Production-shaped" (out of scope) | Split packages into services along existing seams; replace in-process bus with NATS/Kafka; Redis for live operational state; TimescaleDB for telemetry; PostGIS for routing. The package boundaries above are drawn so this is mechanical, not a rewrite. |

### Scaling Priorities

1. **First bottleneck:** inline projection latency under high sim event rate → move non-decision projections to async catch-up; batch appends.
2. **Second bottleneck:** optimizer epoch duration as scope grows → enforce strict affected-scope bounding and freeze windows; debounce event triggers; cap per-trailer reopt frequency.

## Anti-Patterns

### Anti-Pattern 1: Mutating or deleting events / storing current state in the events table

**What people do:** UPDATE an event to "fix" it, or treat `events` as a mutable current-state table.
**Why it's wrong:** Destroys auditability — the entire reason for event sourcing (§9.1) — and breaks projection rebuild.
**Do this instead:** Append a corrective event (e.g. `PlanOverridden`). Current state lives only in projections, which are disposable and rebuildable from the log.

### Anti-Pattern 2: Optimizer writing directly to operational projections / event store mid-search

**What people do:** Let the optimizer mutate live trailer/hub state while evaluating candidate plans.
**Why it's wrong:** Produces operational side effects from speculative plans, races with the event stream, and is unauditable.
**Do this instead:** Operate on the cloned **planning twin**; emit exactly one `PlanGenerated`/`PlanAccepted` event when a plan is accepted (Pattern 3, §18.2).

### Anti-Pattern 3: One monolithic optimization model

**What people do:** Try to solve aggregation + routing + loading + cross-dock as a single MILP.
**Why it's wrong:** Intractable and unscoped; spec §10 explicitly warns against it; impossible in the JS/TS heuristic toolchain.
**Do this instead:** The layered pipeline (Pattern 4) over a bounded rolling-horizon scope.

### Anti-Pattern 4: Pushing per-trailer positions from the server every second

**What people do:** Server emits each trailer's lat/lon on a high-frequency timer.
**Why it's wrong:** Floods the WS channel and couples render smoothness to network cadence.
**Do this instead:** Server pushes keyframes + ETAs on state change; client interpolates along the route LineString in a `requestAnimationFrame` loop.

### Anti-Pattern 5: Coupling domain time to wall-clock time

**What people do:** Use `now()` everywhere, so the simulation can't be sped up or replayed deterministically.
**Why it's wrong:** Breaks fast-forward demos, deterministic tests, and the rolling-horizon epoch logic.
**Do this instead:** A `Clock` abstraction; the simulator drives a virtual clock; events carry `occurred_at` (domain time) distinct from `recorded_at` (wall time).

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| OpenStreetMap tiles | OpenLayers `OSM` tile source over HTTPS | No API key; respect tile usage policy; consider a tile cache for demos |
| OSRM / routing (optional, later) | HTTP for road-network route geometry | MVP uses great-circle LineStrings; defer |
| PostGIS (optional) | Postgres extension | Only if spatial queries / road geometry needed; not MVP |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| simulation → event-bus | typed event publish | Same contract a real ingestion adapter would use later |
| event-bus → event-store | function call inside tx | Append + optimistic concurrency check |
| event-store → projections | catch-up read by `global_seq` + inline hooks | Checkpoint per projection |
| projections → optimizer | read snapshot (clone scoped slice) | One-way; optimizer never writes back through projections |
| optimizer → event-store | `PlanGenerated`/`PlanAccepted` events | Only side effect of optimization |
| projections/optimizer → api → web | WS/SSE deltas + REST queries | api is the composition root |

## Suggested Build Order (Dependency Graph)

Build bottom-up so each layer is testable before the next depends on it. Maps cleanly onto spec Phases 1–4.

```
1. domain (types/events)                              ─┐ no deps; pure
2. event-store (schema + append/read + concurrency)   ─┤ → unit + concurrency tests
3. event-bus (publish/persist/subscribe + checkpoint) ─┤
4. projections (operational twin: pkg/trailer/hub +   ─┘ ← answers spec Phase 1 success criteria
   audit)                                                  ("where was pkg X", "what's on trailer T")
        │
        ├─5. simulation (event generator + virtual clock)  ← lets all above run with real data early
        │
6. aggregation (packages→load blocks)        ─┐ pure
7. load-planner (LIFO slices + scoring)      ─┘ ← spec Phase 2 (core value: explainable load plans)
        │
8. sensor-fusion (RFID evidence + detections) ← spec Phase 3 (depends on events + trailer-state proj)
        │
9. optimizer (planning twin → layered pipeline → rolling-horizon loop) ← spec Phase 4
   depends on: projections (read), aggregation, load-planner; emits events back to event-store
        │
10. api (HTTP queries + WS/SSE + override commands)  ← wires everything; composition root
        │
11. web (OpenLayers map + read-only UI)              ← consumes api + geo-track projection
```

**Critical path / rationale:**
- **2→3→4 first** because nothing has data without the store+bus+operational projections; this is also the spec's "first business value" gate (answerable history).
- **simulation (5) early, right after projections** — it is the data source for *every* later component, so build it as soon as there's something to feed.
- **load-planner (7) before optimizer (9)** — the optimizer's layer 4 *calls* the load-planner, and the planner alone (with the twin) is the explicit "if all else fails" deliverable.
- **geo-track projection** is built alongside projections (4) but only consumed by web (11); the map can render hubs/routes/trailer motion as soon as simulation + geo-track exist, so a compelling visual demo is possible after step 5 even before the optimizer lands.
- **api/web last** because they compose lower packages; but a thin geo-only slice of api+web can be stood up after step 5 to de-risk the visualization centerpiece early.

## Sources

- PostgreSQL event store schema, `UNIQUE(aggregate_id, version)` optimistic concurrency, projections & replay — [eugene-khyst/postgresql-event-sourcing](https://github.com/eugene-khyst/postgresql-event-sourcing), [Building a Production-Ready Event Store in PostgreSQL (DEV)](https://dev.to/tim_derzhavets/building-a-production-ready-event-store-in-postgresql-schema-design-projections-and-replay-25o8), [Event Storage in Postgres (DEV)](https://dev.to/kspeakman/event-storage-in-postgres-4dk2) — HIGH
- Node/TS event sourcing on Postgres, inline vs async projections, checkpointed subscriptions — [Emmett](https://github.com/event-driven-io/emmett), [Emmett on PostgreSQL (event-driven.io)](https://event-driven.io/en/emmett_postgresql_event_store/) — MEDIUM (validates feasibility; recommend a hand-rolled store for full control over the twin separation, with Emmett as a reference/fallback)
- JS/TS optimization building blocks — [graphology](https://github.com/graphology/graphology) (time-expanded graph), [min-cost-flow npm](https://www.npmjs.com/package/min-cost-flow), [javascript-lp-solver](https://www.npmjs.com/package/javascript-lp-solver), [mapbox/node-or-tools](https://github.com/mapbox/node-or-tools) (VRP, native binding — evaluate build friction) — MEDIUM
- Domain/architecture/twin/planning-layer/rolling-horizon requirements — `rfid_middle_mile_trailer_optimization_tech_spec.md` §9, §10, §11.9, §13, §18 — HIGH

---
*Architecture research for: event-sourced middle-mile trailer optimization (TS/Node + Postgres + OpenLayers)*
*Researched: 2026-06-18*
</content>
</invoke>
