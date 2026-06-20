---
phase: 4
slug: rolling-optimizer
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-19
---

# Phase 4 — Validation Strategy

> `@mm/optimizer` core is pure → fast unit/property tests + the glpk.js oracle; the rolling loop gets integration tests on the shared Postgres (`MM_PG_URL`). Gates include turbo `pnpm build`. Keystone = the glpk.js min-cost-flow oracle.

## Test Infrastructure
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Quick run | `pnpm test` (pure optimizer unit/property + glpk oracle — no DB) |
| Full suite | `pnpm test:all` (+ rolling-loop/twin integration on shared PG) |
| Oracle | `glpk.js` (WASM) devDependency — exact LP optimum to validate SSP |
| Build gate | turbo `pnpm build` must pass |

## Per-Requirement Verification Map
| Req | Behavior to prove | Test | 
|-----|-------------------|------|
| OPT-01 | Time-expanded graph: hub@time nodes + trip/wait/cross-dock/load/unload edges from network+schedule | unit |
| OPT-02 | Min-cost flow (SSP) optimal == **glpk.js exact optimum** on N random instances + hand fixtures | unit + oracle |
| OPT-03 | VRPTW routes honor time windows + capacity; window-violating route rejected; local search never worsens objective; trailer loads pass Phase-2 HARD gate | unit |
| OPT-04 | Optimizing over the planning-twin sandbox emits NO events + mutates NO projection until accept | integration |
| OPT-05 | Rolling epoch scoped to affected hubs/trailers (not global); replans on periodic + event triggers | unit + integration |
| OPT-06 | Identical (epoch, scopeHash) ⇒ byte-identical plan; freeze-window trailers untouched | unit |
| OPT-07 | Infeasible plan ⇒ ≥1 feasible split/reassign/hold/over-carry recommendation w/ rationale; best-by-objective chosen | unit |
| OPT-08 | One weighted objective ranks candidates; an infeasible candidate is rejected regardless of low score (feasibility ≠ objective) | unit |

## Keystone & Property Tests
- [ ] **glpk.js oracle (OPT-02):** SSP min-cost-flow == glpk exact optimum across random small instances (the single most important Phase-4 test).
- [ ] **Feasibility hard-gate (OPT-08, P2):** infeasible candidate rejected despite low objective; objective & feasibility distinct.
- [ ] **Idempotency/freeze (OPT-06, anti-P7):** identical input ⇒ identical plan; freeze-window trailers untouched; no `Date.now`/`Math.random`.
- [ ] **Twin sandbox (OPT-04):** event-store + projections unchanged during evaluation; one `PlanAccepted` on accept.

## Wave 0 Requirements
- [ ] `packages/optimizer` scaffolded (pure core; import @mm/domain + @mm/load-planner), `glpk.js` devDependency, Vitest wired, downward-only deps.
- [ ] `@mm/domain`: add `PlanGenerated`/`PlanAccepted` to the closed union + zod + contract.assert (build-gate green).

## Manual-Only Verifications
| Behavior | Req | Why Manual | Instructions |
|----------|-----|------------|--------------|
| Optimizer recommends sensible reassign/hold/over-carry on a congested seeded run | OPT-07 | Plan plausibility is judgement | Run a congested seed; inspect the recommendations + rationale + objective breakdown |

---
*Validation strategy for Phase 4 — keystone: glpk.js min-cost-flow oracle; feasibility stays a hard gate.*
