# Middle-Mile Trailer Optimization Platform (MVP)

## What This Is

A logistics optimization MVP for a hub-and-spoke middle-mile truck network. It models
trailers as rear-to-nose ordered sequences of load blocks, treats RFID/barcode reads as
probabilistic sensor evidence, and continuously re-optimizes hub-to-hub freight flow to
reduce package rehandling, blocked freight, missed connections, and SLA failures while
keeping trailers well utilized.

This v1 is a **simulation-driven MVP**: a synthetic event stream feeds an event-sourced
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

(None yet — ship to validate)

### Active

<!-- Current scope. Building toward these. Detailed REQ-IDs live in REQUIREMENTS.md. -->

**Operational data foundation (spec Phase 1)**
- [ ] Event-sourced domain model: Package, LoadBlock, Trailer, TrailerSlice, Hub, DockDoor, Route, Trip
- [ ] Event ingestion + event store with core event types (scans, trailer movements, RFID, plan lifecycle)
- [ ] Projections: current package location, trailer state, hub inventory, audit timeline
- [ ] Answer "where was package X last seen?" and "what is on trailer T?"

**Load planning (spec Phase 2)**
- [ ] Load-block aggregation (group packages by hub/destination/SLA/deadline/handling/size)
- [ ] Rear-to-nose trailer slice model with route unload-order map
- [ ] Route-aware LIFO / partial-LIFO load planner (greedy + local repair)
- [ ] Rehandle risk scoring and trailer utilization scoring (soft 80% target)
- [ ] Loading instructions output (load order by zone) + LIFO validation

**RFID-assisted validation (spec Phase 3)**
- [ ] RFID/barcode observation ingestion as confidence-scored evidence (rule-based Bayesian)
- [ ] Tag-to-package mapping and confidence-scored zone estimates
- [ ] Wrong-trailer detection and missed-unload detection with severity + recommended action

**Rolling optimizer (spec Phase 4)**
- [ ] Time-expanded hub network graph + min-cost flow freight assignment
- [ ] VRP/VRPTW-style trailer/truck route planning
- [ ] Rolling-horizon re-optimization (event-triggered + periodic) with freeze windows
- [ ] Local repair actions: split / reassign / hold / over-carry, with weighted objective function

**Simulation + visualization (delivery wrapper)**
- [ ] Simulation engine producing realistic package/trailer/sensor events over a USA hub network
- [ ] Realtime USA-map visualization (OpenLayers/OSM): hubs, trailers in motion, routes, freight/SLA state
- [ ] Minimal read-only operator UI: load plan view, exception alerts, audit timeline, basic KPI dashboard

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
| Build spec Phases 1–4 as v1 (foundation → load planner → RFID validation → rolling optimizer) | Delivers the spec's "first business value" plus continuous optimization; Phase 5 sim/ML deferred | — Pending |
| TypeScript/Node + PostgreSQL stack | Single-language velocity for a solo agentic build; full-stack incl. map UI in one ecosystem | — Pending |
| Simulated data + realtime USA-map (OpenLayers/OSM) as the deliverable | Proves optimization + visibility value without hardware/integration risk; map is the demo centerpiece | — Pending |
| Optimize at load-block / trailer-zone granularity (not per-package 3D) | Spec recommendation; keeps optimization tractable and operationally realistic | — Pending |
| Event-sourced architecture with operational + planning twins | Auditability, exception handling, and safe candidate-plan evaluation (spec §9, §18) | — Pending |
| RFID as probabilistic evidence, rule-based Bayesian fusion | Realistic sensor reliability; ML fusion deferred to Phase 5 | — Pending |
| Minimal read-only operator UI (no override workflow in v1 beyond audit) | Demo scope; keeps focus on engine + visualization | — Pending |

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
*Last updated: 2026-06-18 after initialization*
