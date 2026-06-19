# Plan 02-04 Summary — Planner + independent validator + keystone (rival 2)

**Status:** COMPLETE — all gates green. Requirements LOAD-03, LOAD-04, LOAD-05.

## What shipped

Extended the PURE `@mm/load-planner` package (depends on `@mm/domain` ONLY) with the
load-bearing correctness core of Phase 2, built strict TDD (RED → GREEN → REFACTOR):

| Requirement / must-have | Where | Proof |
|-------------------------|-------|-------|
| LOAD-03 greedy route-aware planner | `src/plan-load.ts` (`planLoad`) | sorts blocks by `unloadOrder` DESC (id tie-break), places nose→rear honoring per-slice volume/weight capacity; output satisfies `canonicalInvariantHolds` on clean input with zero blockers |
| LOAD-04 INDEPENDENT validator (virtual unload sim) | `src/validator.ts` (`validatePlan`, `isFeasible`) | recomputes blockers PURELY from `plan.slices` (depth + loadBlockIds) via the canonical `isBlocker`; ignores `plan.placements`; imports only `lifo-invariant`/`types`/`@mm/domain` |
| LOAD-05 partial-LIFO | `src/plan-load.ts` | bounded-blocker layouts are NOT rejected (the planner emits a plan; rehandle cost is a later plan); `validatePlan` marks 1..max as SOFT, not HARD |
| HARD/SOFT gate (anti-P2) | `src/validator.ts` | `blockerCount > maxAllowedBlockers ⇒ HARD`; `1..max ⇒ SOFT`; `0 ⇒ none`; returns `FeasibilityResult` ONLY (no score field) |
| KEYSTONE golden reversed-plan | `test/golden-reversed-plan.test.ts` | hand-built REVERSED plan ⇒ HARD-infeasible (LB1 buried behind 3 later blocks > max 2); correct plan ⇒ feasible; verified NON-tautological by injecting a P1 sign-flip and observing the golden FAIL |
| KEYSTONE property test | `test/planner-vs-validator.property.test.ts` | seeded LCG (200 enumerated fixed seeds, no live RNG) — every `planLoad` output satisfies the invariant AND the independent validator agrees on feasibility (zero HARD); reproducibility pinned |

## Design (KISS / YAGNI / DIP — smallest correct surface)

- **`planLoad(blocks, route, config) -> LoadPlan`.** Resolves each block's unload order
  from `buildUnloadOrderMap(route)` via `key.nextUnloadHubId` (hub off-route ⇒ sorts latest,
  never rear-bound). Sorts DESC by order (id tie-break for determinism), greedily fills
  slices nose→rear opening a shallower slice on capacity overflow, then renumbers so depth
  0 = rear. Depth is **monotone non-increasing in unloadOrder by construction**, so the
  canonical invariant holds for every emitted plan — the planner never manufactures an
  out-of-bound blocker when a feasible layout exists.
- **`validatePlan(plan, blocks, route, config) -> FeasibilityResult`.** A SEPARATE code path.
  It re-derives `Placement`s from `plan.slices` contents + the route (NOT from
  `plan.placements`), counts blockers with the ONE canonical `isBlocker`, and classifies
  HARD/SOFT against `maxAllowedBlockers`. `isFeasible(result) = hardViolations.length === 0`.
- **Independence guard (T-02-10).** An import-shape test strips comments from `validator.ts`
  source and asserts no `from "…plan-load"` / `require("…plan-load")` / `planLoad(` — the
  validator provably cannot share the planner's bug.

## Anti-pitfall posture

- **Anti-P1 (inverted LIFO):** the predicate is single-sourced in `lifo-invariant.ts`; the
  planner builds a layout that respects it and the validator independently re-derives and
  checks it. The golden fixture is proven falsifiable (fails under an injected sign-flip).
- **Anti-P2 (feasibility folded into score):** `validatePlan` returns `FeasibilityResult`
  only — `Object.keys` is exactly `["hardViolations","softViolations"]`; a test asserts no
  `rehandleScore`/`utilizationScore` fields. The HARD gate is independent of any score.
- **Determinism (P3):** no `Date.now()`/`Math.random()` call-sites; stable id tie-breaks;
  the property test uses an enumerated-seed LCG so failures reproduce exactly.

