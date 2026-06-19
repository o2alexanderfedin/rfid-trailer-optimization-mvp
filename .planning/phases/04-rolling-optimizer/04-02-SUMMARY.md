# Plan 04-02 Summary — Optimizer scaffold + time-expanded graph (OPT-01)

**Status:** Complete · **Requirement:** OPT-01 · **Branch:** `wt/p4-02-r1`

## What shipped

A new PURE package **`@mm/optimizer`** (imports only `@mm/domain` + `@mm/load-planner`;
`glpk.js` is a TEST-ONLY devDependency, never a runtime dep) with:

- **The Wave-2 consumer contract** (`src/graph/types.ts`): `EdgeKind`,
  `FlowNode`, `FlowEdge`, `TimeExpandedGraph`, `OptimizerScope`, plus the input
  shapes (`OptimizerNetwork` / `OptimizerRoute` / `OptimizerSchedule` /
  `ScheduledTrip`) and integer `GraphConfig` + `DEFAULT_GRAPH_CONFIG`. This is the
  stable interface Plan 03's min-cost flow builds against.
- **`buildTimeExpandedGraph(network, schedule, scope, cfg?)`**
  (`src/graph/time-expanded.ts`): hub@time nodes over the scoped horizon +
  the six §11.2 edge kinds — `trip` (scheduled linehaul `A@t → B@(t+travel)`),
  `wait` / `hold` (same-hub self-progress across a timestep), `load` / `unload` /
  `crossDock` (in-place handling self-edges). INTEGER costs + capacities
  (anti-P12); every edge respects time windows (`head.timeMin >= tail.timeMin`);
  nodes + edges sorted by stable id ⇒ byte-identical replay (anti-P3).
- **The barrel convention**: per-subdirectory barrels (`graph`, `flow`, `vrptw`,
  `objective`, `repair`, `rolling`) with empty-but-valid placeholders; the root
  `src/index.ts` re-exports ONLY the barrels so each later plan fills its own
  without touching the root (no concurrent-edit conflicts).
- **glpk.js oracle pre-wiring** (`src/graph/glpk-oracle.test.ts`): proves the
  test-only WASM LP solver loads, solves a hand-computed min-cost-flow LP to its
  known optimum, and that an OPT-01 graph edge's integer cost feeds cleanly into
  a GLPK objective — the exact-optimum oracle Plan 03's SSP solver is validated
  against.

## Engineering discipline

- **Strict TDD**: RED (11 failing graph tests) → GREEN (full builder) → tests
  committed separately. 28 optimizer tests, all green.
- **Anti-P9** (graph explosion): coarse 15-min timestep nodes, scope-bounded
  horizon; node count bounded by hubs × timesteps.
- **Anti-P12** (numerical drift): all costs/capacities clamped to non-negative
  integers at the graph boundary; the glpk oracle agrees to the unit.
- **Anti-P3** (determinism): no `Date.now()` / `Math.random()` in `src`; times
  come from caller-supplied sim/event minutes; nodes + edges sorted by id.
- **DRY**: the graph is the substrate; feasibility (`validatePlan`) + scoring
  (`scorePlan`) are reused from `@mm/load-planner` by the Wave-2 plans, never
  re-implemented here.

## Gates (all green)

`pnpm install` · turbo `pnpm build` (9/9) · `pnpm -r build` · `pnpm lint`
(`eslint .`) · `pnpm test:all` (363 tests / 44 files, unit + integration on the
shared Postgres). glpk.js asserted devDependency-only.

## Files

- `packages/optimizer/package.json`, `tsconfig.json`
- `packages/optimizer/src/index.ts` (root barrel)
- `packages/optimizer/src/graph/{index,types,time-expanded}.ts`
- `packages/optimizer/src/graph/{time-expanded,glpk-oracle}.test.ts`
- `packages/optimizer/src/{flow,vrptw,objective,repair,rolling}/index.ts` (placeholders)
- `tsconfig.eslint.json` (added `@mm/optimizer` path mapping)
