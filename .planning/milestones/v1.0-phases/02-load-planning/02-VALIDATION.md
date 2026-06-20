---
phase: 2
slug: load-planning
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-19
---

# Phase 2 — Validation Strategy

> Pure, IO-free modules → mostly fast unit + property tests (no DB). Derived from 02-RESEARCH.md "Validation Architecture".

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (existing) |
| **Quick run** | `pnpm test` (unit + property — `@mm/aggregation`, `@mm/load-planner` are pure, no DB) |
| **Full suite** | `pnpm test:all` (adds the API endpoint integration test + prior Phase-1 suite) |
| **Estimated runtime** | unit ~seconds; full ~1–2 min |

## Sampling Rate
- After every task commit: `pnpm test` (pure planner/aggregation tests are fast)
- After every wave: `pnpm test:all`
- Before verify: full suite green incl. the golden reversed-plan fixture

## Per-Requirement Verification Map

| Requirement | Behavior to prove | Test Type | Command |
|-------------|-------------------|-----------|---------|
| AGG-01 | Packages grouped by the 7-part block key | unit | `pnpm --filter @mm/aggregation test` |
| AGG-02 | Block aggregate volume/weight/count correct | unit | `pnpm --filter @mm/aggregation test` |
| AGG-03 | Oversized/incompatible blocks split into feasible sub-blocks (stable) | unit | `pnpm --filter @mm/aggregation test split` |
| AGG-04 | Priority lexicographic (SLA weight, then deadline) | unit | `pnpm --filter @mm/aggregation test priority` |
| LOAD-01 | Trailer = ordered rear→nose slices w/ used vol/weight | unit | `pnpm --filter @mm/load-planner test` |
| LOAD-02 | Route unload-order map: earlier hub ⇒ lower depth | unit | `pnpm --filter @mm/load-planner test order` |
| LOAD-03 | Greedy places earlier-unload more accessible (canonical invariant holds) | unit + property | `pnpm --filter @mm/load-planner test` |
| LOAD-04 | **Independent validator (virtual unload sim)** flags HARD>max / SOFT≤max; **golden reversed-plan ⇒ HARD** | unit + golden | `pnpm --filter @mm/load-planner test validator` |
| LOAD-05 | Partial-LIFO accepts bounded blockers w/ rehandle cost, not rejection | unit | `pnpm --filter @mm/load-planner test partial` |
| LOAD-06 | Rehandle score = formula (hand-computed fixture) | unit | `pnpm --filter @mm/load-planner test rehandle` |
| LOAD-07 | Utilization soft 75–90% band, quadratic both sides | unit | `pnpm --filter @mm/load-planner test util` |
| LOAD-08 | Loading instructions by nose/middle/rear zone | unit | `pnpm --filter @mm/load-planner test instructions` |
| LOAD-09 | Baseline (FIFO) runs same inputs/plumbing; optimizer rehandle ≤ baseline on blocking scenario | unit | `pnpm --filter @mm/load-planner test baseline` |
| LOAD-10 | Every placement carries a plain-English rationale | unit | `pnpm --filter @mm/load-planner test rationale` |

## Keystone & Property Tests (P1/P2 defense)
- [ ] **Golden reversed-plan fixture** → HARD-infeasible (the single most important test).
- [ ] **Property test**: planLoad output satisfies the canonical invariant AND validator agrees on feasibility (deterministic seeds).
- [ ] **Feasibility-vs-score separation**: HARD violation rejected by the gate regardless of a low rehandle score; `{hard,soft}` and `{rehandle,utilization}` are distinct objects.
- [ ] **Blocker predicate** exactness: same-hub (not blockers) + multi-block-slice fixtures; HARD/SOFT boundary at maxAllowedBlockers.

## Wave 0 Requirements
- [ ] `packages/aggregation` + `packages/load-planner` scaffolded (pure, import only `@mm/domain`), Vitest wired, downward-only deps.
- [ ] `@mm/domain` LoadBlock/TrailerSlice stubs fleshed out (keeping the build-gated event union intact).

## Manual-Only Verifications
| Behavior | Requirement | Why Manual | Instructions |
|----------|-------------|------------|--------------|
| `POST /plan` returns a readable plan + instructions for a demo trailer/route | LOAD-08 | Human readability of instructions/rationale is subjective | Call the endpoint with a seeded scenario; eyeball the zone-ordered instructions + rationale |

---
*Validation strategy for Phase 2 — Nyquist coverage of AGG/LOAD requirements; keystone = golden reversed-plan fixture.*
