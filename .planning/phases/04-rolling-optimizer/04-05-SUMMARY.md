# 04-05 Summary — Objective + feasibility-gate + local repair (OPT-07, OPT-08)

**Branch:** `wt/p4-05-r1` (rival #1) · off `feature/phase-4-rolling-optimizer`

## What shipped

ONE weighted §12 objective that RANKS candidate plans, a feasibility **hard-gate**
plan selector, and a local-repair recommender — all PURE and deterministic in
`@mm/optimizer` (`objective/` + `repair/`).

### OPT-08 — Weighted objective + feasibility-gated selection
- `objective(metrics, weights)` (`src/objective/objective.ts`): a pure weighted
  sum of every §12 term — miles + driverTime + fuel + dockWait + handling +
  rehandle + SLA-lateness + low/high-utilization + over-carry + imbalance + churn.
  Lower = better. **Takes NO feasibility argument** (anti-P2: there is no seam to
  discount a HARD violation). The §12.1 utilization penalty is the two-sided
  quadratic band single-sourced from the planner config edges (`UTIL_BAND` =
  `DEFAULT_PLANNER_CONFIG.utilLow/utilHigh`), exactly 0 inside the band.
- `objectiveBreakdown` (REFACTOR): per-term contributions whose `total` equals the
  scalar `objective` — explainability that can never diverge.
- **KEYSTONE** `selectPlan(candidates, weights)` (`src/objective/select-plan.ts`):
  filters to `isFeasible(c.feasibility)` (the REUSED Phase-2 `validatePlan` HARD
  gate) **FIRST**, then picks the minimum objective with a deterministic `planId`
  lexicographic tie-break (anti-P7 thrash); returns `null` when none feasible. A
  cheap-but-infeasible candidate is rejected regardless of its low score —
  objective and feasibility are observed as two SEPARATE fields on `Candidate`,
  never collapsed (threat T-04-10 mitigated).
- DEFAULT weights in `src/objective/weights.ts` (rehandle/SLA/util/churn outweigh
  linear travel so a clean plan never loses to a re-handling one).

### OPT-07 — Local repair
- `localRepair(scope)` (`src/repair/local-repair.ts`): generates split / reassign /
  hold / over-carry variants of an infeasible/high-cost plan, **GATES each through
  the REUSED `validatePlan` HARD gate** (feasibility decides survival before the
  objective ranks — anti-P2), ranks the feasible survivors best-first by the §12
  `objective` with deterministic `(objective, kind, rationale)` tie-breaks, and
  attaches a non-empty §17.4 human-readable `rationale` to each (threat T-04-11
  mitigated). Returns `[]` only when no repair makes the plan feasible.

## Discipline / DRY
- REUSES Phase-2 `@mm/load-planner` `isFeasible`/`validatePlan` (HARD gate) and
  `scorePlan` numbers feed the objective's `rehandleScore`/`utilization` — **no
  LIFO/blocker logic re-implemented** in the optimizer.
- No `any`; no `Date.now()`/`Math.random()` in `@mm/optimizer/src` (determinism);
  `glpk.js` stays a TEST-only devDependency (never imported from `src`).
- Strict TDD: RED (failing tests) → GREEN (minimal impl) → REFACTOR (breakdown
  helper). Barrels (`objective/index.ts`, `repair/index.ts`) filled; root barrel
  untouched.

## Gates (run with `MM_PG_URL=postgres://mm:mm@localhost:5432/postgres`)
- `pnpm install` — OK
- `pnpm build` (turbo) — OK (9/9)
- `pnpm -r build` — OK
- `pnpm lint` — OK (no `any`, type-checked flat config)
- `pnpm test:all` — **415 passed (53 files)**, including the 19 new
  objective/repair tests and all prior tests GREEN (Postgres-backed integration
  suites green against the shared server, per-run isolated db).

## Requirements covered
- **OPT-07** (local repair: split/reassign/hold/over-carry with rationale, ranked
  best-feasible-by-objective) — covered.
- **OPT-08** (ONE weighted objective ranks candidates; feasibility hard-gate kept
  distinct and checked first) — covered, with the keystone test.
