# Milestones

## v1.0 MVP (Shipped: 2026-06-20)

**Phases completed:** 5 phases, 34 plans, ~110–120 tasks across 34 plans

**Status:** 48/48 v1 requirements shipped and validated. Known deferred items at close: 0.

**Key accomplishments:**

1. **Event-sourced operational twin with deterministic replay (Phase 1):** append-only Postgres event log + per-stream optimistic concurrency + gap-free global ordering, pure-reducer projections, byte-identical golden-replay keystone.
2. **Route-aware LIFO/partial-LIFO load planner with an independent validator (Phase 2):** greedy nose→rear placement, separate-code-path virtual-unload validator (feasibility never folded into score), rehandle+utilization scoring, explainable rationale, FIFO baseline — the core IP.
3. **Probabilistic RFID validation (Phase 3):** rule-based Bayesian fusion (confidence capped <1.0), tag→package mapping, zone estimates, wrong-trailer + missed-unload detection with severity + action.
4. **Rolling-horizon optimizer (Phase 4):** custom time-expanded graph + SSP min-cost-flow (exact vs glpk.js LP oracle on 1,153 instances), custom VRPTW reusing the Phase-2 LIFO hard gate, sandboxed twin, freeze windows, scopeHash idempotency, split/reassign/hold/over-carry repair.
5. **Live realtime USA-map demo (Phase 5):** OpenLayers postrender trailer animation (zero per-frame alloc, flat-heap soak-proven), state coloring, versioned ws keyframe+delta protocol, scenario knobs driving visible re-optimization, exception feed, audit timeline, before/after KPI money slide.
6. **Adversarial code-grounded milestone audit + full closure:** a 10-agent audit caught 6 requirements "dark" on the live path behind a green 827-test suite; all fixed (TDD, rival-judged) and re-verified green at 872 unit+int tests / 98 files + 3 real chromium e2e.

---
