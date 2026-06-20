# Middle-Mile Trailer Optimization Platform (MVP)

## What This Is

A logistics optimization MVP for a hub-and-spoke middle-mile truck network. It models
trailers as rear-to-nose ordered sequences of load blocks, treats RFID/barcode reads as
probabilistic sensor evidence, and continuously re-optimizes hub-to-hub freight flow to
reduce package rehandling, blocked freight, missed connections, and SLA failures while
keeping trailers well utilized.

This v1 is a **shipped simulation-driven MVP**: a synthetic event stream feeds an event-sourced
operational twin and a rolling-horizon optimizer, with a **realtime USA-map visualization**
(OpenLayers / OpenStreetMap) of hubs, trailers, routes, and freight flow as the centerpiece.
It is a proof-of-value demo, not a production pilot integrated with real WMS/TMS or RFID hardware.

## Core Value

Generate **route-aware, LIFO-correct trailer load plans that minimize blocked-freight
rehandle** and continuously repair them as conditions change — demonstrated live, end-to-end,
over a simulated USA hub network. If everything else fails, the load planner + operational
twin producing explainable plans must work.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

All 48 shipped in v1.0. OPT-02 and SNS-05 were dark on the live path in the milestone audit and were fixed before close (see milestones/v1.0-MILESTONE-AUDIT.md).

**Operational data foundation (FND)**
- ✓ FND-01 Append-only Postgres event store — v1.0
- ✓ FND-02 Per-stream optimistic concurrency + monotonic global sequence — v1.0
- ✓ FND-03 Typed ingestion API/bus — v1.0
- ✓ FND-04 Deterministic replay (live==rebuilt) — v1.0
- ✓ FND-05 "Where was package X last seen?" — v1.0
- ✓ FND-06 "What is on trailer T?" — v1.0
- ✓ FND-07 Hub current inventory — v1.0
- ✓ FND-08 Package movement audit timeline — v1.0

**Simulation (SIM)**
- ✓ SIM-01 USA hub-and-spoke network — v1.0
- ✓ SIM-02 Seeded deterministic event stream — v1.0
- ✓ SIM-03 Probabilistic RFID observations (miss rate+noise) — v1.0
- ✓ SIM-04 Operator scenario knobs — v1.0

**Visualization (VIZ)**
- ✓ VIZ-01 Realtime OL/OSM map of hubs+routes — v1.0
- ✓ VIZ-02 Trailers animate along route geometry from keyframes — v1.0
- ✓ VIZ-03 Hubs/routes colored by state — v1.0
- ✓ VIZ-04 Realtime state over WebSocket — v1.0
- ✓ VIZ-05 Click trailer → load order+instructions+explanation — v1.0

**Aggregation (AGG)**
- ✓ AGG-01 Group packages into load blocks (7-part key) — v1.0
- ✓ AGG-02 Aggregate volume/weight/count — v1.0
- ✓ AGG-03 Split oversized/incompatible blocks — v1.0
- ✓ AGG-04 Priority from SLA+deadline — v1.0

**Load planning (LOAD)**
- ✓ LOAD-01 Rear-to-nose slice/zone trailer model — v1.0
- ✓ LOAD-02 Route unload-order map — v1.0
- ✓ LOAD-03 Route-aware greedy LIFO plan — v1.0
- ✓ LOAD-04 Independent validator (HARD/SOFT, separate code path) — v1.0
- ✓ LOAD-05 Partial-LIFO (bounded blockers+rehandle cost) — v1.0
- ✓ LOAD-06 Rehandle risk score — v1.0
- ✓ LOAD-07 Utilization vs 75–90% band — v1.0
- ✓ LOAD-08 Human-readable loading instructions — v1.0
- ✓ LOAD-09 Naive FIFO baseline on shared KPI plumbing — v1.0
- ✓ LOAD-10 Per-placement rationale — v1.0

**Sensor fusion (SNS)**
- ✓ SNS-01 RFID as confidence-scored evidence (never coordinates) — v1.0
- ✓ SNS-02 Tag→package mapping — v1.0
- ✓ SNS-03 Confidence-scored zone estimate (rule-based Bayesian) — v1.0
- ✓ SNS-04 Wrong-trailer detection w/ severity+action — v1.0
- ✓ SNS-05 Missed-unload detection w/ severity+action — v1.0

**Optimizer (OPT)**
- ✓ OPT-01 Time-expanded hub graph — v1.0
- ✓ OPT-02 Min-cost-flow freight→route-leg assignment — v1.0
- ✓ OPT-03 VRP/VRPTW route planning — v1.0
- ✓ OPT-04 Sandboxed planning twin (no side effects) — v1.0
- ✓ OPT-05 Rolling-horizon re-opt (periodic+event-triggered, scoped) — v1.0
- ✓ OPT-06 Freeze windows + per-epoch idempotency — v1.0
- ✓ OPT-07 Local repair (split/reassign/hold/over-carry) w/ rationale — v1.0
- ✓ OPT-08 Plan selection minimizes weighted objective — v1.0

**Operator UI (UI)**
- ✓ UI-01 Alert feed for every exception — v1.0
- ✓ UI-02 Read-only audit timeline (w/ captured recommendation) — v1.0
- ✓ UI-03 KPI dashboard — v1.0
- ✓ UI-04 Before/after money slide — v1.0

### Active

<!-- Current scope. Building toward these. Detailed REQ-IDs live in REQUIREMENTS.md. -->

(none — v1.0 complete; run /gsd-new-milestone to scope v1.1)

### Out of Scope

<!-- Explicit boundaries with reasoning. -->

