# Project Research Summary

**Project:** Middle-Mile Trailer Optimization Platform (MVP)
**Domain:** Event-sourced, simulation-driven logistics optimization (middle-mile RFID-assisted trailer load planning + rolling-horizon hub-network optimization) with a realtime USA-map demo
**Researched:** 2026-06-18
**Confidence:** HIGH on stack/architecture/features/event-sourcing; MEDIUM on the optimizer tier (net-new custom algorithms with no maintained JS libraries)

## Executive Summary

This is a **proof-of-value demo**, not a production pilot: a synthetic event stream feeds an event-sourced operational twin and a rolling-horizon optimizer, with a live OpenLayers USA map as the centerpiece. Experts build this domain as an event-sourced system (append-only log → projections → twins) with a *decomposed*, layered optimizer (the spec's §10 warning against one monolithic MILP is non-negotiable). The deliberate stack pivot to single-language TypeScript/Node + PostgreSQL is sound for a solo agentic build for every tier **except optimization** — that is where the JVM→TS gap is real and where engineering risk concentrates.

The recommended approach is a **modular monolith**: Fastify 5 as a thin HTTP/WS shell, Kysely 0.29 over `pg` for full SQL control of a roll-your-own Postgres append-only event store (Emmett 0.42 as pattern reference, not a dependency), an in-process typed event bus, a custom deterministic tick/event-queue simulator (seeded RNG), `ws` 8 pushing keyframe diffs to an OpenLayers 10.9 + React 19 map that interpolates motion client-side. The build order falls out of the dependency graph: **event store → projections → simulation early (the only data source) → load-planner before optimizer → a thin geo api+web slice stood up early to de-risk the map**. The defining engineering reality is that **no maintained JS min-cost-flow or VRP/OR-Tools binding exists** — the min-cost flow, VRPTW heuristic, and LIFO load planner are all custom TypeScript (the product's core IP), with `glpk.js` (WASM GLPK) held in reserve as a correctness *oracle* for small instances.

The defining **risk** is a **demo that silently lies**. The most dangerous failures are not crashes but plausible-looking wrong answers: an inverted LIFO depth↔unload-order mapping that produces exactly-reversed plans (validated by an equally-inverted validator), feasibility (`maxAllowedBlockers`) folded into a soft objective so the optimizer ships physically un-unloadable trailers, RFID treated as truth instead of probabilistic evidence (alert floods), non-deterministic event replay that breaks auditability, and — above all — **no baseline planner**, which makes every "we reduced rehandle X%" claim unfalsifiable theater. Mitigation is structural and must be designed in from the relevant phase: an *independent* validator with golden fixtures, a hard feasibility gate separate from scoring, a live-vs-rebuilt projection equivalence CI test from Phase 1, planned-vs-observed sensor layers, and a naive baseline planner running on the same seeded stream feeding a before/after KPI comparison (the single highest-ROI differentiator).

## Key Findings

### Recommended Stack

A thin, fast, single-language TS/Node stack over PostgreSQL. The web/API/DB/realtime/sim/tooling tiers are low-risk, well-trodden territory (HIGH confidence). The optimizer tier is mostly custom code (MEDIUM) — budget the bulk of engineering risk there. See `STACK.md` for full versions, rationale, and rejected libraries. (Banner Stack: **Fastify 5 + Kysely/`pg` + roll-your-own Postgres event store + in-process bus; `ws` + OpenLayers 10.9/React 19; custom TS optimizer over graphology with glpk.js as oracle.**)

**Core technologies:**
- **Fastify 5 + TypeBox/Zod** — thin HTTP/WS shell over an event-sourced core (~3× Express, schema-derived types; NestJS DI ceremony is overkill solo).
- **Kysely 0.29 over `pg` 8** — type-safe SQL with full control over append-with-version-check, projection upserts, window/CTE queries (avoid Prisma; Drizzle acceptable).
- **PostgreSQL 16/17** — single durable store for the append-only event log AND projection read models; `LISTEN/NOTIFY` wakes loops.
- **Roll-your-own event store** (single `events` table + per-stream optimistic concurrency) — Emmett 0.42 as pattern reference; do NOT introduce EventStoreDB or Kafka in v1.
- **In-process typed event bus** (~100 LOC) — defer BullMQ+Redis until durable retries / parallel workers are actually needed.
- **Custom optimizer in TS** — min-cost flow (Successive Shortest Paths), VRPTW (savings/insertion + 2-opt/Or-opt), LIFO load planner (greedy + local repair) over `graphology` + `ngraph.path`; **glpk.js (WASM)** as an LP correctness oracle, NOT the primary path. Do NOT use `node_or_tools` (dead) or `min-cost-flow` npm (unmaintained).
- **`ws` 8 + OpenLayers 10.9 + React 19 + Vite** — server pushes keyframe/ETA diffs; client interpolates trailer motion along route LineStrings via `postrender` (keep the map in a `useRef`).
- **Custom deterministic simulator** (seeded RNG, virtual clock) — do NOT adopt SimScript/SIM.JS (stale, coroutine model fights determinism + event sourcing).
- **Tooling:** pnpm workspaces + Turborepo 2, Vitest 4 (+ Testcontainers for real-Postgres event-store tests), TypeScript 5.9 strict (`noUncheckedIndexedAccess`).

### Expected Features

This is a demo: "table stakes" = the demo isn't *credible* without it; "differentiators" = what makes it *compelling*. The sim engine and live map are themselves table stakes — they make every backend capability visible. See `FEATURES.md`. (Banner Table Stakes: **event-sourced twin + state queries, load-block aggregation, rear-to-nose LIFO planner + scoring + loading instructions, RFID confidence-scored evidence, wrong-trailer/missed-unload detection, rolling re-optimization, sim engine, live USA map + KPI dashboard.**)

**Must have (table stakes):**
- **Event-sourced operational twin + queries** ("where is package X?", "what's on trailer T?") — the foundation everything reads from.
- **Load-block aggregation** + **rear-to-nose slice model** — the optimization unit and core domain abstraction.
- **Route-aware LIFO / partial-LIFO load planner** (greedy + local repair) — THE core value ("if all else fails, this must work").
- **Rehandle + utilization scoring**, **loading instructions output** — plan quality, KPIs, and the human-facing artifact.
- **RFID confidence-scored evidence + zone estimate** (rule-based Bayesian) + **wrong-trailer / missed-unload detection** — the validation payoff.
- **Rolling re-optimization** (event-triggered + periodic, freeze windows) + **exception alerts** + **audit timeline** — the continuous-repair "twin" claim.
- **Simulation engine** (USA hub network, realistic + noisy events) + **realtime USA map** + **KPI dashboard** — the only data source and the demo centerpiece.

**Should have (competitive):**
- **Before/after KPI comparison** (naive baseline vs optimized) — *highest demo ROI*; the "money slide"; requires a deliberate baseline planner. Also the antidote to Pitfall 8.
- **Explainable plan reasoning** ("placed rear because unloads first; avoids 18-min rehandle") — trust + spec Risk-3 mitigation; cheap given scoring internals.
- **Scenario knobs** (inject delays, congestion, sensor noise) — lets the presenter drive the live narrative.

**Defer (v1.x / v2+):**
- RFID confidence heatmaps, on-map repair-action visualization, 2D trailer fill/load-sequence visual (v1.x).
- Human override workflow + plan editing, real WMS/TMS + RFID hardware adapters, ML sensor fusion, full what-if policy twin, full national/exact optimization, 3D packing (v2+ / spec Phase 5+). v1 UI is **read-only**; audit trail replaces the override workflow.

### Architecture Approach

A **single Node modular monolith**: simulation → in-process typed event bus → PostgreSQL append-only event store → projections (operational twin + geo/audit/KPI) → optimizer running against a scoped in-memory **planning twin** (a structural clone, no event-store writes until a plan is accepted) → Fastify API → OpenLayers web. Package boundaries point downward only (`domain` has zero deps), drawn so they could later split into services without a rewrite. See `ARCHITECTURE.md`.

**Major components:**
1. **`domain` + `event-store` + `event-bus`** — closed `DomainEvent` union; append-only `events`/`streams` tables with `UNIQUE(stream_id, version)` optimistic concurrency and a `global_seq` total order; publish→persist→fan-out with per-projection checkpoints.
2. **`projections`** — inline (decision-critical: pkg location, trailer state, hub inventory, load plan, exceptions) vs async catch-up (geo-track, audit, SLA-risk, KPIs); fully rebuildable by replay.
3. **`aggregation` / `load-planner` / `sensor-fusion`** — pure, IO-free functions (trivially unit-testable; the TDD-friendly core).
4. **`optimizer`** — owns the planning twin; layered pipeline (`aggregate → networkFlow → trailerRoute → loadPlan → crossDock → rollingRepair`) over a bounded rolling-horizon scope with freeze windows + idempotency.
5. **`simulation`** (virtual-clock event generator) + **`api`** (composition root, WS keyframe diffs) + **`web`** (OpenLayers map, client-side interpolation).

### Critical Pitfalls

The selecting lens is *"what makes the demo look good while being wrong."* See `PITFALLS.md`. (Banner Watch Out For: **the demo silently lying — inverted LIFO mapping, feasibility folded into the score, RFID treated as truth, non-deterministic replay, and no baseline to prove the optimizer actually wins.**)

1. **Inverted LIFO depth↔unload-order mapping (P1)** — a single flipped comparator yields exactly-reversed plans that still render/score/validate. Avoid: one canonical invariant asserted everywhere; an **independent** validator that recomputes blockers from placed slices; golden fixtures that flag a deliberately-reversed plan (the single most important test in the codebase). *Phase 2.*
2. **Feasibility folded into the score (P2)** — `maxAllowedBlockers` as a soft penalty lets the optimizer ship un-unloadable trailers. Avoid: a **hard feasibility gate** separate from rehandle scoring; never collapse the two into one number until the gate passes. *Phase 2, reinforced Phase 4.*
3. **Non-deterministic event replay (P3)** — `Date.now()`/`Math.random()`/unstable sort in handlers break auditability and rebuild. Avoid: projections are **pure functions of (state, event)**; replay strictly by `global_seq`; integer buckets; **CI test asserting live projection == dropped-and-rebuilt projection** from day one. *Phase 1.*
4. **Missing optimistic concurrency + non-idempotent projections (P4/P5)** — async interleaving (sim + optimizer both write) corrupts streams; at-least-once double-counts; naive RFID Bayesian rockets confidence to 0.99 on repeated reads of one tag. Avoid: `UNIQUE(aggregate_id, version)` + retry-on-conflict; per-projection last-seq idempotent folds; RFID **observation windows** (one fused observation per dwell, capped confidence). *Phase 1 (store/projections) + Phase 3 (RFID).*
5. **RFID-as-truth + no baseline (P6/P8)** — `if (observed) location = zone` makes a missed read "package vanished" and floods alerts; and with no control policy, every KPI claim is theater. Avoid: **two layers** (planned/known vs confidence-scored observed), exceptions only on disagreement above threshold, absence ≠ missing; and a **baseline planner on the same seeded stream** with "optimized vs baseline" deltas in the UI. Also: rolling-optimizer **freeze window + churn penalty + deterministic tie-break** to stop plan thrashing (P7). *Phase 3, Phase 4, and the sim/viz wrapper.*

## Implications for Roadmap

The build order falls directly out of the architecture dependency graph and maps cleanly onto spec Phases 1–4 plus a sim/viz wrapper. Build bottom-up so each layer is tested before the next depends on it; stand up a thin geo slice early to de-risk the map.

### Phase 1: Operational Data Foundation (spec Phase 1)
**Rationale:** Nothing has data without the store + bus + operational projections; this is the spec's "first business value" gate (answerable history). Determinism and concurrency must be baked in here — they are HIGH-cost to retrofit.
**Delivers:** `domain` types/events, append-only Postgres event store (optimistic concurrency + `global_seq`), in-process event bus with checkpoints, operational projections (package location, trailer state, hub inventory, audit timeline) answering "where was package X?" / "what's on trailer T?".
**Addresses:** Event-sourced operational twin + queries, audit trail (FEATURES table stakes).
**Uses:** Fastify-adjacent core, Kysely/`pg`, roll-your-own store (Emmett reference), Testcontainers.
**Avoids:** P3 (non-deterministic replay — pure-reducer + live-vs-rebuilt CI test), P4 (optimistic concurrency), P5a (idempotent projections), P11 (event `schemaVersion` discriminator).

### Phase 2: Load Planning (spec Phase 2) — the load-bearing correctness phase
**Rationale:** The LIFO planner is THE core value and the explicit "if all else fails" deliverable; the optimizer's layer 4 *calls* it, so it must exist and be proven correct first. Design the baseline planner here too (the planner already needs something to beat).
**Delivers:** Load-block aggregation, rear-to-nose slice model + route unload-order map, route-aware LIFO/partial-LIFO planner (greedy + local repair), rehandle + utilization scoring, loading instructions output, **independent LIFO validator**, and a **naive baseline planner** sharing KPI plumbing.
**Implements:** `aggregation`, `load-planner` (pure), validator.
**Avoids:** P1 (inverted mapping — independent validator + golden fixtures), P2 (hard feasibility gate ≠ score), P8-design (baseline exists from here).

### Phase 3: RFID-Assisted Validation (spec Phase 3)
**Rationale:** Detection compares *planned* vs *observed*, so it needs both a plan (Phase 2) and RFID evidence — it cannot precede either.
**Delivers:** RFID/barcode ingestion as confidence-scored evidence (rule-based Bayesian), tag→package mapping + zone estimates, wrong-trailer + missed-unload detection with severity + recommended action, exception alerts.
**Implements:** `sensor-fusion` (pure), exceptions projection.
**Avoids:** P6 (planned-vs-observed layers, missing read ≠ missing package, thresholded alerts), P5b (RFID observation windowing, capped confidence).

### Phase 4: Rolling Optimizer (spec Phase 4) — engineering risk concentrates here
**Rationale:** The optimizer re-runs and repairs; it depends on projections, aggregation, and the load-planner. This is the net-new custom-algorithm tier (min-cost flow + VRPTW) with no maintained JS libraries — the JVM→TS gap.
**Delivers:** Time-expanded hub graph + custom min-cost flow freight assignment, VRP/VRPTW route planning, rolling-horizon loop (event-triggered + periodic) with freeze windows, local repair (split/reassign/hold/over-carry) under a weighted objective, planning-twin sandbox.
**Uses:** `graphology`, `ngraph.path`, custom SSP/network-simplex + VRPTW heuristics, **glpk.js as LP oracle** for correctness tests on small instances.
**Avoids:** P7 (freeze window + churn penalty + deterministic tie-break), P9 (coarse 15-min time nodes, scope pruning), P12 (integer-scaled costs, hand-computed validation), P2-reinforced (objective can't "buy out" feasibility).

### Phase 5: Simulation + Visualization Wrapper (delivery wrapper)
**Rationale:** The sim engine is the only data source and should be built *early* (right after Phase 1 projections) to feed every later component; a thin geo api+web slice can stand up after the sim to de-risk the map. The full wrapper — scenario knobs, before/after dashboard, polished map — lands last because it composes everything.
**Delivers:** Deterministic seeded simulation engine (realistic + noisy events over a USA hub network), realtime OpenLayers/OSM map (hubs, trailers in motion, routes, SLA/freight state), read-only operator UI (load-plan view, alerts, audit timeline, KPI dashboard), **before/after KPI comparison**, explainable reasoning, scenario knobs.
**Avoids:** P8-delivery (UI shows "optimized vs baseline", seed-frozen scenarios), P10 (in-place geometry mutation, rAF batching, OL disposal on teardown, flat memory), the wall-clock/sim-clock split (Pitfall 5/clock).

### Phase Ordering Rationale
- **Store → bus → projections first** because nothing has data otherwise; it's the spec's "first value" gate and the cheapest place to enforce determinism/concurrency (retrofitting is HIGH cost — P3).
- **Simulation early (right after projections)** — it is the data source for *every* later component; build a thin geo-track projection alongside Phase 1 so the map can light up incrementally.
- **Load-planner before optimizer** — the optimizer's layer 4 calls it, and the planner alone (with the twin) is the explicit graceful-degradation deliverable.
- **Detection after planner + RFID** — exceptions are *planned vs observed* disagreements; both inputs must exist.
- **api/web last, but a thin geo-only slice early** to de-risk the OpenLayers centerpiece before the optimizer lands.
- **Baseline + before/after carried as a throughline** from Phase 2 to delivery — it's the antidote to the project's defining risk and the highest-leverage differentiator.

### Research Flags

Phases likely needing deeper research during planning (`/gsd-research-phase`):
- **Phase 4 (Rolling Optimizer):** the one genuine open question — which JS/TS approach for min-cost flow + VRPTW (pure-TS SSP vs glpk.js LP vs OR-Tools-WASM/child-process bridge). Verified that maintained native Node OR-Tools bindings do **not** exist; this is net-new code with MEDIUM confidence and the bulk of engineering risk. Gate with glpk.js correctness tests.
- **Phase 5 (Sim/Viz wrapper):** OpenLayers high-trailer-count rendering strategy + smooth client-side interpolation (WebGL points layer, in-place geometry, disposal) — verified leak/perf issues; worth a focused spike.

Phases with standard patterns (skip research-phase):
- **Phases 1–3:** well-established event-sourcing (append-only + optimistic concurrency + projections/replay) and rule-based Bayesian fusion patterns — lower research risk; the risk is correctness discipline, not unknown technology.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH (optimizer tier MEDIUM-LOW) | Versions verified on npm 2026-06-18; web/API/DB/realtime/sim/tooling well-trodden. Optimizer tier is the real gap: no maintained JS min-cost-flow/VRP libs → custom code. |
| Features | HIGH | Derived from PROJECT.md scope + tech spec §16–§24; categorization/demo-lens is opinionated synthesis (MEDIUM judgment). |
| Architecture | HIGH | Event-store + projection patterns verified against multiple Postgres event-sourcing references + Emmett; optimizer composition is straight from spec §10–11. |
| Pitfalls | HIGH on stack/tooling facts; MEDIUM-HIGH on domain-logic | OR-Tools immaturity, OL leaks, ES concurrency verified; LIFO/blocker/feasibility/baseline pitfalls derived from spec §7/§11/§12 + ES community practice. |

**Overall confidence:** HIGH for structure and build order; MEDIUM concentrated in the Phase 4 optimizer algorithms (expected and accounted for).

### Gaps to Address
- **Optimizer algorithm realization (Phase 4):** custom SSP/network-simplex min-cost flow and VRPTW heuristic are net-new with no library safety net. Handle via glpk.js LP oracle + hand-computed small-instance tests as explicit phase success criteria; OR-Tools-via-WASM or a Python child-process sidecar is a documented Phase-5 escape hatch (breaks single-language rule — last resort).
- **glpk.js / pure-JS solver performance at scale:** capability HIGH, performance unverified. Keep the demo network small (2–4 hubs per pilot realism), coarse-grain the time-expanded graph (15-min nodes), and bound rolling-horizon scope; treat solver-runtime as a KPI.
- **OpenLayers many-trailer rendering:** leak/perf risk is documented but the exact strategy (WebGL points vs in-place geometry, interpolation cadence) needs a spike during the sim/viz wrapper.
- **Baseline calibration / adversarial simulator:** the demo only proves value if scenarios are *hard enough* that LIFO sometimes can't win without over-carry/hold/reassign. Calibrate sim distributions against spec §23 pilot realism and freeze seeds per scenario — a design task, not a research one.

## Sources

### Primary (HIGH confidence)
- npm registry version verification (2026-06-18) — fastify 5.8.5, kysely 0.29.2, pg 8.22.0, @event-driven-io/emmett(-postgresql) 0.42.3, ws 8.21.0, ol 10.9.0, graphology 0.26.0, ngraph.path 1.6.1, glpk.js 5.0.0; confirmed-stale: node_or_tools (Node 4/6), min-cost-flow 2.1.0 (2022), simscript (2022).
- PostgreSQL event-sourcing patterns — eugene-khyst/postgresql-event-sourcing; "Production-Ready Event Store in PostgreSQL" (DEV); Emmett (event-driven.io) — append-only, `UNIQUE(aggregate_id, version)` optimistic concurrency, inline vs catch-up projections, replay.
- OpenLayers perf/memory-leak issues — OL #8141 / #10437 / #7954; DeepWiki OL performance — feature churn + layer/source disposal.
- OR-Tools Node immaturity — mapbox/node-or-tools (Node 4/6), OR-Tools min-cost-flow (no JS API), OR-Tools→WASM; glpk.js (jvail).
- TypeScript strict tsconfig + TS 5.9 release notes; OpenLayers marker-along-route animation + React integration examples.
- `rfid_middle_mile_trailer_optimization_tech_spec.md` §7–§13, §16–§24 — domain model, optimizer layers, twins, rolling horizon, KPIs, risks, pilot, epics.

### Secondary (MEDIUM confidence)
- Fastify vs NestJS positioning (encore.dev, pkgpulse); Prisma/Drizzle/Kysely ORM comparisons — query-builder fit for projection-heavy workloads.
- Demo-credibility lens, before/after-comparison emphasis, feature categorization — opinionated synthesis for this sim-driven demo (judgment, not external sources).
- Domain-logic pitfalls (LIFO mapping, blocker boundaries, feasibility gate, freeze windows, baseline, sensor fusion independence) — derived from spec §7/§8/§11/§12/§22/§23 cross-referenced with event-sourcing community practice.

### Tertiary (LOW confidence — needs validation during implementation)
- glpk.js / pure-JS min-cost-flow performance at the project's graph scale — capability documented, throughput unverified; validate with a Phase-4 spike.
- OpenLayers smooth interpolation strategy at high trailer counts — needs a rendering spike in the sim/viz wrapper.

---
*Research completed: 2026-06-18*
*Ready for roadmap: yes*
