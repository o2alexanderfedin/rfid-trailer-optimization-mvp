# Phase 4 Research: Rolling Optimizer

**Researched:** 2026-06-19
**Phase:** 4 — Rolling Optimizer
**Requirements:** OPT-01..08
**Sources:** tech spec §10-§12 (planning layers, algorithms, objective), STACK.md/ARCHITECTURE.md, PITFALLS (P7 thrashing, P2 feasibility-folded-into-score), and a **Google AI Mode browser consult** (mandatory) on min-cost flow + VRPTW in TS — resolves the flagged STATE blocker.

---

## Google AI Mode Consult (2026-06-19)

Query: min-cost flow + VRPTW in TS — pure-TS SSP vs glpk.js WASM vs OR-Tools; best approach + correctness oracle + performance. Decisive answer:

| | Pure TS (Successive Shortest Path) | glpk.js (WASM LP/MIP) | OR-Tools (WASM/native) |
|---|---|---|---|
| Use case | **Pure min-cost flow** | small MIP | large-scale VRPTW & MCF |
| VRPTW viability | extremely poor (state explosion) | poor (exponential >15-20 nodes) | excellent (industry std) |
| Correctness oracle | accurate for network flow | **exact optimum** | exact/near-optimal |
| Bundle/overhead | minimal | ~1-2 MB WASM | heavy WASM/native binding |

**Decisions:**
- **Min-cost flow (OPT-02):** pure-TS **Successive Shortest Path** — residual graph, push flow along successive shortest paths via Bellman-Ford (initial potentials) then Dijkstra-with-potentials. Exact, zero-dep, debuggable. Validate against **glpk.js exact LP as a TEST oracle**.
- **VRPTW (OPT-03):** NOT min-cost flow (NP-hard temporal constraints), NOT glpk MILP (exponential, chokes >15-20 nodes), NOT OR-Tools (too heavy, breaks single-language). → pure-TS **construction heuristic (cheapest-insertion / savings) + local search (2-opt / or-opt)**.
- Consult gave an SSP code blueprint (Edge{to,capacity,flow,cost,rev}; addEdge with reverse edge; push flow on residual shortest paths).

---

## Implementation Guidance

### `@mm/optimizer` (pure, deterministic; import @mm/domain + @mm/load-planner)
- **OPT-01 `buildTimeExpandedGraph(network, schedule, scope)`** → hub@time nodes + edges {trip, wait, cross-dock, load, unload, hold} with capacities + costs + time windows (spec §11.2).
- **OPT-02 `minCostFlow(graph, supplies)`** → SSP: `class MinCostFlowSSP` with residual edges + reverse edges; Bellman-Ford/Dijkstra+potentials; returns flow per edge minimizing transport + waiting + handling + SLA-lateness + missed-connection cost under edge/hub capacity + time windows. Tested against glpk.js.
- **OPT-03 `routeTrailers(stops, windows, capacities)`** → VRPTW: cheapest-insertion construction → 2-opt/or-opt local search; returns stop sequence + departure/arrival ETAs + utilization estimate; respects time windows + capacity; **trailer loads still pass the Phase-2 `validatePlan` HARD gate**.
- **OPT-08 `objective(plan, weights)`** (spec §12) → single weighted cost: miles + driverTime + fuel + dockWait + handling + rehandle + SLA-lateness + low/high-util + over-carry + imbalance + damage-risk. **Feasibility checked separately FIRST (Phase-2 validator); never folded in.**
- **OPT-07 `localRepair(plan, scope)`** → ordered repair attempts: split / reassign / hold / over-carry; each returns a candidate + a rationale; pick the best feasible one by the objective.

### Rolling loop (stateful shell — the only non-pure part)
- **OPT-04 planning twin:** `structuredClone` of the affected scope; optimizer mutates the clone; acceptance emits ONE `PlanAccepted` event (only side effect). No projection writes during evaluation.
- **OPT-05 rolling horizon:** `every epoch: events=readNew(); updateTwin(); scope=detectAffected(events); input=buildInput(scope); candidate=optimize(input); validated=validateAndRepair(candidate); if better & feasible: publish`. Periodic (5-15 min sim time) + event-triggered. Scoped, not global.
- **OPT-06 freeze + idempotency:** skip trailers departing within the freeze window (10-15 min); memoize per `(epochId, scopeHash)` so identical input ⇒ identical plan (anti-thrash, P7). Epoch clock from sim/event time, never `Date.now()`.

### Domain + integration
- New events `PlanGenerated`, `PlanAccepted` in the closed union + zod + contract.assert.
- A rolling service in `@mm/api` (or `@mm/optimizer` entry) runs the loop on a demo stream; expose recommendations + plan + objective breakdown via an endpoint. Single shared Postgres for integration tests (`MM_PG_URL`).

---

## Validation Architecture

### Keystone — glpk.js correctness oracle (OPT-02)
- Generate N random small min-cost-flow instances; assert the pure-TS SSP optimal cost EQUALS glpk.js's exact LP optimum (within integer tolerance). Plus hand-computed fixtures for known graphs. This gates the hardest algorithm against an independent exact solver.

### Feasibility-hard-gate (OPT-08, P2 carried)
- An infeasible candidate (Phase-2 `validatePlan` HARD) is rejected regardless of a low objective; `objective()` and feasibility are distinct outputs and never collapsed.

### VRPTW correctness (OPT-03)
- Routes honor time windows + capacity on fixtures; a window-violating insertion is rejected; local search never worsens a feasible route's objective.

### Twin sandbox (OPT-04)
- Running the optimizer over a twin emits NO events and mutates NO projection until `accept`; assert event-store + projections unchanged during evaluation (integration test on the shared PG).

### Rolling-horizon idempotency + freeze (OPT-05/06)
- Identical `(epoch, scope)` input ⇒ byte-identical plan (no `Date.now`/`Math.random`). Trailers inside the freeze window are untouched across epochs. Scope detection limits work to affected hubs/trailers.

### Local repair (OPT-07)
- An infeasible plan yields at least one feasible split/reassign/hold/over-carry recommendation with a rationale; the chosen repair is the best feasible by objective.

### Determinism / purity
- `@mm/optimizer` core imports only @mm/domain + @mm/load-planner; no `Date.now`/`Math.random` in src; same input ⇒ same output. glpk.js is a devDependency only. Gates include turbo `pnpm build`.

---

## Pitfalls Carried Into Plans
- **P7 plan thrashing** → freeze windows + `(epoch, scopeHash)` idempotency + a churn/stability penalty in the objective.
- **P2 feasibility folded into score** → feasibility (Phase-2 HARD validator) checked first, distinct from the weighted objective.
- **Optimizer intractability (spec Risk-2)** → decompose (graph → MCF → VRPTW → repair), scope to affected hubs/trailers, heuristics + glpk oracle only for small subproblems/benchmarks. NOT exact whole-network MILP.
- **Numerical issues in JS min-cost flow** → integer costs/capacities where possible; glpk oracle catches drift.

---
*Phase 4 research — incorporates mandatory Google AI Mode consult on min-cost flow + VRPTW in TS.*