## Gate results (from `/Volumes/Unitek-B/Projects/jobs/.mm-worktrees/p2-04-r2`)

| Gate | Result |
|------|--------|
| `pnpm install` | OK — lockfile up to date |
| `pnpm -r build` | OK (exit 0) — all packages incl. `@mm/load-planner`; `@mm/domain` `contract.assert.ts` build-gate intact, domain untouched |
| `pnpm lint` | OK (exit 0) — eslint zero findings |
| `pnpm test` (unit) | OK — 24 files, 232 tests (was 210; +22: 8 plan-load + 9 validator + 3 golden + 2 property) |
| `pnpm test:all` | OK (exit 0) — 34 files, **269 tests** incl. Testcontainers Postgres integration (orbstack docker context) |

No Phase-1 (126) or earlier Phase-2 regressions; no test weakened.

## Files

- `packages/load-planner/src/plan-load.ts` (new), `src/validator.ts` (new)
- `packages/load-planner/src/index.ts` (exports `planLoad`, `validatePlan`, `isFeasible`)
- `packages/load-planner/src/plan-load.test.ts`, `src/validator.test.ts` (new unit tests)
- `packages/load-planner/test/golden-reversed-plan.test.ts`,
  `test/planner-vs-validator.property.test.ts` (keystone tests)

---

## Integration record (rival-exec → `feature/phase-2-load-planning`)

**Winner:** rival #2 — branch `wt/p2-04-r2`, source sha `6ff1c3c01e7d72be6dab49344b6539cc64504f83`.
**Merge:** `git merge --no-ff` onto `feature/phase-2-load-planning`. All 8 files added cleanly
(pure additions to `packages/load-planner` + this SUMMARY); **zero conflicts** — `index.ts` merged
without overlap and re-exports `planLoad`, `isFeasible`, `validatePlan`. Integration merge commit
`3c961da`.

### Requirements delivered

- **LOAD-03** — greedy route-aware planner (`src/plan-load.ts`, `planLoad`).
- **LOAD-04** — independent feasibility validator via virtual-unload simulation
  (`src/validator.ts`, `validatePlan` / `isFeasible`); independence guarded by import-shape test.
- **LOAD-05** — partial-LIFO: bounded blockers emit a plan and classify SOFT, not HARD.

### Gate results — re-verified on the integration branch post-merge

| Gate | Result |
|------|--------|
| `pnpm install` | OK — lockfile up to date, exit 0 |
| `pnpm -r build` | OK — 8 packages built (domain, aggregation, load-planner, api, event-store, projections, web, simulation), exit 0 |
| `pnpm lint` | OK — eslint zero findings, exit 0 |
| `pnpm test:all` | OK — **34 files, 269 tests passed**, exit 0 (incl. Testcontainers Postgres integration) |
| load-planner subset | OK — 7 files, 63 tests passed (8 plan-load + 9 validator + 3 golden + 2 property + foundation) |

No merge-only breakage; nothing fixed, nothing weakened. No Phase-1 or earlier Phase-2 regression.

### Carried risks (from judge adjudication — to address in Plan 05 / later fixtures)

1. **Weight-capacity rollover thinly tested.** R2 sets per-slice weight capacity to
   `maxBlockVolume * 100`, so weight is effectively never the binding per-slice constraint in the
   demo — only volume packing is genuinely exercised; the weight-driven rollover path lacks a
   dedicated fixture.
2. **Off-route-hub edge semantics uncovered.** R2's validator and planner treat an off-route hub
   as the *latest* unload (fallback rank = `orderMap.size`), whereas R1 skips off-route blocks
   entirely. Both are defensible but differ; neither is exercised by a dedicated off-route-hub
   fixture in R2.
3. **Golden + validator tests import from `../src` directly** rather than the built
   `@mm/load-planner` public surface, so they would not catch an `index.ts` mis-export. Mitigated:
   the property test DOES import the public surface (and the merged `index.ts` was verified to
   export `planLoad`/`isFeasible`/`validatePlan`).
4. **Fallback note (R1).** R1 remained fully valid (all gates green, both keystones pass,
   genuinely independent validator); its shortfall is that its greedy does not perform real
   multi-block capacity packing — relevant more to Plan 05 scoring/utilization than to the Plan 04
   LIFO-correctness deliverable. Not selected; recorded for Plan 05 design awareness.
