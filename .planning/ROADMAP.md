# Roadmap: Middle-Mile Trailer Optimization Platform (MVP)

## Overview

This is a simulation-driven, event-sourced MVP that proves route-aware, LIFO-correct trailer load
planning over a simulated USA hub network — visualized live on an OpenLayers map. The journey is
strictly bottom-up: an append-only Postgres event store + operational projections form the twin
everything reads from, fed early by a minimal simulation engine and lit up immediately on a thin
geo-only map slice (de-risking the OpenLayers centerpiece). The load planner — the load-bearing "if
all else fails" deliverable, with its independent LIFO validator and a naive baseline to beat — lands
next. RFID-assisted detection follows, because exceptions are *planned-vs-observed* disagreements that
need both a plan and probabilistic sensor evidence. The custom rolling-horizon optimizer (min-cost
flow + VRPTW, the concentrated engineering risk) repairs plans continuously. Finally the full
delivery wrapper — animated trailers, scenario knobs, exception feed, audit timeline, and the
before/after KPI "money slide" — composes everything into the persuasive live demo.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Operational Data Foundation + Live Map Spike** - Event-sourced twin with deterministic replay + optimistic concurrency, fed by a minimal simulator and lit up on an empty USA map
- [ ] **Phase 2: Load Planning** - Route-aware LIFO/partial-LIFO load plans with an independent validator, explainable rationale, and a naive baseline to beat
- [ ] **Phase 3: RFID-Assisted Validation** - Probabilistic RFID evidence and wrong-trailer / missed-unload detection with severity and recommended action
- [ ] **Phase 4: Rolling Optimizer** - Continuous, scoped re-optimization (min-cost flow + VRPTW) with freeze windows, anti-thrashing, and split/reassign/hold/over-carry repair
- [ ] **Phase 5: Simulation + Visualization Wrapper** - Animated realtime USA map, scenario knobs, exception feed, audit timeline, and the before/after KPI dashboard

## Phase Details

### Phase 1: Operational Data Foundation + Live Map Spike
**Goal**: An auditable, deterministically-replayable operational twin that answers "where was package X?" and "what's on trailer T?", fed by a minimal simulator and visible as hubs + moving trailers on an empty USA map.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: FND-01, FND-02, FND-03, FND-04, FND-05, FND-06, FND-07, FND-08, SIM-01, SIM-02, VIZ-01
**Success Criteria** (what must be TRUE):
  1. An operator can ask "where was package X last seen?" and "what's on trailer T?" and get a correct answer (location + confidence + timestamp; trailer contents), plus a hub's current inbound/outbound/staged inventory and a package's full ordered audit timeline.
  2. Running the simulator generates a seeded, deterministic event stream (package scans, trailer trips, arrivals) over a USA hub-and-spoke network that drives the operational projections — re-running the same seed produces an identical event log.
  3. A live-vs-rebuilt CI test passes: dropping every projection and rebuilding it purely by replaying the event log (strictly by global sequence) yields byte-identical state to the live run.
  4. Concurrent appends to the same stream are rejected by a `UNIQUE(stream_id, version)` optimistic-concurrency guard (the conflicting writer reloads and retries), and re-applying an already-processed event is a no-op (idempotent projections).
  5. A thin OpenLayers + OSM web slice renders all hubs and routes across the USA and shows simulated trailers as points driven by the geo-track projection — the empty-but-live map centerpiece.
**Plans**: 7 plans
Plans:
- [x] 01-01-PLAN.md — Walking skeleton: monorepo + OrbStack Postgres + one event → inline projection → API read → live OSM map with one real hub (FND-01) + SKELETON.md
- [x] 01-02-PLAN.md — Domain: closed versioned DomainEvent union + zod-validated typed ingestion boundary (FND-01, FND-03)
- [x] 01-03-PLAN.md — Event store: append-only JSONB + optimistic concurrency (UNIQUE(stream_id,version) + ConcurrencyError + retry) + global ordering (FND-01, FND-02)
- [x] 01-04-PLAN.md — Operational projections: pure reducers, idempotent inline fold, truncate+replay golden-replay test (FND-04, FND-05, FND-06, FND-07)
- [x] 01-05-PLAN.md — Simulation: ~10 US metro hubs + great-circle routes + seeded deterministic event stream driving projections (SIM-01, SIM-02)
- [x] 01-06-PLAN.md — Query API + audit-timeline + geo-track projections + ws snapshots (FND-05, FND-06, FND-07, FND-08)
- [x] 01-07-PLAN.md — Live OpenLayers + OSM web slice: hubs + routes + live trailer points with leak guard (VIZ-01)
**UI hint**: yes

