# Plan 04-03 Summary — Min-cost flow (SSP) + glpk.js oracle (OPT-02)

## What shipped
A pure-TS **Successive Shortest Path** min-cost-flow solver and the **glpk.js
exact-LP correctness oracle** (the Phase-4 keystone), plus `assignFreight` mapping
freight blocks to route legs over the Plan-02 time-expanded graph.

### Files
- `packages/optimizer/src/flow/types.ts` — `Supply`, `FlowResult` contracts.
- `packages/optimizer/src/flow/min-cost-flow.ts` — `minCostFlow(graph, supplies)`:
  residual graph with paired reverse arcs, **Bellman-Ford** initial potentials then
  **Dijkstra-with-potentials**, super-source/super-sink, integer arithmetic only.
  Self-loop edges (`from === to`, e.g. in-place handling) are skipped — they carry
  no flow and would corrupt the paired-arc indexing.
- `packages/optimizer/src/flow/min-cost-flow.test.ts` — diamond hand-fixture (cost
  9), parallel-path, infeasibility, conservation, determinism, multi-source/sink.
- `packages/optimizer/src/flow/glpk-oracle.test.ts` — **KEYSTONE**: SSP optimum ==
  glpk.js exact LP optimum on 60 seeded random instances (4 seeds × 15) + the hand
  fixtures + a capacity-starved infeasible instance. Integer equality, no tolerance.
- `packages/optimizer/src/flow/assign-freight.ts` — `assignFreight`: runs
  `minCostFlow`, decomposes the optimal flow into per-block source→sink leg paths.
- `packages/optimizer/src/flow/assign-freight.test.ts` — single/multi-block,
  cost == optimum, capacity respect, infeasible ⇒ `[]`, real Plan-02 graph.
- `packages/optimizer/src/flow/index.ts` — barrel exports `minCostFlow`,
  `assignFreight`, `FreightAssignment`, `Supply`, `FlowResult`.

## Discipline honored
- **Strict TDD**: RED (failing tests) → GREEN (minimal impl) → REFACTOR per task.
- **anti-P12**: integer costs/capacities/supplies end-to-end; the glpk oracle agrees
  to the unit (no float drift).
- **anti-P2**: `feasible` is a separate `FlowResult` output, checked first, never
  folded into `totalCost`; oracle asserts feasibility agreement independently.
- **anti-P3 determinism**: no `Date.now()` / `Math.random()` in `src`; dense
  Dijkstra selection + id-sorted decomposition replay identically.
- **DRY/KISS/YAGNI/DIP**: smallest correct API (two pure functions), the residual
  engine is a private `ResidualGraph` helper; reuses Plan-02 `TimeExpandedGraph`.
- **glpk.js**: TEST-only devDependency; imported ONLY in `glpk-oracle.test.ts`,
  never in production `src`.

## Gates (run with MM_PG_URL set)
- `pnpm install` — ok.
- `pnpm build` (turbo) — 9/9 successful.
- `pnpm -r build` — ok.
- `pnpm lint` — clean.
- Unit tests — **342/342 pass** (44 in `@mm/optimizer`, incl. 16 flow + keystone).
- Integration tests — pass in isolation / when the shared Postgres is stable
  (event-store, api, simulation, projections all green). The full `test:all` run was
  intermittently red ONLY because the concurrent Phase-3 worktree repeatedly tears
  down the shared `mm-postgres` container mid-run (verified: container removed 3×).
  Failures are exclusively `ECONNREFUSED` / `CREATE DATABASE` connectivity, never in
  optimizer code, which touches no DB.
