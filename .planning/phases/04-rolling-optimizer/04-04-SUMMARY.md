# 04-04 SUMMARY — VRPTW trailer routing (OPT-03)

**Plan:** 04-04 (Wave 2) · **Requirement:** OPT-03 · **Branch:** `wt/p4-04-r1`

## What was built

A pure-TS VRPTW pipeline in `@mm/optimizer/src/vrptw/`:

- `types.ts` — the strong-typed contract: `Stop`, `TravelModel`, `RoutedStop`,
  `TrailerRoute`, `CandidateRoute`. No `any`; integer-minute model; feasibility a
  separate flag from cost (anti-P2).
- `feasibility.ts` — the SHARED pure predicates (the REFACTOR target, DRY):
  `feasibleArrivals` (window check + arrival/departure ETA derivation, returns
  `null` on a window violation), `routeCost` (travel-minutes objective),
  `totalDemand` (capacity hard-check input). Used by BOTH construction and local
  search so window/cost logic is single-sourced.
- `construct.ts` — `constructRoutes`: cheapest-insertion. Greedily inserts each
  stop at the position minimizing added travel cost while keeping every window +
  capacity feasible; an insertion arriving after `windowEndMin`, or pushing demand
  over capacity, is REJECTED; unfittable stops go to `unplaced` and `feasible`
  becomes `false`. Deterministic (stops processed by `hubId` lexicographically;
  tie → earlier position).
- `local-search.ts` — `localSearch`: 2-opt (segment reverse) + or-opt (relocate
  chains of length 1–3). First-improvement, deterministic scan order. A move is
  accepted ONLY if feasible (shared predicate) AND strictly cost-reducing →
  monotonically non-worsening, never introduces a window/capacity violation,
  terminates (strictly decreasing integer objective bounded by 0).
- `route-trailers.ts` — `routeTrailers`: construct → localSearch → derive ETAs +
  utilization (`demand/capacity`) → GATE the trailer load through the REUSED
  Phase-2 `validatePlan`/`isFeasible`. The load is built LIFO-correctly (k-th stop
  → block at depth k) and the validator re-derives unload order independently, so
  the gate is a genuine cross-check. NO LIFO/blocker logic in the optimizer.
- `index.ts` — the vrptw barrel (the root re-exports it; root untouched).

## Discipline

- **Strict TDD:** RED → GREEN → REFACTOR per task; failing tests committed first
  (`test(04-04): …`) then minimal impl (`feat(04-04): …`).
- **DRY:** feasibility reused from `@mm/load-planner` (`validatePlan`/`isFeasible`)
  — no LIFO reimplementation. Grep gate clean:
  `! grep -rnE "isBlocker|countBlockers|canonicalInvariant" packages/optimizer/src/vrptw/`.
- **anti-P2:** window feasibility, capacity, and the LIFO HARD gate are checked
  FIRST and kept distinct from the travel-cost objective.
- **Determinism (anti-P3):** no `Date.now`/`Math.random` in executable src;
  lexicographic tie-breaks; integer-minute arithmetic; identical input ⇒ identical
  route + ETAs + utilization (asserted). `glpk.js` stays a test-only devDependency.

## Tests (17 in vrptw; full suite 396)

- construct: feasible 3-stop, line-ordering, window-violating insertion rejected,
  capacity respected, deterministic tie-break.
- local-search: uncrosses a 2-opt-able route, leaves optimal routes unchanged,
  **seeded property sweep (60 fixtures)** asserting never-worsens + never-violates
  + permutation-preserving, rejects a tight-window-breaking move, deterministic.
- routeTrailers: ETA consistency, utilization, waiting window, LIFO-correct load
  passes the reused HARD gate, window-infeasible ⇒ `feasible:false`, a deliberately
  un-unloadable load FAILS the reused gate, deterministic.

## Gates (all GREEN)

`pnpm install` ✓ · `pnpm build` (turbo) ✓ · `pnpm -r build` ✓ · `pnpm lint` ✓ ·
`pnpm test:all` ✓ (50 files / 396 tests, integration on shared Postgres via
`MM_PG_URL`).
