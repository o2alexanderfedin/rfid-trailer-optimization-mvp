# Phase 21: Bidirectional Freight / Consolidation - Context

**Gathered:** 2026-06-24
**Status:** Ready for planning (pending one design decision — see Open Decisions)
**Mode:** Autonomous smart-discuss (research-locked decisions + Google AI Mode consult)

<domain>
## Phase Boundary

Spoke→center **consolidation** trailers carry real freight, the center **re-sorts** it for onward routing, and the optimizer handles **both flow directions without double-counting**. This is the **highest-integration phase** (engine manifest model, optimizer scope+twin, projections, map viz all change). Builds on Phase 19 (reverse routes registered at bootstrap; resumable continuation) + Phase 20 (induction can originate spoke freight).

**In scope:** FLOW-01, FLOW-02, FLOW-03, FLOW-04, VIZ-12, FLOW-05 (P2).

**NOT in scope:** outbound delivery / `PackageDelivered` (Phase 22). Spoke→spoke is via the center (Decision 2), not direct routes.
</domain>

<decisions>
## Implementation Decisions

### Resolved (research-locked)
- **`pendingAtSpoke` two-queue model** — add `pendingAtSpoke: Map<spokeHubId, string[]>` alongside the existing `pendingBySpoke` (center→spoke). Spoke→center consolidation trailers drain `pendingAtSpoke`; distribution trailers drain `pendingBySpoke`. **Empty `pendingAtSpoke` is VALID** (a return leg with no consolidation freight departs/returns without error).
- **Spoke→spoke via center** (Decision 2) — cross-spoke freight routes Spoke A → Center → Spoke B; existing star topology + time-expanded graph. The center **inbound unload + re-sort** handles spoke→center arrivals.
- **Optimizer reads demand via the existing `hub_inventory` projection** (Decision 3) — both directions surface as inbound/staged inventory; no new twin demand concept.
- Reverse routes already registered at bootstrap (Phase 19) — no new ORS call.

### Determinism keystone (Phase-19 interaction — CRITICAL)
- **`pendingAtSpoke` MUST be captured in `SimContinuation.world`** exactly like `pendingBySpoke` (engine.ts:968/1724) so a chunked/continuous run is byte-identical. Add a continuation-equivalence case with `consolidationEnabled:true` crossing a chunk boundary mid-consolidation.
- **Opt-in:** `consolidationEnabled: false` (default) ⇒ ZERO new behavior ⇒ seed-1234 + seed-42 (`3920accc…`) goldens byte-identical. Empty returns must not appear when off.
- Deterministic same-tick tie-break preserved; consolidation scheduling via the `EventQueue` (no external append).
- **No new RNG draws** if consolidation reuses existing freight (spoke-origin freight comes from Phase-20 induction or center distribution) — confirm in plan-phase; if any new randomness, it needs a salted substream carried in the continuation.

### Optimizer (FLOW-04)
- `detectAffectedScope`/`hubsOf` + `buildTravelModel` handle spoke→center legs (both directions).
- `isFrozen` freeze-window semantics validated for spoke→center return trailers.
- **Persistent idempotency:** add an `optimizer_idempotency` Postgres table so `(epoch, scopeHash)` survives restarts (closes the v1.0 in-memory-idempotency debt under continuous operation).
- **No double-counting at consolidation:** stale `staged` plan entries cleared on supersession — see Open Decisions for the mechanism.
- **Detection `is_active` scoping:** scope `runDetection` to active packages so its cost doesn't scale with total-ever (the detection-cost-scales-with-state debt), benchmarked at a bounded state size.

### Claude's discretion
- Consolidation cadence / which spokes consolidate / freight selection — deterministic; tuned for a watchable demo without starving distribution.
- VIZ-12 direction styling (consolidation vs distribution trailer color/arrow).
</decisions>

