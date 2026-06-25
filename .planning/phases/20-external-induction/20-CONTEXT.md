# Phase 20: External Induction - Context

**Gathered:** 2026-06-24
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (research-locked decisions + Google AI Mode consult)

<domain>
## Phase Boundary

Freight enters the network **from outside at spoke hubs** via a new `PackageInducted` domain event, shapes optimizer priority via an SLA deadline, and **animates on the live map**. Builds directly on the Phase-19 resumable continuation engine + bounded retention.

**In scope (requirements):** IND-01, IND-02, IND-03, VIZ-13.

**NOT in scope:** spoke→center consolidation freight flow (Phase 21 — FLOW), outbound delivery (Phase 22 — OUT). This phase only makes freight ENTER at spokes; existing center→spoke distribution and the package lifecycle (terminal at `PackageArrivedAtHub`) are otherwise unchanged.
</domain>

<decisions>
## Implementation Decisions

### Resolved (research-locked, confirmed 2026-06-24)
- **`PackageInducted` is a NEW event that COEXISTS with `PackageCreated`** (Decision 1). `PackageCreated` = internal center-origin spawn (unchanged); `PackageInducted` = first network-visible entry of externally-originated freight. Existing goldens untouched.
- **Optimizer picks up inducted freight AUTOMATICALLY via the existing `hub_inventory` projection** (Decision 3) — `PackageInducted` populates `hubInventory[inductionHubId].inbound` via the same reducer path `PackageArrivedAtHub` uses. No new optimizer demand-source concept.
- **Spoke→spoke routing is via the center** (Decision 2) — not relevant until Phase 21, but induction destinations may be any hub; multi-hop routes via center.

### Determinism keystone (Phase-19 interaction — CRITICAL)
- **The induction RNG substream state MUST be carried in `SimContinuation`.** Phase 19 made the engine resumable; the new `INDUCTION_RNG_SALT` substream's PRNG state must be captured/restored in the continuation DTO so a chunked/continuous run is **byte-identical** to all-at-once with `inductionEnabled: true`. Add an induction case to the continuation-equivalence property test (incl. a chunk-boundary case).
- New induction scheduling is a **self-rescheduling `EventQueue` task** (like `createPackageBatch` at engine.ts:904) — never an external append (preserves single-threaded deterministic order).
- `INDUCTION_RNG_SALT` must be asserted **pairwise-distinct** from ALL existing salts in the salt-collision test.
- **Opt-in:** `inductionEnabled: false` (default) → ZERO `PackageInducted` events → existing seed-1234 + seed-42 goldens byte-identical.

### Claude's discretion (implementation-level)
- Induction arrival process shape (per-spoke rate / batch size / schedule) — deterministic, seeded from `inductionRng`; tuned so the demo is visually interesting without overwhelming trailer capacity (defer exact tuning to scenario config).
- `slaDeadlineIso` derivation: `occurredAt + SLA-class offset` (reuse existing `SlaClass`/`DeadlineBucket` from `@mm/domain`); deterministic.
- Whether to add a dedicated `packageLifecycleReducer` (research suggested) vs extend existing reducers — pick the simplest consistent with existing projection patterns.
- `externalOriginRef` deterministic id format (e.g. `EXT-P000NN`).
</decisions>

<code_context>
## Existing Code Insights (verify during plan-phase)
- `packages/simulation/src/engine.ts` — `createPackageBatch` (center spawn, line ~904) scheduled via `EventQueue` (`schedule(0, {kind:"createPackageBatch"})`, self-reschedules). Induction mirrors this at spokes. NEW: the `SimContinuation` (`continuation.ts`, Phase 19) + `dispatch()` `SimTask` union must gain the induction task + the induction RNG substream state. RNG state via `getState()`/`makeRngFromState()` (rng.ts).
- `packages/domain/src/events/` — closed `DomainEvent` union + `eventSchema` factory (`.strict()`), `contract.assert.ts` build gate, `assertNever` exhaustiveness. `PackageInducted` schema + union member added here. `SlaClass`/`DeadlineBucket`/`PlanningPackage` types reusable.
- `packages/projections/src/reducers/` — every reducer's `switch(event.type)` must handle `PackageInducted` (build fails otherwise). `hub-inventory.ts` inbound bucket = the optimizer demand path.
- `packages/optimizer/src/rolling/scope.ts` — `detectAffectedScope`/`hubsOf` must classify `PackageInducted` → `[inductionHubId, destHubId]`. `types.ts` `TwinBlock` gains optional `deadlineMin?` (additive).
- `packages/api/src/ws/` — new ws message for induction; `packages/web/src/map/` — `inductionLayer` pulsing-circle on `PackageInducted`.
- Gate: `pnpm build` + `pnpm typecheck` + `pnpm lint` + `pnpm test:all`. Determinism goldens in simulation/projections. **Bound any new heavy determinism test** (gate-hygiene lesson).
</code_context>

<specifics>
## Specific Ideas
- Add `inductionEnabled?: boolean` to `SimulateOptions` (off by default), gating the induction substream construction + scheduling (mirror how `hosEnabled`/`fuel` are gated).
- `validate()` round-trip test for `PackageInducted`.
- VIZ-13: pulsing marker at the induction hub on the `PackageInducted` ws message; follow VIZ-05/06 OL layer conventions.
- Continuation-equivalence: add `inductionEnabled` to the feature-flag combos (chunk-boundary byte-identity), keeping the matrix bounded (gate-hygiene).
</specifics>

<deferred>
## Deferred Ideas
- Spoke→center consolidation freight (Phase 21 / FLOW).
- Outbound delivery / `PackageDelivered` (Phase 22 / OUT).
- Mixed-direction same-hub local short-circuit (IND-FUT-01, future).
</deferred>

<google_consult>
## Google AI Mode Consultation (2026-06-24, udm=50, reached)

Endorsed the plan (self-rescheduling EventQueue tasks, salted substream in `SimContinuation`, closed-union + `assertNever`, `detectAffectedScope → [inductionHubId, destHubId]`). **Net-new folded into gates:**
1. **Continuation must capture the pending induction task itself**, not just the PRNG state — i.e. the next-induction `EventQueue` task (its absolute `fireTick`) must be in `SimContinuation` so a resume mid-gap doesn't lose/reorder it. (Our queue tasks are already captured; add an equivalence test where a chunk boundary lands *between* induction arrivals.)
2. **Self-rescheduling pattern**: each induction draws from `inductionRng` to schedule the NEXT induction in the same event block — don't pre-schedule far ahead. Schedule at **absolute** `occurredAt`/tick (we're integer-tick, so float drift is a non-issue; still serialize state deterministically — recall the HOS key-order lesson).
3. **Deterministic tie-break** when an induction lands on the same tick as another event — reuse the EventQueue's existing `(tick, sequenceId)` secondary key (verified Phase 19); the induction task must not rely on map/insertion order.
4. **Salt must hash-split, not `seed+1`** — `INDUCTION_RNG_SALT` is a large well-separated constant (like the existing salts), so no low-offset correlation; keep the pairwise-distinct assertion.
5. **Deadline should factor a service-time estimate, not a flat class offset** (so the optimizer's slack/critical-ratio prioritization is meaningful): derive `slaDeadlineIso = occurredAt + expectedTravel(inductionHub→destHub) + SLA-class buffer`, reusing the shared `expectedMinutes` estimator (`@mm/domain`). Lock the deadline at induction; never regenerate. (Falls back to a flat class offset only if the travel estimate isn't readily available at induction time — decide in plan-phase.)
</google_consult>
