# Plan 02-05 Summary — Scoring + instructions + baseline (rival 2)

**Status:** COMPLETE — all gates green. Requirements LOAD-06, LOAD-07, LOAD-08, LOAD-09, LOAD-10.

## What shipped

Extended the PURE `@mm/load-planner` package (depends on `@mm/domain` ONLY) with the soft
scoring layer, explainability, the dock-worker loading card, and the naive FIFO baseline —
built strict TDD (RED → GREEN → REFACTOR), one commit per task.

| Requirement / must-have | Where | Proof |
|-------------------------|-------|-------|
| LOAD-06 rehandle score | `src/scoring.ts` (`rehandleScore`, `rehandleBreakdown`) | per block `blockersCount·unloadReloadMin + blockersVolume·volCost + fragilePenalty + dockDelayPenalty + slaImpactPenalty`; plan total = Σ; blocker count/volume from the ONE canonical `isBlocker` over `placementsFromSlices` (no second predicate); hand-computed fixture = 44 (1 blocker, fragile target, blockersVolume 4) |
| LOAD-07 utilization score | `src/scoring.ts` (`utilizationScore`) | `u = Σ used / Σ capacity`; `max(0, utilLow−u)²·wLow + max(0, u−utilHigh)²·wHigh`; 0 inside [0.75, 0.90]; table cases (u=0.60→2.25, 0.75/0.80/0.90→0, 0.98→0.64) + symmetry both sides |
| ScoreResult separation (anti-P2) | `src/scoring.ts` (`scorePlan`) | returns `{ rehandleScore, utilizationScore }` ONLY; shape test asserts no `hardViolations`/`softViolations` fields; the type is structurally distinct from `FeasibilityResult` |
| LOAD-08 loading instructions | `src/instructions.ts` (`instructions`) | groups placed blocks by `zoneForDepth` (nose/middle/rear), physical load order nose→rear, each line names block + dest hub; empty zones omitted; deterministic text card |
| LOAD-10 explainability | `src/rationale.ts` (`placementRationale`, `planExplanation`) | per-placement plain-English from the SAME `rehandleBreakdown` (accessible vs "N blocker(s), +M-min rehandle accepted"); every placement non-empty; plan-level aggregates verdict + rehandle/utilization figures + all placement lines |
| LOAD-09 FIFO baseline | `src/baseline.ts` (`baselinePlan`) | places by stable `loadBlockId` (arrival/FIFO, NOT `unloadOrder`) nose→rear into capacity slices; SAME `LoadPlan` shape; carries the TRUE route-derived `unloadOrder` so the validator/scorer see real blockers; LIFO-blind strawman (violates the canonical invariant on a reversed scenario) |
| Baseline beats-it (P8) | `test/baseline-vs-optimizer.test.ts` | both plans scored through the ONE shared `scorePlan`; optimizer rehandle ≤ baseline on a blocking-prone scenario; STRICTLY < on the designed case (optimizer 0 vs baseline > 0); source guard asserts `baseline.ts` defines no private scorer |

## Design (KISS / YAGNI / DIP — smallest correct surface)

- **Single blocker source (anti-P1).** Scoring does NOT re-implement the blocker predicate.
  `placementsFromSlices` was promoted from private to exported in `validator.ts` so the
  scorer derives placements from the SAME slice-based view, then collects blockers with the
  canonical `isBlocker`. `rehandleBreakdown` computes the per-block internals ONCE; both the
  score total and the rationale text read it — the words can never disagree with the number.
- **`scorePlan(plan, blocks, route, config) -> ScoreResult`.** A pure composition of
  `rehandleScore` + `utilizationScore`. It is the ONE scoring path both `planLoad` and
  `baselinePlan` flow through (shared plumbing, P8) — so the Phase-5 before/after slide is
  wiring, not a rebuild.
- **`baselinePlan`** mirrors the optimizer's slice-building geometry but sorts by the FIFO id
  key instead of `unloadOrder` and places first-arriving at the nose. It imports NEITHER
  `plan-load` NOR the scorer — it just emits a plain `LoadPlan`; the caller scores it through
  the shared path, so the beat-it advantage cannot be rigged.
- **`instructions` / `rationale`** depend only on `zoneForDepth` (single-sourced zone labels)
  and the scoring internals — no new geometry or predicates introduced.

## Anti-pitfall posture

- **Anti-P1 (inverted LIFO):** no second blocker predicate exists. Rehandle, validator, and
  rationale all route through the one `isBlocker` over `placementsFromSlices`.
- **Anti-P2 (feasibility folded into score):** `scorePlan` returns `ScoreResult` only; a shape
  test pins the absence of any feasibility field. `planExplanation` derives the feasibility
  verdict from the INDEPENDENT `validatePlan` (the hard gate), never from the score.
- **Anti-P8 (rigged baseline):** baseline shares the optimizer's `scorePlan` plumbing on the
  same inputs; a source guard forbids a private scorer in `baseline.ts`; the beat-it test
  requires optimizer ≤ baseline (strict on the designed case).

## Purity / determinism

- `@mm/load-planner` imports `@mm/domain` (+ stdlib) ONLY. No DB, no clock, no RNG —
  `grep` for `Date.now()`/`Math.random()` call sites is empty (matches are docstring prose).
- Every export is deterministic: stable id tie-breaks throughout; same input ⇒ identical
  output (instructions card, rationale text, baseline plan, scores).

## Files

- `src/scoring.ts` — `rehandleScore`, `utilizationScore`, `scorePlan`, `rehandleBreakdown`, `BlockRehandle`
- `src/instructions.ts` — `instructions`, `LoadingInstructions`, `ZoneInstruction`, `InstructionLine`
- `src/rationale.ts` — `placementRationale`, `planExplanation`
- `src/baseline.ts` — `baselinePlan`
- `src/validator.ts` — `placementsFromSlices` promoted to an export (single-source placement derivation)
- `src/index.ts` — barrel exports for all of the above
- Tests: `src/scoring.test.ts` (14), `src/instructions.test.ts` (6), `src/rationale.test.ts` (5),
  `src/baseline.test.ts` (6), `test/baseline-vs-optimizer.test.ts` (4)

## Gates (run from the worktree)

- `pnpm install` — OK
- `pnpm -r build` — OK (all packages, tsc -b clean)
- `pnpm lint` — OK (root eslint, zero warnings)
- `pnpm test:all` — OK — **304 passed** (267 unit + 37 integration over 10 real-Postgres
  Testcontainers files on the OrbStack docker context). `@mm/load-planner` grew 63 → 98 tests
  (35 new); no prior test regressed; `@mm/domain` closed-event-union `contract.assert.ts`
  build gate intact.