Notes: This phase bakes in the foundation's HIGH-cost-to-retrofit invariants. Enforce determinism (P3: pure (state,event) reducers, no `Date.now()`/`Math.random()`/unstable sort in handlers, timestamps from event payloads, replay by `global_seq` only), optimistic concurrency (P4: `UNIQUE(stream_id, version)` + retry-on-conflict — the sim and, later, the optimizer are concurrent writers), idempotent projections (P5a: per-projection last-seq fold), and event `schemaVersion` discriminators on the closed `DomainEvent` union (P11). The simulator is pulled in here deliberately — it is the only data source for every later phase — and the thin geo-only map slice is stood up now to de-risk OpenLayers before the optimizer lands. A `Clock` abstraction separates domain time (`occurred_at`) from wall time (`recorded_at`). Map full animation/interaction is deferred to Phase 5; this slice only proves hubs + routes + points render live without leaks.

### Phase 2: Load Planning
**Goal**: The system produces explainable, route-aware LIFO/partial-LIFO trailer load plans with human-readable loading instructions, scored for rehandle and utilization, gated by an independent feasibility validator — and a naive baseline planner that runs on the same inputs so the optimizer always has something to beat.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: AGG-01, AGG-02, AGG-03, AGG-04, LOAD-01, LOAD-02, LOAD-03, LOAD-04, LOAD-05, LOAD-06, LOAD-07, LOAD-08, LOAD-09, LOAD-10
**Success Criteria** (what must be TRUE):
  1. Packages are grouped into load blocks keyed by hub/destination/SLA/deadline-bucket/handling/size, each with aggregate volume, weight, package count, and an SLA+deadline-derived priority; oversized or incompatible blocks split into feasible sub-blocks.
  2. The planner produces a rear-to-nose load plan placing earlier-unload freight more accessible to the rear door, emits human-readable loading instructions by nose/middle/rear zone, and attaches a plain-English rationale to every placement (e.g., "LB-H8 placed rear: unloads first; avoids 18-min rehandle").
  3. An independent validator (separate code path that recomputes blockers from placed slices) flags accessibility violations — exceeding max blockers is a HARD violation, fewer is SOFT — and feasibility is a hard gate that is never folded into the optimization score; partial-LIFO accepts bounded blockers with a rehandle cost instead of rejecting outright.
  4. Each block and plan gets a rehandle risk score (blocker count/volume, fragile/dock-delay/SLA penalties) and a utilization score against the soft 75–90% band (penalty on both under- and over-utilization).
  5. A naive baseline planner (e.g., arrival/FIFO order) runs on the *same* inputs through shared KPI plumbing, enabling a before/after comparison later.
**Plans**: 6 plans
Plans:
- [x] 02-01-PLAN.md — Domain: flesh out LoadBlock/TrailerSlice + Phase-2 planning value types (PlanningPackage, SLA/handling/size enums, PlannerConfig defaults) — the shared contract (AGG-01, AGG-02, LOAD-01)
- [x] 02-02-PLAN.md — @mm/aggregation (pure, TDD): aggregate→split→priority→deadline-bucket; packages → feasible, scored, prioritized load blocks (AGG-01, AGG-02, AGG-03, AGG-04)
- [x] 02-03-PLAN.md — @mm/load-planner foundation (pure, TDD): ONE canonical LIFO invariant + blocker predicate, rear→nose trailer model, route unload-order map, P2-separated type contracts (LOAD-01, LOAD-02)
- [x] 02-04-PLAN.md — Greedy planner + INDEPENDENT virtual-unload validator + partial-LIFO + the keystone golden reversed-plan fixture + planner-vs-validator property test (LOAD-03, LOAD-04, LOAD-05)
- [x] 02-05-PLAN.md — Scoring (rehandle + utilization, P2-separate), loading instructions, per-placement rationale, FIFO baseline sharing the scoring plumbing + beat-it test (LOAD-06, LOAD-07, LOAD-08, LOAD-09, LOAD-10)
- [x] 02-06-PLAN.md — Thin @mm/api POST /plan: runs aggregate→plan+baseline→validate→score→instructions, gates on feasibility (P2 at the boundary); demoable end to end (LOAD-08)

