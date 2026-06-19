# Requirements: Middle-Mile Trailer Optimization Platform (MVP)

**Defined:** 2026-06-18
**Core Value:** Generate route-aware, LIFO-correct trailer load plans that minimize blocked-freight rehandle and continuously repair them as conditions change — demonstrated live over a simulated USA hub network.

> Scope = tech-spec Phases 1–4 (foundation → load planning → RFID validation → rolling optimizer) plus a
> simulation engine and realtime USA-map visualization wrapper. Stack: TypeScript/Node + PostgreSQL +
> OpenLayers. "User" = logistics operator / dock worker / demo audience. Requirements are capability-level
> and testable.

## v1 Requirements

### Operational Data Foundation (FND)

- [x] **FND-01**: The system records every domain change as an immutable, append-only event in a Postgres event store (Package/LoadBlock/Trailer/RFID/Plan lifecycle events)
- [x] **FND-02**: The event store enforces optimistic concurrency per stream (unique `aggregate_id + version`) and provides total ordering via a monotonic global sequence
- [x] **FND-03**: The system ingests package scans, trailer movements, and sensor observations through a typed ingestion API/bus
- [x] **FND-04**: State rebuilt purely by replaying the event log is identical to live state (deterministic replay — no wall-clock/random/unstable sort in reducers), verified by an automated live-vs-rebuilt test
- [x] **FND-05**: An operator can query "where was package X last seen?" and get last-known location with confidence and timestamp
- [x] **FND-06**: An operator can query "what is currently assigned to / observed on trailer T?"
- [x] **FND-07**: An operator can view a hub's current inventory (inbound, outbound, and staged blocks/packages)
- [x] **FND-08**: The system reconstructs a package's full movement history as an ordered audit timeline from events

### Load-Block Aggregation (AGG)

- [ ] **AGG-01**: The system groups packages into load blocks keyed by current hub, next/destination hub, SLA class, deadline bucket, handling class, and size/weight class
- [ ] **AGG-02**: Each load block computes aggregate volume, weight, and package count
- [ ] **AGG-03**: The system splits oversized or incompatible load blocks into feasible sub-blocks
- [ ] **AGG-04**: Each load block is assigned a priority derived from SLA class and deadline

### Trailer Model & Load Planning (LOAD)

- [ ] **LOAD-01**: A trailer is modeled as an ordered rear-to-nose sequence of slices/zones, each tracking used volume and weight
- [ ] **LOAD-02**: The system derives a route unload-order map so earlier-unload hubs map to positions closer to the rear door
- [ ] **LOAD-03**: The planner produces a route-aware LIFO load plan, placing blocks nose→rear so earlier-unload freight is more accessible (greedy placement)
- [ ] **LOAD-04**: An **independent validator** (separate code path from the planner) flags accessibility violations — more than the configured max blockers is a HARD violation, fewer is a SOFT violation; feasibility is a hard gate and is never folded into the optimization score
- [ ] **LOAD-05**: The planner supports partial-LIFO — it accepts bounded blockers and assigns rehandle cost instead of rejecting the plan outright
- [ ] **LOAD-06**: The system computes a rehandle risk score per block and per plan (blocker count/volume, fragile penalty, dock-delay and SLA-impact penalties)
- [ ] **LOAD-07**: The system computes trailer utilization and scores it against a soft 75–90% band (penalty on both under- and over-utilization)
- [ ] **LOAD-08**: The system emits human-readable loading instructions (load order by nose/middle/rear zone) per trailer
- [ ] **LOAD-09**: A naive **baseline planner** (e.g., arrival/FIFO order) runs on the same inputs as the optimizer to enable before/after comparison, sharing KPI plumbing
- [ ] **LOAD-10**: Each placement decision carries a human-readable rationale (e.g., "LB-H8 placed rear: unloads first; avoids 18-min rehandle") — explainable planning

### RFID-Assisted Validation (SNS)

- [ ] **SNS-01**: The system ingests RFID and barcode observations as confidence-scored evidence (reader/antenna/RSSI → probability), never as exact coordinates
- [ ] **SNS-02**: The system maps RFID tag IDs to package IDs
- [ ] **SNS-03**: The system produces a confidence-scored trailer-zone estimate (rear/middle/nose) per package using rule-based Bayesian fusion
- [ ] **SNS-04**: The system detects wrong-trailer events (package observed in a trailer not assigned by plan) and emits an exception with severity and recommended action
- [ ] **SNS-05**: The system detects missed-unload events (package for the current hub still observed in the trailer after departure) and emits an exception with severity and recommended action

