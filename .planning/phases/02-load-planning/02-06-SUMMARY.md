# Plan 02-06 Summary — API POST /plan (rival 2)

**Status:** COMPLETE — all gates green. Requirement LOAD-08.

## What shipped

One thin, read-only `@mm/api` endpoint — `POST /plan` — that turns the PURE Phase-2 planner
into a thing an operator can call and eyeball. Built strict TDD (RED → GREEN → REFACTOR): the
`app.inject()` integration test (5 cases) was written first and failed (404, route unregistered)
before the route existed.

| Must-have | Where | Proof |
|-----------|-------|-------|
| Operator POSTs packages + route → feasible, scored, explained plan + baseline | `src/routes/plan.ts` (`registerPlanRoutes`) | `POST /plan` returns `{ plan, baseline, instructions, validation, scores, explanation, feasible }` |
| Endpoint runs `aggregate → planLoad + baselinePlan → validatePlan → scorePlan → instructions → planExplanation` on the SAME inputs | `src/routes/plan.ts` handler | one pure pipeline; `grep` shows `aggregate`, `planLoad`, `validatePlan`, `scorePlan` wired |
| Response GATES on feasibility (P2 at the boundary) | `src/routes/plan.ts` (`gateAndScore`) | `feasible = isFeasible(validation)`; score computed + reported but never folded into the verdict; `FeasibilityResult` and `ScoreResult` stay distinct objects to the wire |
| Zone-ordered loading instructions + plan explanation | `src/routes/plan.ts` | `instructions(plan, blocks)` (nose→rear zones) + `planExplanation(...)` returned |
| Body-validated, malformed → 400 | `src/routes/plan.ts` (`parseBody`) | domain zod schemas (`planningPackageSchema`/`routeStopSchema`/`plannerConfigSchema`) parse the untrusted body; failure → 400 |
| Read-only (no Phase-4 persistence) | `src/routes/plan.ts` | `grep` for `appendToStream`/`insertInto`/`insert(` in the route is empty |
| GET /hubs + prior endpoints green | `test/plan.test.ts` + `test:all` | regression case asserts `/health` 200 and `/hubs` registered (not 404); full suite 309 passed |

## Design (KISS / YAGNI / DIP — smallest correct surface)

- **`registerPlanRoutes(app)`** — a pure, DB-free route. It needs no `db` arg (the pipeline runs
  entirely from the request body), so it wires into BOTH the walking-skeleton `buildApp(db)` and
  the full `buildServer(deps)`. `app.inject()` exercises it with a stub Kysely handle — no
  Testcontainer needed for this endpoint.
- **One shared gate (P2 + P8).** `gateAndScore(plan, blocks, route, config)` runs `validatePlan` +
  `scorePlan` and derives `feasible = isFeasible(validation)`. BOTH the recommended (route-aware)
  plan AND the FIFO `baseline` flow through this ONE helper, so they are validated, scored, and
  gated identically — the before/after comparison is honest and the strawman's HARD-infeasibility
  is reported with its score intact.
- **Body validation reuses the domain schemas (DRY).** No re-declared field rules; a partial
  `config` is merged over `DEFAULT_PLANNER_CONFIG` (only defined keys override, honoring
  `exactOptionalPropertyTypes`). A non-object body fails closed.
- **DTO shape.** Top-level `{ plan, baseline, instructions, validation, scores, explanation,
  feasible }` describes the RECOMMENDED plan; `baseline` is a nested `ScoredPlanDto`
  `{ plan, validation, scores, feasible }` — the strawman the optimizer beats.

## Anti-pitfall posture (P1 / P2)

- **Anti-P1 (inverted LIFO):** the route states no LIFO invariant of its own and defines no second
  blocker predicate — it composes the pure modules, which single-source the canonical invariant
  in `lifo-invariant.ts`.
- **Anti-P2 (feasibility folded into score) — HELD AT THE BOUNDARY:** `feasible` is
  `isFeasible(validation)` and NOTHING else. The score is exposed alongside but never overrides the
  verdict; `FeasibilityResult` (`{hardViolations, softViolations}`) and `ScoreResult`
  (`{rehandleScore, utilizationScore}`) are distinct objects all the way to the JSON response. The
  infeasible-gating test proves it: the FIFO baseline returns `feasible: false` with non-empty
  `hardViolations` WHILE still carrying its `ScoreResult` — feasibility reported independently of,
  and never bought out by, the score.

### A note on the infeasible-gating scenario

The route-aware optimizer (`planLoad`) is LIFO-feasible BY CONSTRUCTION (it places blocks in
descending unload-order from the nose, so depth is monotone in unload-order and it can never
manufacture a blocker — verified empirically across tight-capacity and reversed-route configs).
The demonstrable infeasible plan at the API is therefore the LIFO-blind FIFO `baseline`, which
buries early-unload freight at the nose and trips HARD blockers. The gating test asserts on
`baseline.feasible === false` + non-empty `baseline.validation.hardViolations` with
`baseline.scores` still present — the honest way to exercise the P2 gate end-to-end through the
real pipeline.

## Files

- `packages/api/src/routes/plan.ts` — `registerPlanRoutes`, DTOs `PlanResponseDto` / `ScoredPlanDto`
- `packages/api/src/app.ts` — `POST /plan` registered in the walking-skeleton factory
- `packages/api/src/server.ts` — `POST /plan` registered in the full composition root
- `packages/api/src/index.ts` — barrel exports for `registerPlanRoutes` + DTO types
- `packages/api/package.json` — added `@mm/aggregation` + `@mm/load-planner` workspace deps
- `packages/api/tsconfig.json` — added project references for the two new deps
- `packages/api/test/plan.test.ts` — 5 `app.inject()` cases (happy, P2 infeasible gating, 2× bad input, no-regression)

## Gates (run from the worktree)

- `pnpm install` — OK
- `pnpm -r build` — OK (all packages, `tsc -b` clean)
- `pnpm lint` — OK (root eslint, zero warnings; no `any`)
- `pnpm test:all` — OK — **309 passed** (was 304; +5 from `plan.test.ts`), 40 files, incl. the
  real-Postgres Testcontainers integration suite on the OrbStack docker context. No prior test
  regressed; the FND query/ws/audit suites and the `@mm/load-planner` / `@mm/aggregation` unit
  suites stayed green.