Notes: This is the load-bearing correctness phase. Defend against P1 (inverted LIFO depth↔unload-order mapping) with one canonical invariant asserted everywhere, an *independent* validator that recomputes blockers from placed slices rather than trusting placement order, and golden fixtures that flag a deliberately-reversed plan (the single most important test in the codebase) plus a property test fuzzing the planner against the validator. Defend against P2 (feasibility folded into score) by keeping feasibility (hard gate) and rehandle cost (soft score) as two separate validation outputs, never collapsed until the gate passes; unit-test the exact blocker predicate with same-hub and multi-block-slice fixtures. The baseline planner is designed in *here* (P8) because the planner already needs something to beat; it shares KPI plumbing so the Phase 5 "money slide" is wiring, not a rebuild. `aggregation` and `load-planner` are pure, IO-free, TDD-friendly modules.

### Phase 3: RFID-Assisted Validation
**Goal**: The system ingests RFID/barcode reads as confidence-scored probabilistic evidence (never coordinates), produces per-package trailer-zone estimates, and detects wrong-trailer and missed-unload events with severity and a recommended action — comparing planned state against observed evidence.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: SNS-01, SNS-02, SNS-03, SNS-04, SNS-05, SIM-03
**Success Criteria** (what must be TRUE):
  1. The simulator emits RFID observations with a configurable miss rate and noise (probabilistic reads, not perfect ones), and the system ingests RFID/barcode observations as confidence-scored evidence (reader/antenna/RSSI → probability), mapping tag IDs to package IDs.
  2. The system produces a confidence-scored rear/middle/nose zone estimate per package using rule-based Bayesian fusion, with repeated reads of the same tag in one dwell collapsed into a single windowed observation and confidence capped (never asymptoting to 1.0 from repetition).
  3. The system detects wrong-trailer events (a package observed in a trailer the plan did not assign) and emits an exception with severity and a recommended action — only on positive observation in the wrong place above a confidence threshold.
  4. The system detects missed-unload events (a package for the current hub still observed in the trailer after departure) and emits an exception with severity and a recommended action.
  5. A missing RFID read never marks a package as "missing" or vanished (absence of evidence ≠ evidence of absence), and the exception feed is not flooded with false positives.
**Plans**: TBD

Notes: Detection must follow load planning because it compares *planned* (from scans + plan, Phase 2) against *observed* (RFID evidence) — both inputs must already exist. Defend against P6 (RFID-as-truth) with two explicit layers (planned/known vs confidence-scored observed); raise exceptions only on disagreement above threshold; a missed read must never imply "package gone." Defend against P5b (double-counted observations) with per-tag/per-reader/per-dwell observation windows feeding one fused observation, and an explicit independence model that caps confidence. Track the false-positive rate as a demo KPI. `sensor-fusion` is a pure scoring module; the exceptions projection is decision-critical (inline).