### Rolling Optimizer (OPT)

- [ ] **OPT-01**: The system builds a time-expanded hub-network graph (hub@time nodes; trip/wait/cross-dock/load/unload edges)
- [ ] **OPT-02**: The system assigns freight blocks to route legs via min-cost flow, minimizing transport + waiting + handling + SLA-lateness + missed-connection cost under edge/hub capacity and time-window constraints
- [ ] **OPT-03**: The system performs VRP/VRPTW-style trailer/truck route planning, producing stop sequence, departure/arrival times, and utilization estimate
- [ ] **OPT-04**: The optimizer evaluates candidate plans on a sandboxed planning twin with no operational side effects until a plan is accepted
- [ ] **OPT-05**: The system re-optimizes on a rolling horizon, triggered periodically and by events, scoped to only the affected hubs/trailers/blocks
- [ ] **OPT-06**: The optimizer honors freeze windows (no changes to trailers departing within the configured window unless critical) and is idempotent per epoch/scope (no plan thrashing)
- [ ] **OPT-07**: Local repair produces recovery recommendations — split, reassign, hold, or over-carry — when a plan is infeasible or high-cost, each with a rationale
- [ ] **OPT-08**: Plan selection minimizes the weighted objective function (miles, driver time, dock wait, handling, rehandle, SLA lateness, utilization, over-carry penalties)

### Simulation Engine (SIM)

- [x] **SIM-01**: The simulator models a USA hub-and-spoke network — hubs with lat/long, linehaul routes, trailers, and packages
- [x] **SIM-02**: The simulator generates a realistic, seeded, deterministic event stream (scans, trailer trips, arrivals) that drives the operational twin
- [ ] **SIM-03**: The simulator emits RFID observations with configurable miss rate and noise (probabilistic reads), not perfect reads
- [ ] **SIM-04**: An operator can adjust scenario knobs (inject hub congestion, trip delays, demand spikes, sensor-noise level) that trigger visible re-optimization

### Realtime Visualization (VIZ)

- [x] **VIZ-01**: A realtime web map (OpenLayers + OpenStreetMap tiles) shows all hubs and routes across the USA
- [ ] **VIZ-02**: Trailers animate along their route geometry in realtime, interpolated from server-pushed position/ETA keyframes
- [ ] **VIZ-03**: Hubs and routes are colored by state (freight volume, SLA risk, congestion)
- [ ] **VIZ-04**: Realtime state streams to the client over WebSocket as the simulation/optimizer advance
- [ ] **VIZ-05**: Clicking a trailer shows its rear-to-nose load order, loading instructions, and the plan's explanation

### Operator UI & KPIs (UI)

- [ ] **UI-01**: An alert feed surfaces every exception (wrong-trailer, missed-unload, blocked-freight, low-utilization) with severity, human-readable reason, and recommended action
- [ ] **UI-02**: A read-only audit timeline shows a package's or trailer's full event history, including the system recommendation captured at each decision
- [ ] **UI-03**: A KPI dashboard displays operational KPIs (utilization, rehandle count/minutes, wrong-trailer count, missed-unload count, SLA violation rate, on-time departure/arrival)
- [ ] **UI-04**: The dashboard shows **before/after KPI deltas** comparing the baseline planner vs the optimizer on the same simulated stream (the "money slide")

## v2 Requirements

Deferred — acknowledged but not in the current roadmap.

### Enhanced Visualization (VIZX)

- **VIZX-01**: RFID confidence heatmaps (trailer-zone confidence shading; hub read-quality overlay)
- **VIZX-02**: Over-carry / hold / reassign recommendations drawn as re-routing animations on the map
- **VIZX-03**: 2D trailer fill / load-sequence visual (rear→nose block stack per trailer)

### Operations (OPS)

- **OPS-01**: Human override workflow — edit/approve plans, hold/ship decisions, override capture (who/when/what/why/recommendation)
- **OPS-02**: Richer simulation scenarios (multi-hub cascade failures, seasonal demand spikes)

## Out of Scope

Explicitly excluded — documented to prevent scope creep (from spec §4/§19.2 + PROJECT.md + research anti-features).

