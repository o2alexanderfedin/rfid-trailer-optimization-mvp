# Phase 4: Rolling Optimizer - Context

**Gathered:** 2026-06-19
**Status:** Ready for planning
**Note:** Decisions auto-made from the Google AI Mode consult + tech spec §10-§12 + STACK.md/ARCHITECTURE.md (research-backed; overridable). This is the milestone's engineering-risk concentration.

<domain>
## Phase Boundary

Continuously re-optimize hub-to-hub freight flow over a rolling horizon: build a time-expanded hub-network
graph, assign freight to route legs via min-cost flow, route trailers under time windows (VRPTW), evaluate
candidate plans on a sandboxed planning twin with no operational side effects, honor freeze windows +
idempotency, and produce local-repair recovery recommendations — all ranked by ONE weighted objective with
feasibility (the Phase-2 LIFO validator) kept a hard gate, never folded into the score.

**In scope (requirements):** OPT-01 (time-expanded graph), OPT-02 (min-cost flow freight assignment),
OPT-03 (VRP/VRPTW trailer routing), OPT-04 (planning-twin sandbox), OPT-05 (rolling-horizon scoped re-opt),
OPT-06 (freeze windows + idempotency), OPT-07 (local repair: split/reassign/hold/over-carry), OPT-08
(weighted-objective plan selection).

**Out of scope (later/never):** exact MILP/OR-Tools (too heavy — escape hatch only); ML; the demo UI /
before-after dashboard / scenario knobs (Phase 5). Builds ON: Phase-1 twin/event-store, Phase-2
load-planner (feasibility + scoring), Phase-3 exceptions are NOT required (P4 ⟂ P3).
</domain>

<decisions>
## Implementation Decisions (research-backed)

### Algorithms (Google AI Mode consult 2026-06-19 — see 04-RESEARCH.md)
- **OPT-02 Min-cost flow:** pure-TS **Successive Shortest Path** (residual graph; Bellman-Ford for the first potentials then Dijkstra-with-potentials). Exact, zero runtime dep. **Validated against `glpk.js` (WASM) as a TEST-ONLY correctness oracle** on small instances (the research-flagged oracle). glpk.js is a devDependency, never a runtime dep.
- **OPT-03 VRPTW:** do NOT force routing through min-cost flow (NP-hard → state explosion) and do NOT use glpk MILP (chokes >15-20 nodes). Use a pure-TS **construction heuristic (cheapest-insertion / savings)** + **local search (2-opt / or-opt)** honoring time windows + capacity. OR-Tools stays a documented Phase-5+ escape hatch only.
- **OPT-01 Time-expanded graph:** hub@time nodes; edges = trip / wait / cross-dock / load / unload / hold (spec §11.2). Built from the network + schedule for the scoped horizon.

### Optimization loop & safety
- **OPT-04 Planning twin:** an in-memory `structuredClone` sandbox of ONLY the affected hubs/trailers/blocks (per ARCHITECTURE.md). The optimizer mutates the twin freely; ZERO operational side effects until a plan is accepted, at which point ONE `PlanAccepted` event is emitted (the only side effect).
- **OPT-05 Rolling horizon:** hybrid trigger — periodic (every 5-15 min of sim time) AND event-driven; each epoch is SCOPED to affected hubs/trailers/blocks via `detectAffectedScope(events)`, not the whole network.
- **OPT-06 Freeze windows + idempotency:** never modify plans for trailers departing within the freeze window (10-15 min) unless critical; each epoch is idempotent keyed by `(epochId, scopeHash)` — identical input ⇒ identical plan (no thrashing; anti-P7 from PITFALLS).
- **OPT-07 Local repair:** when a candidate is infeasible (HARD via the Phase-2 validator) or high-cost, generate recovery recommendations — split / reassign / hold / over-carry — each with a human-readable rationale (spec §11.7, §17.4).
- **OPT-08 Weighted objective (spec §12):** ONE objective ranks candidate plans = miles + driverTime + fuel + dockWait + handling + rehandle + SLA-lateness + low/high-utilization + over-carry + imbalance penalties (weights in config). **Feasibility (Phase-2 `validatePlan` HARD gate) is checked FIRST and is NEVER folded into the objective** (the P2 separation, carried from Phase 2).

### Architecture
- New package **`@mm/optimizer`** (pure algorithmic core: graph, min-cost-flow SSP, VRPTW heuristic+local-search, objective, repair — all deterministic, import only @mm/domain + @mm/load-planner for feasibility/scoring). A thin **rolling service** (in `@mm/api` or a `@mm/optimizer` service entry) runs the epoch loop over the twin and emits plan events.
- New domain events (closed union + contract.assert): `PlanGenerated`, `PlanAccepted` (+ the recovery actions surfaced as part of a plan, not necessarily separate events). Adding union members updates contract.assert — expected.
- **Determinism:** optimizer is deterministic given inputs + a seed; epoch clock comes from sim/event time, never `Date.now()`; no unseeded `Math.random()` in src. glpk.js used only in tests.
- **Single shared Postgres:** integration tests run via the `MM_PG_URL` per-run-database fixture mode (one container).

### Testing keystones
- **glpk.js oracle:** the SSP min-cost-flow result equals glpk.js's exact LP optimum on a battery of small random instances (the correctness oracle) + hand-computed fixtures.
- **Feasibility hard-gate (P2 carried):** an infeasible candidate is rejected regardless of a low objective score; objective and feasibility are distinct outputs.
- **Idempotency (OPT-06):** identical (epoch, scope) input ⇒ byte-identical plan; freeze-window trailers are untouched.
- **VRPTW correctness:** routes honor time windows + capacity; a window-violating route is rejected.
- **Twin sandbox (OPT-04):** running the optimizer emits NO events / mutates NO projections until accept.
</decisions>

<code_context>
## Existing Code Insights
- `@mm/load-planner` — the Phase-2 `validatePlan` (HARD/SOFT feasibility, source-guarded independent validator) + `scorePlan` (rehandle/utilization) are REUSED: feasibility hard-gates optimizer candidates; scoring feeds the objective.
- `@mm/event-store` / `@mm/projections` — the twin (load blocks, trailers, routes, hub state) is the optimizer input; accepted plans append events.
- `@mm/domain` — entities + closed event union (extend with plan-lifecycle events + contract.assert).
- `@mm/simulation` — drives the demo stream + the rolling-epoch clock.
- Conventions: pnpm+Turborepo, strict TS (no any), Vitest, downward-only deps, determinism, gates include turbo `pnpm build`; integration via `MM_PG_URL` shared-PG fixture.
</code_context>

<specifics>
## Specific Ideas
- glpk.js is a TEST oracle ONLY — never a runtime dependency (keeps the single-language, lightweight constraint).
- Reuse the Phase-2 feasibility/scoring as the single source — do NOT re-implement LIFO feasibility in the optimizer (DRY + the P1/P2 invariants stay single-source).
- Keep the optimizer core pure + deterministic; the rolling loop (clock, triggers, persistence) is the only stateful shell.
</specifics>

<deferred>
## Deferred Ideas
- Exact MILP / OR-Tools (Phase-5+ escape hatch only if heuristic quality proves insufficient at scale).
- Scenario knobs / before-after dashboard / animation → Phase 5.
- ALNS/tabu/advanced metaheuristics, forecasting, simulation twin → spec Phase 5 (post-MVP).
</deferred>