### Phase 4: Rolling Optimizer
**Goal**: A continuous, scoped re-optimization loop that assigns freight across a time-expanded hub graph (min-cost flow), sequences trailer routes (VRP/VRPTW), evaluates candidates on a sandboxed planning twin, and repairs infeasible/high-cost plans (split/reassign/hold/over-carry) under a weighted objective — stably, without thrashing.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: OPT-01, OPT-02, OPT-03, OPT-04, OPT-05, OPT-06, OPT-07, OPT-08
**Success Criteria** (what must be TRUE):
  1. The system builds a time-expanded hub-network graph (hub@time nodes; trip/wait/cross-dock/load/unload edges) and assigns freight blocks to route legs via min-cost flow, minimizing transport + waiting + handling + SLA-lateness + missed-connection cost under edge/hub capacity and time-window constraints.
  2. The system performs VRP/VRPTW trailer/truck route planning (stop sequence, departure/arrival times, utilization estimate), and the load-planner (Phase 2) is invoked as the load-plan layer — feasibility still gates before scoring (P2 reinforced: the objective can't "buy out" an un-unloadable trailer).
  3. The optimizer re-optimizes on a rolling horizon (periodic + event-triggered, scoped to only affected hubs/trailers/blocks), evaluating candidates on a sandboxed planning twin with no operational side effects until a plan is accepted (then a single PlanGenerated/PlanAccepted event).
  4. Freeze windows are honored (no changes to trailers departing within the window unless critical) and replanning is idempotent per epoch/scope — identical input yields an identical plan, with a churn penalty and deterministic tie-breaks so plans don't thrash.
  5. Local repair produces recovery recommendations — split, reassign, hold, or over-carry — each with a rationale, and plan selection minimizes the weighted objective (miles, driver time, dock wait, handling, rehandle, SLA lateness, utilization, over-carry penalties).
**Plans**: TBD

Notes: This is where engineering risk concentrates — there is no maintained JS min-cost-flow or VRP/OR-Tools binding, so the min-cost flow (Successive Shortest Paths), VRPTW heuristic, and the layered pipeline are custom TypeScript over `graphology`/`ngraph.path`, with **glpk.js (WASM) held in reserve as a correctness oracle** for small instances. Defend against P7 (plan thrashing) with a hard freeze window enforced in the input builder, a `planChurnPenalty` anchoring to the previous plan, and stable id-based tie-breaks / fixed seed. Defend against P9 (graph explosion) with coarse 15-min time nodes, tight affected-scope pruning, and a small demo network — track solver runtime as a KPI. Defend against P12 (numerical issues) by scaling all costs to integers and validating against hand-computed small cases and the glpk.js oracle. Flagged for `/gsd-research-phase`: which JS/TS approach for min-cost flow + VRPTW (pure-TS SSP vs glpk.js LP vs OR-Tools-WASM/child-process bridge). The optimizer owns the planning twin and is a concurrent event-store writer — re-verify Phase 1's optimistic concurrency holds.

### Phase 5: Simulation + Visualization Wrapper
**Goal**: The complete live demo — animated trailers on the realtime USA map colored by state, click-through to a trailer's load plan and "why", a streaming exception feed, a read-only audit timeline, scenario knobs that drive visible re-optimization, and the before/after KPI dashboard that proves the optimizer beats the baseline.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: SIM-04, VIZ-02, VIZ-03, VIZ-04, VIZ-05, UI-01, UI-02, UI-03, UI-04
**Success Criteria** (what must be TRUE):
  1. Trailers animate smoothly along their route geometry in realtime — interpolated client-side from server-pushed position/ETA keyframes over WebSocket — and hubs/routes are colored by state (freight volume, SLA risk, congestion) as the simulation/optimizer advance.
  2. Clicking a trailer on the map shows its rear-to-nose load order, loading instructions, and the plan's plain-English explanation.
  3. An operator can adjust scenario knobs (inject hub congestion, trip delays, demand spikes, sensor-noise level) and watch plans visibly re-optimize live; the exception feed surfaces every exception (wrong-trailer, missed-unload, blocked-freight, low-utilization) with severity, reason, and recommended action.
  4. A read-only audit timeline shows a package's or trailer's full event history including the system recommendation captured at each decision, and a KPI dashboard displays operational KPIs (utilization, rehandle count/minutes, wrong-trailer count, missed-unload count, SLA violation rate, on-time departure/arrival).
  5. The dashboard shows before/after KPI deltas comparing the baseline planner vs the optimizer on the *same* seeded simulated stream — the "money slide."
**Plans**: TBD
**UI hint**: yes

Notes: This wrapper composes everything and lands last because it visualizes the outputs of every prior phase. The before/after comparison (P8 delivery) is the highest-leverage differentiator and is mostly wiring given the Phase 2 baseline + shared KPI plumbing; seed-frozen scenarios make it reproducible. Defend against P10 (OpenLayers perf/leaks) with in-place geometry mutation (never rebuild the source each frame), rAF-batched diffs, WebGL points for many trailers, strict OL disposal on teardown, and sim-clock-driven interpolation clamped to [0,1] — verify flat memory over a multi-minute run. The server pushes keyframe/ETA diffs, not per-second positions; the client tweens. Flagged for `/gsd-research-phase`: OpenLayers high-trailer-count rendering strategy + smooth interpolation cadence (worth a focused spike). Calibrate the simulator so scenarios are hard enough that LIFO sometimes can't win without over-carry/hold/reassign — otherwise the optimizer's win is theater.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Operational Data Foundation + Live Map Spike | 7/7 | ✅ Complete | 2026-06-19 |
| 2. Load Planning | 6/6 | ✅ Complete | 2026-06-19 |
| 3. RFID-Assisted Validation | 0/TBD | Not started | - |
| 4. Rolling Optimizer | 0/TBD | Not started | - |
| 5. Simulation + Visualization Wrapper | 0/TBD | Not started | - |