| Feature | Reason |
|---------|--------|
| Full 3D package packing / load-stability physics | Intractable, no demo value over zone model; spec non-goal. Optimize at load-block/zone granularity. |
| ML-based sensor fusion (HMM, particle filters, ML classifiers) | No training data; spec Phase 5; hurts explainability. Use rule-based Bayesian. |
| Real RFID/IoT hardware + live WMS/TMS integration | Hardware/integration risk is what the sim-driven framing removes; later milestone. |
| Full national single-run optimization | Computationally intractable; system is decomposed + rolling-horizon by design. |
| Full what-if / digital-twin policy testing | Spec Phase 5; v1 sim drives the operational demo only. Scenario knobs give a taste. |
| Exact MILP solvers (Gurobi) | Licensing + JS mismatch; heuristics + glpk.js oracle suffice. |
| Complex dock-scheduling optimization | Spec exclusion; orthogonal to the load/route story. Dock doors = simple capacity. |
| Centimeter-level real-time package localization | Physically unreliable RFID; probabilistic zone estimates only. |
| Last-mile delivery routing | Outside the middle-mile problem domain. |

## Traceability

Each v1 requirement maps to exactly one phase. See ROADMAP.md for phase goals and success criteria.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 1 | Complete |
| FND-02 | Phase 1 | Complete |
| FND-03 | Phase 1 | Complete |
| FND-04 | Phase 1 | Complete |
| FND-05 | Phase 1 | Complete |
| FND-06 | Phase 1 | Complete |
| FND-07 | Phase 1 | Complete |
| FND-08 | Phase 1 | Complete |
| SIM-01 | Phase 1 | Complete |
| SIM-02 | Phase 1 | Complete |
| VIZ-01 | Phase 1 | Complete |
| AGG-01 | Phase 2 | Pending |
| AGG-02 | Phase 2 | Pending |
| AGG-03 | Phase 2 | Pending |
| AGG-04 | Phase 2 | Pending |
| LOAD-01 | Phase 2 | Pending |
| LOAD-02 | Phase 2 | Pending |
| LOAD-03 | Phase 2 | Pending |
| LOAD-04 | Phase 2 | Pending |
| LOAD-05 | Phase 2 | Pending |
| LOAD-06 | Phase 2 | Pending |
| LOAD-07 | Phase 2 | Pending |
| LOAD-08 | Phase 2 | Pending |
| LOAD-09 | Phase 2 | Pending |
| LOAD-10 | Phase 2 | Pending |
| SNS-01 | Phase 3 | Pending |
| SNS-02 | Phase 3 | Pending |
| SNS-03 | Phase 3 | Pending |
| SNS-04 | Phase 3 | Pending |
| SNS-05 | Phase 3 | Pending |
| SIM-03 | Phase 3 | Pending |
| OPT-01 | Phase 4 | Pending |
| OPT-02 | Phase 4 | Pending |
| OPT-03 | Phase 4 | Pending |
| OPT-04 | Phase 4 | Pending |
| OPT-05 | Phase 4 | Pending |
| OPT-06 | Phase 4 | Pending |
| OPT-07 | Phase 4 | Pending |
| OPT-08 | Phase 4 | Pending |
| SIM-04 | Phase 5 | Pending |
| VIZ-02 | Phase 5 | Pending |
| VIZ-03 | Phase 5 | Pending |
| VIZ-04 | Phase 5 | Pending |
| VIZ-05 | Phase 5 | Pending |
| UI-01 | Phase 5 | Pending |
| UI-02 | Phase 5 | Pending |
| UI-03 | Phase 5 | Pending |
| UI-04 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 48 total (FND 8, AGG 4, LOAD 10, SNS 5, OPT 8, SIM 4, VIZ 5, UI 4)
- Mapped to phases: 48 ✓
- Unmapped: 0 ✓

**Per-phase counts:** Phase 1 = 11 (FND 8 + SIM-01/02 + VIZ-01) · Phase 2 = 14 (AGG 4 + LOAD 10) · Phase 3 = 6 (SNS 5 + SIM-03) · Phase 4 = 8 (OPT 8) · Phase 5 = 9 (SIM-04 + VIZ-02..05 + UI 4)

---
*Requirements defined: 2026-06-18*
*Last updated: 2026-06-18 after roadmap traceability mapping (48/48 mapped to 5 phases)*
