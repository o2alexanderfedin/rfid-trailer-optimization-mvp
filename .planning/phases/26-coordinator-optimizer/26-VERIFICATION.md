---
phase: 26-coordinator-optimizer
verified: 2026-06-27
status: passed
score: COORD-06 delivered (criteria 2/3/4 fully; criterion 1 wired+invoked, observable-divergence → P27 per user decision)
verified_by: orchestrator (executor full-phase gate + independent golden re-run)
overrides_applied: 0
---

# Phase 26 — Coordinator ↔ Optimizer — Verification

**Verdict: PASSED.** COORD-06 is delivered: a coordinator invokes the proven optimizer as a per-center
scoped, PURE `runEpoch` suggestion engine called synchronously in-fold, with a deterministic fallback,
the global RollingLoop disabled under the flag, and the NET-05 `partitionScopeByCenter` carry-over now
LIVE. Full phase gate green; goldens independently re-verified by the orchestrator (33/33).

## Requirements

| Req | Criterion | Status | Evidence |
|-----|-----------|--------|----------|
| COORD-06 #1 | optimizer-backed reroute observably plan-quality vs rule-based | ⚠ wired+invoked; observable-divergence → P27 | `runEpoch` genuinely runs (instrumented: 2000 epochs / 9663 reroutes / 0 fallbacks); but on the current always-feasible/center-headed per-center twin it can only ENDORSE the rule's "reroute to center" → byte-identical to `edfa5a6d`. **User decision: ship now, make divergent in P27.** |
| COORD-06 #2 | scope bounded (per-center, size-independent of network) | ✅ | `detectAffectedScope → partitionScopeByCenter` (NET-05 live) → per-center twin; scope-size-invariance witness green |
| COORD-06 #3 | global RollingLoop disabled under flag; heuristic fallback | ✅ | RollingLoop disabled at the API composition root under the coordinator flag; deterministic integer scope-size-cap fallback to rule-based (never wall-clock) |
| COORD-06 #4 | in-fold pure runEpoch, deterministic; sub-flag-off === Phase-25; new golden | ✅ | pure `runEpoch` at a deterministic tick, sorted centerId; sub-flag-off byte-identical to `edfa5a6d`; optimizer-on golden captured reproducibility-first |

## Determinism (independently re-verified by orchestrator)

`pnpm exec vitest run packages/simulation/test/determinism.unit.test.ts` → **33/33 pass**. Four goldens
hold: `3920accc…` (flags-off) · `94689f99…` (OODA-on) · `edfa5a6d…` (coordinator-on) ·
`edfa5a6d…` (optimizer-on, documented-equal). Two-part sub-flag gate (`coordinatorUsesOptimizer:false ===
absent`) green. Continuation-equivalence (chunked == all-at-once @1/7/23/500) green; no new
SerializedWorldState field (in-fold runEpoch is stateless per tick).

## Full phase gate

build (turbo) 10/10 ✅ · typecheck 0 ✅ · lint 0 ✅ (coordinator/** + ooda/** DET-03 guards active) ·
**1570 unit tests** (sim 607 / domain 260 / optimizer 178 / projections 139 / load-planner 103 / api 283).

## Carry-overs (→ Phase 27, recorded)

1. **Make the optimizer-backed reroute GENUINELY route-aware-divergent** (the COORD-06 #1 demo value):
   rebuild the per-center twin to reflect real freeze-windows/capacity + give the optimizer a real choice
   of destination beyond the center, so "observably plan-quality vs rule-based" is demonstrable. **User-
   approved deferral.** Bundle with #2.
2. **Reject-with-reason continental scenario tuning** (from Phase 25): tune the continental scenario so
   the headline "won't divert: HOS/fuel" reject fires live. Both are "make the continental demo showcase
   the smart behavior" tasks.

## Resolved this phase

- **NET-05 `partitionScopeByCenter` carry-over (open since Phase 23) is now CLOSED** — it has its first
  live consumer (the per-center coordinator epoch scope), with the scope-size invariant governing a live epoch.