- **Real RFID/IoT hardware + live WMS/TMS integration** — v1 is simulation-driven; integration adapters are a later milestone.
- **Full 3D package packing / load-stability physics** — optimize at load-block + trailer-zone level, not per-package geometry (spec non-goal).
- **Centimeter-level real-time package localization** — RFID treated as probabilistic zone evidence only.
- **ML-based sensor fusion (HMM, particle filters, ML classifiers)** — start rule-based Bayesian; ML is spec Phase 5.
- **Full national single-run optimization** — decomposed, rolling-horizon, scoped per affected hubs/trailers.
- **Simulation/what-if "digital twin" policy testing + forecasting (spec Phase 5)** — deferred; v1 simulation only drives the operational demo.
- **3D visual twin, robotics/automated loading** — far-future (spec Stage 6).
- **Last-mile delivery routing** — out of the middle-mile problem domain.
- **Fully automated dispatch with no human override** — human override with audit stays in scope, full automation does not.

## Context

- **Shipped v1.0** — 42,591 LOC across 251 TS/TSX files, 10 pnpm packages (~21k src / ~21k test, TDD-heavy). Tech stack: TypeScript 5.9 strict / Node 22 / pnpm+Turborepo; Fastify 5 + @fastify/websocket + ws; Zod (not TypeBox); PostgreSQL via Kysely + pg, Testcontainers; custom time-expanded graph + SSP min-cost-flow + custom VRPTW (graphology/ngraph NOT adopted); glpk.js as a TEST-ONLY LP oracle; OpenLayers 10 + React 19 + Vite 7; Vitest 4 (872 unit+int tests / 98 files green) + Playwright (3 real chromium-real e2e). Lint 0 / typecheck 0 / build 10/10 at close. Known tech debt: in-memory (epoch,scopeHash) idempotency (no restart durability); utilization is a package-count proxy not true volume fill; UI-04 money slide is a calibrated seed-42 2-metric before/after (live 8-metric A/B deferred); 2 ws connections in web App (consolidate); scope-completeness under-scopes trailers loaded at a hub. Full debt list in milestones/v1.0-MILESTONE-AUDIT.md.
- **Source of truth:** A detailed 1,600-line technical specification lives at
  `rfid_middle_mile_trailer_optimization_tech_spec.md` (domain model, algorithms,
  event-sourced architecture, objective function, KPIs, risks, 6-phase roadmap, pilot plan).
  This project builds the spec's Phases 1–4 as a simulation-driven MVP.
- **Stack pivot:** The spec's recommended backend stack is JVM/Go/Rust + Kafka + Postgres,
  with Python for optimization prototypes. This build deliberately targets **TypeScript/Node**
  for single-language velocity, so the optimization and event-sourcing approaches must be
  realized in the JS/TS ecosystem (research focus area).
- **Demo framing:** Success is shown through simulation + the live USA map, not a production
  deployment. This keeps integration/hardware risk out of v1 while still proving the
  optimization and visibility value.
- **Domain edge cases that matter:** single rear-door trailers → rear-to-nose accessibility;
  partial-LIFO with bounded blockers; over-carry / hold / reassign as valid recovery moves;
  soft utilization target (75–90%); explainability + human override with full audit.

## Constraints

- **Tech stack**: TypeScript / Node.js backend, PostgreSQL persistence — single-language build for velocity.
- **Frontend**: TypeScript + OpenLayers (OpenStreetMap tiles) — realtime USA-map visualization is the demo centerpiece.
- **Data**: Simulated only — no real RFID hardware, IoT, or WMS/TMS integration in v1.
- **Optimization**: Custom greedy + local search, min-cost flow, VRP heuristics in the JS/TS ecosystem; exact solvers (Gurobi/MILP) out of scope.
- **Architecture**: Event-sourced operational twin + planning twin; in-process/lightweight event bus acceptable (Kafka deferred).
- **Quality**: Tests required (TDD); strong typing (no `any`, strict TS); explainable, auditable decisions.
- **Build model**: Solo agentic development (Claude builds) — favor simple, cohesive, well-established libraries.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Event-sourced operational twin + sandboxed planning twin on Postgres | auditability, deterministic replay, safe candidate eval; single store (no Kafka/EventStoreDB) | ✓ Good |
| Single canonical LIFO invariant + independent validator (separate code path) | defend inverted depth↔unload + feasibility-folded-into-score | ✓ Good |
| Custom SSP min-cost-flow + custom VRPTW in TS, integer arithmetic, glpk.js test-only oracle | no maintained JS lib; needed verifiable correctness | ✓ Good (exact vs glpk on 1,153 instances) |
| Rule-based Bayesian RFID fusion w/ confidence cap (<1.0) | realistic reliability, explainability over ML, miss≠gone | ✓ Good |
| Zod (not TypeBox); Kysely for SQL | ergonomic engine parsing; raw-SQL transparency for event log/projections | ✓ Good |
| Hand-rolled time-expanded graph (graphology/ngraph NOT adopted) | full control over edge kinds + determinism | ✓ Good (note: diverges from original stack rec) |
| Versioned ws keyframe+delta envelope; client tweens via OL postrender | forward-compatible; smooth animation w/o per-frame React re-render/alloc | ✓ Good (flat-heap soak-proven) |
| UI-04 money slide as calibrated seed-42 before/after (not live A/B) | reviewer-recommended MVP simplification; reproducible | ⚠️ Revisit (live 8-metric A/B = v2) |
| In-memory (epoch,scopeHash) idempotency | sufficient for single-process MVP demo | ⚠️ Revisit (no restart durability) |
| Two ws connections in web App | avoid refactoring MapView under time pressure | ⚠️ Revisit (consolidate) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-20 after v1.0 milestone*
