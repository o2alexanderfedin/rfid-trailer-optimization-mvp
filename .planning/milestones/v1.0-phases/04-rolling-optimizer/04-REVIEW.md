# Phase 4 (Rolling Optimizer) — Code-Review Fixes Disposition

Branch: `feature/phase-4-rolling-optimizer`
Worktree: `/Volumes/Unitek-B/Projects/jobs/.mm-worktrees/phase4-main`
Context: adversarial review found **0 merge-blockers**. Optimizer algorithms are
verified correct (1153-instance fuzz vs. glpk LP oracle matched exactly). These
are robustness/correctness-hardening fixes, NOT a redesign.

Final gate: **build 9/9 tasks**; **test:all 58 files / 447 tests, all pass**
(integration tests run against ephemeral `postgres:17` via Testcontainers).

## Disposition table (8 confirmed findings + carried live-wiring debt)

| # | Sev | Finding | Disposition | Notes |
|---|-----|---------|-------------|-------|
| 1 | MEDIUM | Capacity gate bypass: `stopsForTrailer` dropped off-route block volumes from trailer demand, so the capacity feasibility check could be evaded (trailer loaded beyond capacity passing the gate). | **FIXED** `82ba1f3` | `epoch.ts stopsForTrailer` now surfaces every off-route unload hub as its own stop carrying its summed block volume, so ALL assigned-block volume counts toward `totalDemand`. Off-route hubs aren't in the travel model (`travelMin → 0`) → capacity demand without spurious travel cost; sorted by hubId (anti-P3). TDD: `epoch.test.ts` "CAPACITY (FIX 1)" — 24 vol > 20 cap ⇒ `feasible:false`, `accepted:null`. |
| 2 | LOW | `minCostFlow` accepted duplicate-nodeId supplies, silently wiring parallel super-arcs (and a mixed-sign duplicate short-circuited source↔sink), violating the one-supply/one-arc-per-node contract. | **FIXED** `34d8922` | `min-cost-flow.ts ResidualGraph` ctor coalesces supplies by nodeId into a single net amount (Map preserves first-seen order → determinism), then wires exactly ONE arc per node. Added a cheap dev guard: throws if net `Σ amount !== 0` (conservation contract). TDD: `min-cost-flow.test.ts` two FIX-2 cases (same-sign + mixed-sign duplicates ⇒ identical result to one coalesced entry). |
| 3 | LOW | Stale constant name `PHASE1_SCHEMA_VERSION` now also versions Phase-4 plan events (`PlanGenerated`/`PlanAccepted`). | **FIXED** `8641e7e` | Pure rename → `EVENT_SCHEMA_VERSION` across declaration (`events/schemas.ts`) + both re-exports (`events/index.ts`, `src/index.ts`); value unchanged (1); single source of truth preserved. No old-name references remain in `src`/`test`. |
| 4 | LOW (assess-then-fix) | `validatePlan` LIFO over-counts phantom blockers for hub-revisiting routes. | **FIXED** `b728c3d` | **Confirmed REAL and HARD-impacting:** route `0→10→20→30→0` (genuine revisit) was flagged `feasible:false` from 3 phantom blockers (> `maxAllowedBlockers` = 2) on a physically LIFO-correct load. Root cause: `buildLoadForGate` reused the bare hubId per stop, so `buildUnloadOrderMap` collapsed both `0` visits to one unload order, mis-ranking the nose block (unloaded LAST) as unloading first. **Fix is small + safe and lives ENTIRELY in the optimizer's gate-input builder** (`route-trailers.ts buildLoadForGate`): each stop occurrence gets a unique synthetic gate hub `"<hubId>#<k>"`, so distinct unload events rank as distinct orders (`unloadOrder == depth == k`). Non-revisiting routes unchanged (every hub already unique). The independent validator (`validator.ts`/`unload-order.ts`/`lifo-invariant.ts`) is **untouched** — its correctness is preserved (load-planner suite stays 99/99 green). TDD: `route-trailers.test.ts` "FIX 4". |
| 5 | LOW | `(epoch, scopeHash)` idempotency is in-memory only (no DB durability across restart). | **CARRIED-LOW-DEBT** | Folds into Phase 5. Per-process idempotency holds for the demo; durable cross-restart idempotency (e.g. a Postgres-backed processed-epoch ledger) is deferred. Not a correctness bug within a single run. |
| 6 | LOW | Scope completeness: package events scope the affected hub but not the trailers loaded there. | **CARRIED-LOW-DEBT** | Folds into Phase 5. Conservative under-scoping can miss re-optimizing a trailer whose freight changed via a package event; acceptable for the MVP demo where trailer/departure events drive the visible re-optimization. Documented for Phase-5 scope-detection hardening. |
| 7 | LOW | Frozen trailers surfaced with `feasible:false` (misrepresentation). | **CARRIED-LOW-DEBT** | Folds into Phase 5. A frozen (near-departure) trailer is left untouched and recorded with `frozen:true` + `feasible:false`/`objectiveCost:0`; the `frozen` flag is the authoritative signal and `accepted` is correctly null. The `feasible:false` is cosmetically misleading but never drives selection (frozen recs are excluded from `selectPlan`). Surfacing a distinct "not evaluated" state is a Phase-5 presentation refinement. |
| — | LOW | OPT-02/05/06/07 "live-wiring" completeness: `minCostFlow`/`assignFreight` exist but aren't wired into the live rolling-epoch path; glpk oracle self-loop coverage gap; no live periodic/event-triggered rolling loop + repair-surfacing endpoint. | **DEFERRED-P5** | The optimizer libraries exist and are unit/fuzz-verified; the live periodic/event-triggered rolling loop and the repair-surfacing endpoint are Phase-5 scope (Phase 5's SIM-04 "visible re-optimization" depends on them). Documented, not built, per the fix brief. |

## Verification
- `pnpm build` → **9/9 tasks successful**.
- `pnpm test:all` → **58 files / 447 tests pass** (incl. event-store / api / projections integration tests on ephemeral `postgres:17`).
- TDD per fix: failing test written + observed failing first, then made to pass (Fixes 1, 4 demonstrably red→green; Fix 2 tests assert coalescing correctness; Fix 3 is a build-verified pure rename).
- Independent LIFO validator not weakened by Fix 4 (load-planner 99/99 green).

## Commits (on `feature/phase-4-rolling-optimizer`)
- `82ba1f3` fix(04): count off-route block volume toward trailer capacity demand
- `34d8922` fix(04): coalesce duplicate-nodeId supplies in minCostFlow
- `8641e7e` fix(04): rename PHASE1_SCHEMA_VERSION -> EVENT_SCHEMA_VERSION
- `b728c3d` fix(04): give each gate stop a unique hub so revisiting routes don't phantom-block

(`04-REVIEW.md` is intentionally left **untracked** for the orchestrator; not committed. DO NOT merge to develop — the orchestrator handles the develop merge + conflict resolution.)
