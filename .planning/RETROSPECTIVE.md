# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-06-20
**Phases:** 5 | **Plans:** 34 | **Sessions:** multi-session over ~3 calendar days

### What Was Built
- Event-sourced operational twin: append-only event log, per-stream optimistic concurrency (OCC), pure-reducer projections, byte-identical golden-replay keystone.
- The core LIFO/partial-LIFO load planner + independent (separate-code-path) validator + naive FIFO baseline — greedy nose→rear placement, rehandle/utilization scoring, explainable per-placement rationale.
- Probabilistic RFID validation: rule-based Bayesian fusion with confidence caps (<1.0), tag→package mapping, zone estimates, wrong-trailer + missed-unload detection with severity and recommended action.
- Rolling optimizer: time-expanded hub graph, SSP min-cost-flow (glpk.js-verified), custom VRPTW reusing the Phase-2 LIFO hard gate, sandboxed planning twin, freeze windows, scopeHash idempotency, split/reassign/hold/over-carry repair.
- Live OpenLayers/OSM demo: postrender trailer animation, versioned ws keyframe+delta protocol, scenario knobs, exception feed, audit timeline, before/after KPI money slide.

### What Worked
- TDD-first with one keystone test per phase: reversed-plan fixture, golden-replay byte-equality, concurrency winner, min-cost-flow vs glpk oracle, confidence-cap at N=100k.
- Strict separation-of-concerns enforced as both an architecture rule AND a test: feasibility hard-gate vs soft score; planned-vs-observed RFID; planning twin never reaching live projections.
- Event sourcing made the simulator the single trusted data source AND made the audit's code-grounding tractable.
- Rival-subagent builds + judge + adversarial review per phase.
- A real Postgres-backed integration keystone (live-demo.int.test.ts) exercising the core spine end-to-end.

### What Was Inefficient
- Synthetic tests passed while the live path was dark — Phase 5 review found 22 issues (12 merge-blocking) where unit-green code was unwired/broken on the live demo (OPT-07 localRepair never called, live rehandle hardcoded 0, VIZ-03 buckets zeroed, no ticks post-startup, scenario injection re-ran the base stream).
- Deferrals ("deferred to Phase 5") that were never closed silently became gaps (OPT-02, SNS-05).
- Default-value masking (computeKpis default-1.0, missed-unload check only `typeof number`, all Playwright boundaries stubbed) inflated the green suite.
- Root test scripts bypassed turbo `^build` and could run against stale dist.

### Patterns Established
- One canonical invariant imported everywhere (isBlocker in lifo-invariant.ts).
- Independent validator on a separate code path (recomputes from placed state, never trusts placement order).
- Pure IO-free domain modules depending only on @mm/domain.
- glpk.js as a test-only correctness oracle.
- Versioned ws envelope + server-pushes-keyframes / client-tweens with zero per-frame allocation.
- A real end-to-end integration keystone per the core spine + a real un-stubbed browser e2e (chromium-real).
- Gate must run turbo build (not recursive `-r build`) and build-before-test.

### Key Lessons
1. (Standout) Synthetic unit tests can be 100% green while the live integration path is entirely dark — only an adversarial code-grounded audit + a real full-integration gate caught 6 unsatisfied/partial requirements. Assert non-default/non-zero/observable outcomes through the real wired path, never `typeof number`.
2. Every "deferred to Phase N" needs an explicit close-out gate or it becomes a shipped-but-unmet requirement.
3. Stub every e2e boundary and you test your fixtures, not your system.
4. Make the demo hard enough that the optimizer can actually lose — otherwise the win is theater.
5. The documented test command must be the verified-green one.

### Cost Observations
- Model mix: predominantly opus/sonnet (no precise telemetry).
- Sessions: multi-session over ~3 calendar days (2026-06-18 → 2026-06-20), ~235 commits.
- Notable: the late-milestone adversarial audit (10-agent workflow) + full integration gate were the highest-leverage spend — they converted a green-but-dark suite into a verified-honest one.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | ~3 days (multi-session) | 5 | Established TDD-first + per-phase keystone + late adversarial code-grounded audit + real integration gate |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 872 unit+int (98 files) + 3 real chromium-real e2e | — | custom SSP min-cost-flow, custom VRPTW, time-expanded graph (graphology/ngraph not adopted) |

### Top Lessons (Verified Across Milestones)

1. Synthetic green ≠ live-wired green — assert observable outcomes through the real path, not type checks or defaults. (v1.0)
2. Every deferral needs an explicit close-out gate or it ships as an unmet requirement. (v1.0)
