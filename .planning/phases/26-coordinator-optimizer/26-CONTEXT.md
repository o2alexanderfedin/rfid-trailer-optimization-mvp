# Phase 26: Coordinator ↔ Optimizer - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Refine the Phase-25 rule-based coordinator: a coordinator may invoke the proven v1 optimizer as a
**per-center scoped, PURE suggestion engine** — build a small per-center twin from in-engine fold state
and call `@mm/optimizer` `runEpoch` **synchronously in-fold** (never the async worker path) — translating
the result into route-aware `ActionSuggested` events, without breaking byte-identical replay. Also closes
the Phase-23 carry-over by giving `partitionScopeByCenter` (NET-05) its first live consumer.

In scope: COORD-06. Behind sub-flag `coordinatorUsesOptimizer` (sub-flag of `coordinatorsEnabled`).

Out of scope: perf/plumbing/scale-viz incl. the reject-with-reason continental scenario tuning (P27);
consolidated determinism audit (P28).
</domain>

<decisions>
## Implementation Decisions (accepted in discuss)

- **Optimizer role:** optimizer-backed generation REPLACES rule-based for the **REROUTE** kind (the
  route-aware decision the optimizer is good at); KEEP the Phase-25 rule-based generation for
  hold/consolidate/dispatch. So when `coordinatorUsesOptimizer` is on, reroute suggestions come from a
  scoped pure `runEpoch`; the other 3 kinds stay rule-based.
- **Wire `partitionScopeByCenter` (NET-05) HERE** — this phase is its first live consumer: each
  coordinator's per-center epoch scope is the partition slice for its center (scope ⊆ that center's
  affected hubs), reusing `detectAffectedScope` over a short bounded horizon. Closes the Phase-23/24/25
  carry-over (a single event's epoch scope must be independent of total network size).
- **In-fold pure call:** build a small per-center twin from the in-engine FOLD state (NOT a full
  event-log scan) and call the optimizer's **pure `runEpoch`** synchronously at a deterministic tick in
  sorted (centerId) order — the optimizer core is already pure/no-RNG ⇒ replay-safe. The async
  worker-thread path is REJECTED (its wall-clock re-entry breaks the golden).
- **Heuristic fallback:** keep the Phase-25 rule-based reroute generation as the fallback behind the
  sub-flag; cap the per-center `runEpoch` horizon; if profiling shows the in-fold call is too heavy, fall
  back to rule-based (a deterministic, documented threshold — not wall-clock).
- **Global `RollingLoop` disabled under the coordinator flag** so the global optimizer and the per-center
  coordinators never double-plan (this is the decentralization the milestone exists for).
- **Determinism:** sub-flag `coordinatorUsesOptimizer` OFF by default. Two-part gate: `false===absent`
  AND with it absent, replay is byte-identical to the **Phase-25 coordinator model** (`edfa5a6d…`), and
  the flags-off/OODA-on goldens (`3920accc…`/`94689f99…`) stay intact. Capture a NEW optimizer-backed
  coordinator golden reproducibility-first. Pure inputs, sorted order, canonicalize, no Date.now/Math.random.

### Claude's Discretion
- The per-center twin builder shape (mirror the existing twin-snapshot assembler but scoped + from fold,
  not full-scan), the runEpoch horizon cap value, the fallback threshold, and the reroute-result→
  `ActionSuggested` translation — at Claude's discretion following the existing optimizer-recommendation
  + Phase-25 generation patterns.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/optimizer/src/rolling/` — `runEpoch` (pure, deterministic, no-RNG — the suggestion engine);
  `scope.ts` `detectAffectedScope` (the scope to bound per center); `freeze-idempotency.ts` (OPT-06 primitives).
- `packages/simulation/src/network/centers.ts` — `partitionScopeByCenter` (NET-05, built P23, UNWIRED — wire here).
- `packages/simulation/src/coordinator/*` (P25) — `stepCoordinators` generation (add the optimizer-backed reroute branch), the rule-based generation to keep as fallback, `deriveCoordinatorRng`, the guards.
- `packages/api/src/optimizer/twin-snapshot.ts` — the existing twin assembler to mirror for the scoped per-center twin (build from fold state, not full-scan).
- The global `RollingLoop` / rolling-service / live-loop — disable under the coordinator flag.
- `packages/simulation/test/determinism.unit.test.ts` — goldens + two-part gate + continuation.

### Established Patterns
- Pure `runEpoch` called over a scoped twin; flag-gated + two-part flags-off golden; sorted deterministic
  iteration; canonical hashed payloads; lazy construction (only when sub-flag on).

### Integration Points
- `stepCoordinators` optimizer-backed reroute branch; per-center twin builder; `partitionScopeByCenter`
  wired into the per-center epoch scope; `runEpoch` result → `ActionSuggested(kind:reroute)`; global
  RollingLoop disabled under the flag; new golden + continuation; (twin/optimizer-aware viz is P27).
</code_context>

<specifics>
## Specific Ideas
- This phase preserves the hardest-won v1 IP (the SSP min-cost-flow + VRPTW optimizer) by reframing it as
  a per-center scoped suggestion engine — the "coordinators may use the optimizer" intent the user stated.
- Wiring `partitionScopeByCenter` here is the long-deferred NET-05 carry-over — its scope-size-invariant
  test (proven at 500 hubs in P23) now governs a live per-center epoch.
</specifics>

<deferred>
## Deferred Ideas
- Continental reject-with-reason scenario tuning (so the headline HOS/fuel reject fires live) — Phase 27.
- Perf/plumbing (twin-snapshot cursor-fold, async-queue) + scale viz — Phase 27.
- Consolidated determinism/golden audit — Phase 28.
</deferred>
