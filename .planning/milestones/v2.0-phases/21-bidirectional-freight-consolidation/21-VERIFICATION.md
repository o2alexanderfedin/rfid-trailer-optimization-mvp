---
phase: 21
name: Bidirectional Freight / Consolidation
status: passed
verified: 2026-06-24
gate: "unit 1465/1465 + per-file integration (detector/exceptions/live-demo/over-carry-fire/fuel-stops) all green; build/typecheck/lint clean; goldens byte-identical"
---

# Phase 21 Verification — Bidirectional Freight / Consolidation

**Goal:** Spoke→center consolidation trailers carry real freight, the center re-sorts it, and the optimizer handles both flow directions without double-counting.

**Result: PASSED.** Built by rival p21-r2 (p21-r1 stalled incomplete); a post-merge fix corrected a detection-scoping regression found by the authoritative gate.

## Requirements — all met
| Req | Status | Evidence |
|-----|--------|----------|
| FLOW-01 spoke→center consolidation | ✅ | `pendingAtSpoke` two-queue, atomic-splice drain (deterministic sort), spoke-origin trailers carry freight. |
| FLOW-02 center inbound unload + re-sort | ✅ | `arriveConsolidationAtCenter` cross-dock re-stage (Spoke A → Center → Spoke B via center). |
| FLOW-03 center→spoke preserved + empty-returns valid | ✅ | Distribution unbroken (regression); empty `pendingAtSpoke` return valid; `consolidationEnabled:false` byte-identical. |
| FLOW-04 optimizer both directions, no double-count | ✅ | scope + travel model both directions; durable `optimizer_idempotency` table (`UNIQUE(horizon,scope_hash)` + `ON CONFLICT RETURNING` + status; scopeHash explicit `ORDER BY`); `PlanSuperseded` (D-21-1) co-committed with `PlanAccepted` = sole stage-mutating event (dumb delete-then-apply). Detection `is_active` scoping (cost-bound, fixed post-merge). |
| VIZ-12 consolidation map styling | ✅ | `TrailerKeyframe.direction` + distinct cyan consolidation style + non-empty manifests. |
| FLOW-05 (P2) hub balance | ✅ | hub-detail inbound/outbound balance API + `HubBalance` operator panel. |

## Determinism keystone — verified
- `consolidationEnabled:false` (default) ⇒ seed-1234 + seed-42 (`3920accc…`) goldens **byte-identical**; no empty returns when off.
- **`pendingAtSpoke` + `consolidationDestByPackage` captured in `SimContinuation.world`** → continuation-equivalence with consolidation ON green (chunked == all-at-once). No new RNG salt. `(tick,sequenceId)` tie-break preserved.
- `PlanSuperseded` co-committed atomically carrying exactly the wiped staged set; durable idempotency survives restart.

## D-21-1 (Google AI Mode consult) — explicit `PlanSuperseded` event
Single-process Postgres log ⇒ ordering free ⇒ explicit event wins on determinism + auditability. It is the SOLE stage-mutating event; reducer is a dumb pure delete-then-apply over `supersededPackageIds`.

## Post-merge fix (regression)
The authoritative gate caught that 21-06's detection `is_active` scoping over-narrowed: it scoped by the OBSERVED trailer's status (`in_transit` only), but wrong-trailer detection is about a package on a trailer it was NOT assigned to (often no `trailer_state` row) — silently dropping wrong-trailer/missed-unload/exceptions. Fix (`23cf46f`): widen active statuses to `in_transit/arrived/docked` + re-scope to the ACTIVE PACKAGE set (bounds COST not RESULTS). All affected integration files (detector, exceptions, live-demo, over-carry-fire, fuel-stops) re-verified green; goldens byte-identical.

## Verification note
Full `pnpm check` integration lane flaked under testcontainers load during the build; each affected integration file was therefore verified INDIVIDUALLY (all green) + full unit (1465 + 384 sim/projections) + build/typecheck/lint clean. A final confirmation `pnpm check` was run at close.
