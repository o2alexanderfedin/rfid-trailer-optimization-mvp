# Plan 02-03 Summary — `@mm/load-planner` foundation (LOAD-01, LOAD-02)

**Status:** COMPLETE — all gates green. Rival #1 implementation, integrated into
`feature/phase-2-load-planning`.

## What shipped

A new PURE, IO-free package `@mm/load-planner` (depends on `@mm/domain` ONLY) that lays the
interface-first foundation every later Phase-2 load-planner plan (04 planner+validator, 05
scoring+baseline) builds against. Built strict TDD (RED → GREEN). No placement logic yet —
just the vocabulary, the predicate, the trailer model, and the contracts.

| Requirement / must-have | Where | Proof |
|-------------------------|-------|-------|
| LOAD-01 trailer rear→nose slice model | `src/trailer.ts` (`emptyTrailer`) | ordered `TrailerSlice[]`, depth 0..n-1 (0=rear), zero used vol/weight, fresh per-slice block arrays; slice-ordering + depth-0-rear tests |
| LOAD-02 route unload-order map | `src/unload-order.ts` (`buildUnloadOrderMap`) | earlier stop ⇒ lower dense rank; stopIndex-asc; duplicate-hub collapse; `routeStopSchema` validation; earlier⇒lower-order tests |
| Canonical LIFO invariant (P1 defense, single source) | `src/lifo-invariant.ts` (`isBlocker`, `canonicalInvariantHolds`, `lifoOk`, `countBlockers`) | boundary fixtures on strict `>`, depth direction, same-hub; reversed-placement fixture FAILS the invariant (not a tautology) |
| Zone labels rear/middle/nose | `src/trailer.ts` (`zoneForDepth`) | `floor(depth*3/sliceCount)` thirds; non-divisible-count + monotonicity tests |
| P2 feasibility-vs-score separation baked into types | `src/types.ts` | `FeasibilityResult {hardViolations, softViolations}` and `ScoreResult {rehandleScore, utilizationScore}` are DISTINCT, non-overlapping types — structurally impossible to merge |
| Purity | whole package | imports only `@mm/domain`; zero `Date.now`/`Math.random` call-sites |

## Module surface (exported from `src/index.ts`)

- `lifo-invariant.ts` — THE canonical invariant `unloadOrder(A) < unloadOrder(B) ⟹ depth(A) ≤ depth(B)`;
  the strict blocker predicate `isBlocker(target, other)` (true ⟺ `other.depth < target.depth` AND
  `other.unloadOrder > target.unloadOrder`; same unloadOrder ⇒ false); `countBlockers`, `lifoOk`.
  Single source — planner, validator, and tests import from here and never restate the predicate.
- `trailer.ts` — `emptyTrailer(trailerId, sliceCount, capV, capW) -> TrailerSlice[]` (ascending-depth,
  0 = rear); `zoneForDepth(depth, sliceCount) -> "rear"|"middle"|"nose"` via integer thirds.
- `unload-order.ts` — `buildUnloadOrderMap(route) -> Map<hubId, denseRank>`; earlier stop ⇒ lower order
  ⇒ (per the invariant) lower depth (nearer rear).
- `types.ts` — `Placement`, `LoadPlan`, `Violation`, `FeasibilityResult`, `ScoreResult` (P2 separation).

## Gate results (re-verified post-merge in MAIN repo)

| Gate | Result |
|------|--------|
| `pnpm install` | OK — lockfile up to date |
| `pnpm -r build` | OK — 8 packages incl. new `@mm/load-planner` (`tsc -b`); `@mm/domain` `contract.assert.ts` build-gate intact, domain untouched |
| `pnpm lint` | OK — eslint exit 0, zero findings |
| `pnpm test:all` | OK — **30 files, 247 tests passed** (incl. Testcontainers Postgres integration) |

No merge conflicts; no merge-only breakage; no test weakened. Unit suite grew 169 → 210
(+41 load-planner: lifo-invariant + trailer + unload-order).

## Integration record

- **Winner:** rival #1, branch `wt/p2-03-r1`, sha `3bf11acd560e80d0a1697ceca2bf2cf146e55268`.
- **Merge:** `git merge --no-ff` into `feature/phase-2-load-planning`; conflict-free (new package,
  no overlap with branch tip `57ec548`).
- **Merge commit:** `cc120b857ab462d9ebaef62c97e741258496f351`
- **Pushed:** `origin/feature/phase-2-load-planning` (`57ec548..cc120b8`).
- **Rival cleanup:** worktrees `p2-03-r1` / `p2-03-r2` removed + pruned; branches
  `wt/p2-03-r1` / `wt/p2-03-r2` deleted.

## Carried risks (conceded R2 advantages — weigh in plans 04/05)

The selection was close (~55/45). R2 had three real, conceded advantages the parent should
carry forward when authoring the planner (04) and scoring (05):

1. **Compile-time vs runtime P2 guard.** R2 enforced the FeasibilityResult/ScoreResult
   separation at COMPILE time via `@ts-expect-error` (the build breaks if the types ever
   merge) — strictly stronger than R1's runtime `"field" in obj` discrimination. R1's types
   are still distinct, non-overlapping interfaces (P2 is satisfied), but the guard against a
   future accidental merge is weaker. **Mitigation for 04/05:** add a `@ts-expect-error`
   negative-assignment test pinning the two shapes apart.

2. **`zoneForDepth` degenerate 2-slice labeling.** R1's `floor(depth*3/sliceCount)` thirds
   label a 2-slice trailer `[rear, middle]` — NO nose. R2's `zoneForDepth` guarantees the
   deepest slice is always `nose` (depth0=rear ∧ deepest=nose for all n≥2). R1's choice is
   tested and embraced; n=2 is unlikely for a real multi-slice trailer. If a downstream
   consumer assumes "deepest slice is always nose," revisit R1's thirds rule.

3. **SUMMARY faithfulness.** The plan's `<output>` requires `02-03-SUMMARY.md`. R1 did NOT
   write it (deferred to integration, citing a 02-01 precedent) and combined RED+GREEN per
   commit; R2 wrote the SUMMARY and used a cleaner RED→GREEN×2+summary commit trail. **This
   integration step satisfies the deliverable** — this file is the 02-03 summary.

4. **`buildUnloadOrderMap` tie-break.** R1 collapses duplicate hubs to first occurrence
   (input-order-dependent); R2 uses hubId lexicographic (input-order-independent). Both are
   deterministic; the difference only surfaces for the degenerate case of two DISTINCT hubs
   sharing a `stopIndex`, which is not a real route shape.

All four are accepted as in-scope-clean for a foundation plan. None blocks plans 04/05; items
1 and 2 are the ones to consciously revisit when the planner/validator are written against
these contracts.

## Files

- `packages/load-planner/package.json`, `tsconfig.json`
- `packages/load-planner/src/{index,types,lifo-invariant,trailer,unload-order}.ts`
- `packages/load-planner/src/{lifo-invariant,trailer,unload-order}.test.ts`
- `tsconfig.eslint.json` — added `@mm/load-planner` path mapping; `pnpm-lock.yaml` updated
