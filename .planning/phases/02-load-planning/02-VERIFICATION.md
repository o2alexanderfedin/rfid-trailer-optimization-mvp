---
phase: 2
slug: load-planning
doc: verification
status: passed
build_gate: pass
lint_gate: pass
test_gate: pass
coverage_complete: true
confirmed_high: 0
confirmed_medium: 1
confirmed_low: 6
resolved_medium: 1
resolved_low: 5
remaining_low: 2
verified_at: 2026-06-19
resolved_at: 2026-06-19
resolution_commit: b268f8b
fix_source_commit: 17055cdbb683a4d898f2b3f410fc6afbe4e18b0c
---

# Phase 2 — Verification Report

> Evidence-based verification of the load-planning phase (AGG-01..04, LOAD-01..10).
> Gates and coverage were **re-run** against the working tree on 2026-06-19, not taken on trust.

## Verdict: `passed`

Requirement coverage is **complete** (14/14 verified, each with implementation code + at least one passing test), there are **zero confirmed HIGH** issues, and — after integrating the winning Phase-2 fix bundle (rival #1, merge `b268f8b` ← `17055cdbb683a4d898f2b3f410fc6afbe4e18b0c`) — **every gate is green, including turbo `pnpm build`**. The previously red build gate (a pre-existing Phase-1 circular package dependency) is closed: the cross-package test-only devDeps were removed from `event-store`/`projections` and the full-spine integration tests were relocated to `api/test/`, so turbo can now order the graph. The single MEDIUM (M1) and the build-blocking LOW (L1), plus L2/L3/L6/L7, are resolved with guarding tests (see 02-REVIEW.md). L4/L5 remain as safe carried debt (no production reachability).

> **History:** this report previously read `gaps_found` because the full-repo `pnpm build` exited 1 on the inherited Phase-1 build cycle. That gate is now green; the verdict is updated to `passed` on 2026-06-19 against merge `b268f8b`.

---

## Gate Results

| Gate | Spec target | Command | Actual result | Status |
|------|-------------|---------|---------------|--------|
| Build (turbo) | 0 errors | `pnpm build` (`turbo run build`) | **EXIT 0** — `Tasks: 8 successful, 8 total` (verified with the turbo cache cleared + tsbuildinfo/dist removed, so it is a real compile in the main repo, not a cache replay). The Phase-1 cycle is broken. | **PASS** |
| Build (recursive) | 0 errors | `pnpm -r build` | **EXIT 0** — all 8 packages `Done` (`tsc -b`; web also `vite build`). | **PASS** |
| Install (lockfile) | consistent | `pnpm install --frozen-lockfile` | **EXIT 0** — lockfile up to date after the merge dropped the now-unused devDeps; no working-tree drift. | **PASS** |
| Lint | 0 problems | `pnpm lint` (`eslint .`) | **EXIT 0** — no problems reported. | **PASS** |
| Tests (full) | all green | `pnpm test:all` (`vitest run`) | **EXIT 0** — `Test Files 41 passed (41)`, `Tests 323 passed (323)`. | **PASS** |
| Tests (integration project) | all green | `vitest run --project integration` | **EXIT 0** — `Test Files 10 passed (10)`, `Tests 37 passed (37)` — includes the relocated `api/test/projections-*.int.test.ts` + `api/test/skeleton.int.test.ts` (matched by the `packages/*/test/**/*.int.test.ts` glob). | **PASS** |

### Build-gate resolution — how the inherited Phase-1 cycle was broken

The cycle lived entirely among **Phase-1** packages and the turbo `build` pipeline (`build` dependsOn `^build`, per `turbo.json`): `event-store` declared test-only devDependencies `@mm/api`/`@mm/simulation` (used only by `event-store/test/skeleton.int.test.ts`), and `@mm/api` depends on `@mm/event-store`, closing the loop because turbo treats devDeps as `^build` inputs. It was introduced by commit `53f6a4b` "feat(01): walking skeleton" (Phase 1) — i.e. it predated Phase 2.

**Fix (rival #1, in merge `b268f8b`):**
- Removed the test-only cross-package devDeps from `packages/event-store/package.json` (`@mm/api`, `@mm/simulation`) and from `packages/projections/package.json` (`@mm/event-store`, `pg`, `@testcontainers/postgresql`, `@types/pg`), so no source package's build graph pulls a package that depends back on it.
- Relocated the full-spine integration tests — `skeleton.int.test.ts` and `projections-{audit-geo,golden-replay,idempotency}.int.test.ts` — into `packages/api/test/` (a package that already legitimately depends on the projection/event-store graphs). They still match the integration project's `packages/*/test/**/*.int.test.ts` glob and execute (10 files / 37 tests green).
- `pnpm-lock.yaml` regenerated accordingly; `--frozen-lockfile` install is consistent.

Net: turbo can now compute a build order; `pnpm build` exits 0 (8/8). Verified by clearing the turbo cache and per-package `tsbuildinfo`/`dist` and re-running, so the green is a genuine compile, not a replayed cache log.

> **Coverage-handoff correction (now moot):** the original handoff asserted *"build 0"*, which was not reproducible at the time (full-repo `pnpm build` exited 1 on the cycle). After this integration the full-repo turbo build is genuinely `EXIT 0`. Test counts grew from 40/309 to **41/323** because the fix added guarding regression tests (M1/L2 id-uniqueness, L3 far-future precision, L6 zone-truth, L7 inverted-band 400).

---

## Requirements Coverage

All 14 Phase-2 requirements are **verified** — each has concrete implementation plus at least one passing test that proves the specific behavior. Aggregation: `packages/aggregation/src/{block,aggregate,split,priority,deadline-bucket}.ts`. Load planner: `packages/load-planner/src/{trailer,unload-order,plan-load,validator,lifo-invariant,scoring,instructions,baseline,rationale}.ts`. Composed at the API boundary in `packages/api/src/routes/plan.ts`.

| Req | Status | Implementation | Proving test(s) |
|-----|--------|----------------|-----------------|
| **AGG-01** | verified | `aggregate.ts` `deriveKey` builds the 7-part `BlockKey` and groups by `keyId`; `block.ts` `KEY_FIELDS` = the 7 axes. | `aggregate.test.ts` "grouping (AGG-01)" — identical keys merge; `it.each` over the 6 non-derived axes splits on each; derived `deadlineBucket` split. |
| **AGG-02** | verified | `block.ts` `buildLoadBlock` reduces `totalVolume`/`totalWeight`, `packageCount = packageIds.length`. | `aggregate.test.ts` "aggregates (AGG-02)" — totalVolume=9, totalWeight=18, count=3=len; `loadBlockSchema.parse` validity. |
| **AGG-03** | verified | `split.ts` `splitBlock` — volume split (`greedyVolumeBins`) OR fragile+heavy partition; deterministic, stable, idempotent; called per group in `aggregate.ts`. | `split.test.ts` — over-volume → ≥2 feasible sub-blocks w/ conservation, determinism, idempotence; handling split; `aggregate.test.ts` "all-feasible (AGG-03)". |
| **AGG-04** | verified | `priority.ts` `blockPriority = SLA_CLASS_WEIGHT[sla] − deadlineFraction` (fraction ∈[0,1), SLA dominates); earliest member deadline. | `priority.test.ts` SLA dominance + earlier-deadline tiebreak + exhaustive property; `aggregate.test.ts` "priority (AGG-04)". |
| **LOAD-01** | verified | `trailer.ts` `emptyTrailer` builds ordered `TrailerSlice[]` depth 0..n−1 (0=rear), per-slice caps, zero used, independent id arrays. | `trailer.test.ts` (LOAD-01) — ascending depth, 0=rear, caps, zero used, no shared mutable state, edge cases. |
| **LOAD-02** | verified | `unload-order.ts` `buildUnloadOrderMap` → dense rank by `stopIndex` asc, duplicate collapse, stable tie-break. | `unload-order.test.ts` (LOAD-02) — earlier⇒lower, order-independent, dense from sparse, collapse, determinism, invalid-route reject. |
| **LOAD-03** | verified | `plan-load.ts` `planLoad` sorts blocks `unloadOrder` DESC (id tie-break), fills nose→rear honoring caps, renumbers depth 0=rear; canonical invariant by construction. | `plan-load.test.ts` (LOAD-03) — invariant holds, earliest-unload nearest rear, every block placed once, caps honored, determinism; property test (200 seeds). |
| **LOAD-04** | verified | `validator.ts` `validatePlan` — independent virtual unload sim reading ONLY `plan.slices`, recomputes order, counts blockers via canonical `isBlocker`; >max⇒HARD, 1..max⇒SOFT; returns `{hardViolations, softViolations}` only. | `validator.test.ts` — recompute-from-slices, HARD@max+1, SOFT@max, no score fields, import-guard (no `plan-load` import); golden `golden-reversed-plan.test.ts` — reversed⇒HARD, correct⇒feasible, verdicts differ. |
| **LOAD-05** | verified | `plan-load.ts` partial-LIFO: never rejects bounded-blocker layout; rehandle cost assigned later. | `plan-load.test.ts` "partial-LIFO acceptance (LOAD-05)"; validator SOFT boundary in `validator.test.ts`. *(See REVIEW low-sev note: planLoad is structurally total-LIFO; the SOFT path is exercised by the FIFO baseline + fixtures, not by planLoad.)* |
| **LOAD-06** | verified | `scoring.ts` `rehandleScore`/`rehandleBreakdown` apply the §7.5 formula via canonical `isBlocker` + `placementsFromSlices`. | `scoring.test.ts` (LOAD-06) — hand-computed: fragile blocked=44, non-fragile=34, multi-blocker vol=45, clean plan=0. |
| **LOAD-07** | verified | `scoring.ts` `utilizationScore` — soft band [0.75,0.90], quadratic penalty both sides, 0 inside. | `scoring.test.ts` (LOAD-07) — `it.each` (0.6→2.25, band→0, 0.98→0.64), zero across band, symmetric. |
| **LOAD-08** | verified | `instructions.ts` `instructions(plan, blocks)` groups by `zoneForDepth` nose→middle→rear, names block+destHub, renders text, omits empty zones. | `instructions.test.ts` (LOAD-08) — zone order, zone+destHub, readable text, determinism, multi-id order, empty-zone omission; `api/test/plan.test.ts` POST /plan asserts zone-ordered instructions + non-empty text. |
| **LOAD-09** | verified | `baseline.ts` `baselinePlan` — naive FIFO carrying TRUE route unloadOrder through the SAME `validatePlan`+`scorePlan` plumbing (no private scorer). | `baseline.test.ts` — same shape, FIFO ignoring order, violates invariant on reversed scenario; keystone `baseline-vs-optimizer.test.ts` — both scored via shared path, optimizer rehandle ≤ baseline (strict < on designed case), source-guard (no own scorer). |
| **LOAD-10** | verified | `rationale.ts` `placementRationale` (per-placement plain English) + `planExplanation` (verdict from independent validator + figures), reusing `rehandleBreakdown`. | `rationale.test.ts` (LOAD-10) — accessible phrasing, blocked w/ count+minutes, non-empty rationale w/ id for EVERY placement, planExplanation references verdict+rehandle+util; `plan.test.ts` asserts non-empty explanation. |

**Coverage: complete (`coverageOk = true`).**

### Keystone / P1-P2 defenses (all present and green)
1. **Golden reversed-plan fixture** (`test/golden-reversed-plan.test.ts`) — independent validator flags a reversed layout HARD-infeasible and accepts the correct one (LB1 blockerCount=3 HARD); not a tautology.
2. **Property test** (`test/planner-vs-validator.property.test.ts`) — `planLoad` satisfies the canonical invariant AND the validator agrees on feasibility across 200 deterministic seeds.
3. **Feasibility-vs-score separation** — `FeasibilityResult` and `ScoreResult` are structurally distinct; asserted in `validator.test.ts`/`scoring.test.ts` and at the wire in `api/test/plan.test.ts` (infeasible FIFO baseline still carries a score, never bought out).
4. **Single-source `isBlocker`** in `lifo-invariant.ts`; source-level import guard prevents `validator.ts` depending on `plan-load.ts` (anti-P1).

---

## Manual Verification (note)

| Behavior | Req | Why manual | Result |
|----------|-----|-----------|--------|
| `POST /plan` returns a readable plan + zone-ordered instructions/rationale for a seeded demo trailer/route | LOAD-08, LOAD-10 | Human readability of the instructions/rationale text is subjective and cannot be asserted mechanically beyond "non-empty + zone-ordered". | **Not human-eyeballed in this verification pass.** The mechanical surrogates are green: `packages/api/test/plan.test.ts` (5/5) drives the real `POST /plan` route (`packages/api/src/routes/plan.ts`) and asserts (a) zone-ordered instructions are present in nose→…→rear order, (b) instruction text is non-empty, (c) a non-empty plain-English `explanation` is returned. **Carried action:** a reviewer should call the seeded endpoint once and confirm the prose actually reads naturally (zone labels, blocker minutes, fragile notes). Low risk — the rendered strings are unit-tested in `instructions.test.ts`/`rationale.test.ts`. |

---

## Doc-status flags (non-blocking)

`02-VALIDATION.md` front-matter still reads `nyquist_compliant: false` / `wave_0_complete: false` and its keystone/wave checklists are unticked. These are **document bookkeeping flags, not code or test gaps** — every behavior they gate exists and passes. They should be reconciled when the validation doc is finalized, but they do not affect this verdict.

---

## Summary

- **Coverage:** complete — 14/14 requirements verified with code + passing tests.
- **Gates (all green):** turbo `pnpm build` PASS (8/8, real compile, cache cleared) · `pnpm -r build` PASS (8/8) · `--frozen-lockfile` install PASS · lint PASS (0) · `pnpm test:all` PASS (41 files / 323 tests) · integration project PASS (10 files / 37 tests).
- **Confirmed issues (post-integration):** HIGH 0. MEDIUM 1 — **RESOLVED** (M1 `split.ts` duplicate-`loadBlockId`, fixed in `b268f8b`, guard `split.test.ts:180`). LOW 6 — **5 RESOLVED** (L1 build-cycle, L2 stale key class, L3 deadline precision, L6 zone-truth, L7 inverted-band 400), **2 carried** (L4 `keyId` separator collision, L5 dead doc branch) as safe debt. See 02-REVIEW.md.
- **Verdict:** **`passed`** — coverage complete, zero HIGH, and every gate green including turbo `pnpm build`. The two `passed`-blockers (M1 + L1) are closed with guarding tests. No HIGH, no data-corruption or security path through the documented `POST /plan` / `aggregate` flows.

### Integration provenance
- **Merge:** `b268f8b` (`git merge --no-ff 17055cdbb683a4d898f2b3f410fc6afbe4e18b0c -m "fix(02): build cycle + split-id + correctness fixes (rival #1)"`) into `feature/phase-2-load-planning` — no conflicts.
- **Source:** winning rival #1, branch `wt/p2-fix-r1`, sha `17055cdbb683a4d898f2b3f410fc6afbe4e18b0c`.