<code_context>
## Existing Code Insights (verify in plan-phase)
- `packages/simulation/src/engine.ts` — `pendingBySpoke` Map (line 966) drained at trailer departure (1283); captured in `SimContinuation.world.pendingBySpoke` (968, 1724). `pendingAtSpoke` mirrors this. Center distribution + spoke arrival handlers are the integration points.
- `packages/projections/src/reducers/hub-inventory.ts` — `inbound`/`outbound`/`staged` buckets; `staged` is the optimizer-plan-staged freight (supersession target).
- `packages/optimizer/src/rolling/` — `scope.ts` (`detectAffectedScope`/`hubsOf`/`trailersOf`), `types.ts` (`TwinRoute`/`TwinSnapshot`), `freeze-idempotency.ts` (`scopeHash`/`isFrozen`), the rolling service (in-memory idempotency `LruMap` from Phase 19 → make Postgres-durable here). `PlanAccepted` reducer is the supersession site.
- `packages/projections/src/detector.ts` — `runDetection` (no active filter today → `is_active` scoping here).
- Gate: `pnpm build` + `pnpm typecheck` + `pnpm lint` + `pnpm test:all`. **Gate-hygiene:** bound any new continuation/Postgres-heavy test scale.
</code_context>

<specifics>
## Specific Ideas
- `consolidationEnabled?: boolean` on `SimulateOptions` (off by default), gating consolidation departures + `pendingAtSpoke` population.
- Double-drain guard: drain `pendingAtSpoke[spoke]` atomically per departure (splice the manifest) so two trailers can't take the same packages.
- VIZ-12: `direction: 'outbound' | 'consolidation'` on the ws trailer tick; distinct map styling; non-empty manifests on consolidation trailers.
- FLOW-05 (P2): per-hub inbound/outbound balance display (cross-dock heat).
</specifics>

<deferred>
## Deferred Ideas
- Outbound delivery / `PackageDelivered` (Phase 22).
- Returns/reverse-logistics as a third flow direction (FLOW-FUT-01).
</deferred>

<open_decisions>
## Resolved Decisions
**D-21-1 — Supersession mechanism → RESOLVED: explicit `PlanSuperseded` event** (Google AI Mode consult, 2026-06-24).
Rationale: in a single-process, single-partition Postgres log, in-order delivery is free — which removes the supersession-aware reducer's only real advantage (lean stream). The explicit event gives **absolute determinism** (state depends only on stream facts), a clean **audit trail** ("freight unstaged because plan X superseded"), and trivial **replay-from-zero** — exactly the byte-identical-golden properties we protect. The reducer route would push epoch/scope comparison + destructive eviction into the projector (low auditability, "masks data bugs").
**Shape:** the optimizer emits `PlanSuperseded(priorPlanId/epoch+scope, reason)` in the SAME commit as the new `PlanAccepted`; the staged-projection reducer stays a dumb pure **delete-then-apply**. The superseding event MUST carry **holistic scope state** (or the reducer wipes all `staged` for that scope where `state.epoch < event.epoch`) so items present in the OLD plan but absent in the NEW are wiped, not stranded.
</open_decisions>

<google_consult>
## Google AI Mode Consultation (2026-06-24, udm=50, reached)

Decided D-21-1 (above: explicit `PlanSuperseded`). **Net-new items folded into gates:**
1. **Double-drain prevention (the determinism risk in the two-queue model):** enforce a **deterministic sort key** on `pendingAtSpoke` — `[priority]+[timestamp/tick]+[unique freight id]` — and drain via an **atomic peek+pop** (splice the manifest in one step) so two consolidation trailers at a spoke can't take the same packages. Sort idle trailers by `trailerId` before draining; evaluate one-by-one.
2. **Empty-return guard:** allow an empty return leg only past a deterministic threshold (e.g. node inventory below a downstream-demand horizon, or a spoke risks zero-trailer starvation) — don't silently emit empty returns.
3. **Slot-race guard:** an empty-return and a freight-leg must not race the SAME destination (center) slot in one tick — decrement any reservation/credit counter atomically in the same event step (or, simplest for the demo, ensure consolidation departures and distribution arrivals at the center are ordered deterministically and don't double-book).
4. **Durable idempotency hardening:** `optimizer_idempotency` table = `UNIQUE(horizon_start, horizon_end, scope_hash)` + `INSERT ... ON CONFLICT ... RETURNING` to atomically claim an epoch; add a **`status` column (PROCESSING/COMPLETED/FAILED)** for crash-mid-epoch recovery; the **scopeHash MUST use explicit `ORDER BY`** over BOTH directions' inputs (never `SELECT *`/physical order) — the new inbound/consolidation rows must be IN the hash or a frozen window silently shifts the scopeHash.
5. Freeze-window boundaries must align exactly across the added direction (a misaligned boundary silently changes the scopeHash).
</google_consult>
